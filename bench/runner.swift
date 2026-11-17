// 基准执行器：读 jobs.jsonl（每行一次调用），对端侧模型跑 A / B / C 三种义项选择方案，逐行输出结果 JSON。
// 与 native/dictsummary.swift 一起编译（run.py 会去掉它的 @main），复用其中的候选切分、落地校验与 C 方案提示词，
// 保证测的就是插件里的代码。A、B 两种方案的提示词与解析按它们在插件里存在时的版本原样复现。
//
// 用法：runner <jobs.jsonl> <results.jsonl>

import Foundation
import FoundationModels
import NaturalLanguage

struct Job: Codable {
    var job: String
    var caseId: String
    var method: String
    var rep: Int
    var word: String
    var raw: String
    var title: String
    var abstract: String
    var journal: String
    var year: String
    var authors: String
    var history: [String]
}

struct Result: Codable {
    var job: String
    var caseId: String
    var method: String
    var rep: Int
    var ok: Bool
    var error: String?
    var latencyMs: Int
    var promptChars: Int
    var rawOutput: String
    var phrases: [String]        // 解析出的短语（落地校验前）
    var senses: [String]         // 最终显示的义项（落地校验后）
    var intercepted: Int         // 落地校验丢弃或替换的条数
    var fabricated: Int          // 与词典原文实词重合度 < 0.5 的短语数（校验前）
    var similarity: Double?      // 最终义项两两的句向量余弦相似度均值
}

func makeContext(_ j: Job) -> Context {
    var c = Context()
    c.title = clip(j.title, Budget.title)
    c.abstract = clip(j.abstract, Budget.abstract)
    c.journal = clip(j.journal, Budget.journal)
    c.year = String(j.year.prefix(4))
    c.authors = clip(j.authors, Budget.authors)
    c.history = Array(j.history.suffix(Budget.historyWords))
    return c
}

/* ---------------- A：候选法（插件第一版） ---------------- */

let aLabels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]

let aInstructions = """
You are a dictionary editor helping someone read an academic paper.
You get a word, facts about the paper, and candidate senses of the word from a dictionary, labelled with letters.
Pick the candidate senses that best fit how the word is most likely used in this paper, best fit first, at most three.
Output one line per pick, formatted exactly as: <letter>: <short phrase>
The short phrase restates that same candidate in at most ten words. No examples, no explanation, nothing else.
"""

func aPrompt(_ word: String, _ ctx: Context, _ cands: [String]) -> String {
    let list = cands.enumerated().map { "\(aLabels[$0.offset]). \($0.element)" }.joined(separator: "\n")
    return "Word: \(word)\n\(ctx.promptBlock)\nCandidate senses:\n\(list)"
}

// 第一版的解析：标签与内容不一致按内容落回候选，谁都对不上就丢弃
func aParse(_ text: String, _ cands: [String]) -> (phrases: [String], senses: [String], intercepted: Int) {
    let labels = Array(aLabels.prefix(cands.count))
    let candWords = cands.map(contentWords)
    var phrases: [String] = [], senses: [String] = []
    var used = Set<Int>(), intercepted = 0
    let regex = try! NSRegularExpression(pattern: "^\\s*(?:\\d{1,2}[.)]\\s*)?[*\\[(]*([A-L])[*\\])]*\\s*[:.)\\-]\\s*(.*)$")
    let normalized = text.replacingOccurrences(of: "[,;|]\\s+(?=[A-L]\\s*[:.)])", with: "\n", options: .regularExpression)
    for line in normalized.components(separatedBy: .newlines) {
        let ns = line as NSString
        guard let m = regex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { continue }
        guard let labeled = labels.firstIndex(of: ns.substring(with: m.range(at: 1))) else { continue }
        var phrase = ns.substring(with: m.range(at: 2))
            .trimmingCharacters(in: CharacterSet(charactersIn: " .;,*\"").union(.whitespaces))
        if phrase.count > Budget.senseChars { phrase = "" }
        phrases.append(phrase.isEmpty ? cands[labeled] : phrase)
        var index = labeled
        if !phrase.isEmpty {
            let scores = candWords.map { overlap(contentWords(phrase), $0) }
            let best = scores.indices.max { scores[$0] < scores[$1] }!
            if scores[best] < 0.34 { intercepted += 1; continue }
            if scores[labeled] < scores[best] - 0.2 { index = best; intercepted += 1 }
        } else {
            phrase = clip(cands[labeled], Budget.senseChars)
            intercepted += 1
        }
        if used.contains(index) { continue }
        used.insert(index)
        senses.append(phrase)
        if senses.count >= 3 { break }
    }
    return (phrases, senses, intercepted)
}

/* ---------------- B：原文两步（插件第二版） ---------------- */

let bInstructions = """
You are a dictionary editor helping someone read an academic paper.
You get a word, facts about the paper, and the word's full dictionary entry.
First, pick at most three senses from the entry, including the one that fits the paper if there is one, \
and shorten each to a phrase of four to ten words that keeps the entry's own key words. \
Never add a meaning taken from the paper. No examples, no etymology, no part-of-speech labels.
Then reorder those same senses so the one that best fits how the word is used in this paper comes first.
Output exactly two lines and nothing else. Example for the word "bank" in a paper about river erosion:
Senses: a financial institution holding deposits; the land alongside a river; a stock held in reserve
Ranked: the land alongside a river; a financial institution holding deposits; a stock held in reserve
"""

func bPrompt(_ word: String, _ ctx: Context, _ raw: String) -> String {
    "Word: \(word)\n\(ctx.promptBlock)\nDictionary entry: \(raw)"
}

func bParse(_ text: String) -> [String] {
    var condensed: [String] = [], ranked: [String] = [], loose: [String] = []
    for line in text.components(separatedBy: .newlines) {
        let clean = line.replacingOccurrences(of: "*", with: "").trimmingCharacters(in: .whitespaces)
        if clean.isEmpty { continue }
        if let r = clean.range(of: "^senses?\\s*:", options: [.regularExpression, .caseInsensitive]) {
            condensed = splitSenses(String(clean[r.upperBound...]))
        } else if let r = clean.range(of: "^ranked\\s*:", options: [.regularExpression, .caseInsensitive]) {
            ranked = splitSenses(String(clean[r.upperBound...]))
        } else if !clean.contains(":") || clean.range(of: "^\\d{1,2}[.)]", options: .regularExpression) != nil {
            loose.append(contentsOf: splitSenses(clean))
        }
    }
    if ranked.isEmpty { ranked = condensed }
    if ranked.isEmpty { ranked = loose }
    return ranked
}

/* ---------------- 执行 ---------------- */

func respond(_ instructions: String, _ prompt: String) async throws -> String {
    try await withTimeout(6) {
        let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
        let session = LanguageModelSession(model: model, instructions: instructions)
        return try await session.respond(to: prompt, options: GenerationOptions(samplingMode: .greedy)).content
    }
}

let embedding = NLEmbedding.sentenceEmbedding(for: .english)

func meanSimilarity(_ senses: [String]) -> Double? {
    guard let emb = embedding, senses.count >= 2 else { return nil }
    var total = 0.0, n = 0
    for i in 0..<senses.count {
        for k in (i + 1)..<senses.count {
            total += 1 - emb.distance(between: senses[i], and: senses[k], distanceType: .cosine)
            n += 1
        }
    }
    return n > 0 ? total / Double(n) : nil
}

func fabricatedCount(_ phrases: [String], raw: String) -> Int {
    let rawWords = contentWords(raw)
    return phrases.filter { overlap(contentWords($0), rawWords) < Grounding.minRawOverlap }.count
}

func run(_ j: Job) async -> Result {
    let ctx = makeContext(j)
    var instructions = "", prompt = ""
    var cands: [String] = []
    switch j.method {
    case "A":
        cands = extractCandidates(j.raw)
        instructions = aInstructions
        prompt = aPrompt(j.word, ctx, cands)
    case "B":
        instructions = bInstructions
        prompt = bPrompt(j.word, ctx, j.raw)
    default:
        instructions = rankInstructions(.en)
        prompt = rankPrompt(word: j.word, context: ctx, raw: j.raw)
    }
    var r = Result(job: j.job, caseId: j.caseId, method: j.method, rep: j.rep, ok: false, error: nil,
                   latencyMs: 0, promptChars: instructions.count + prompt.count, rawOutput: "",
                   phrases: [], senses: [], intercepted: 0, fabricated: 0, similarity: nil)
    let t0 = Date()
    do {
        let out = try await respond(instructions, prompt)
        r.latencyMs = Int(Date().timeIntervalSince(t0) * 1000)
        r.rawOutput = out
        switch j.method {
        case "A":
            let p = aParse(out, cands)
            r.phrases = p.phrases
            r.senses = p.senses
            r.intercepted = p.intercepted
        case "B":
            r.phrases = bParse(out)
            let g = ground(r.phrases, raw: j.raw, context: ctx)
            r.senses = g.senses
            r.intercepted = g.dropped.count
        default:
            r.phrases = parseSenses(out)
            let g = ground(r.phrases, raw: j.raw, context: ctx)
            r.senses = g.senses
            r.intercepted = g.dropped.count
        }
        r.ok = !r.phrases.isEmpty
        if !r.ok { r.error = "unparsable" }
        r.fabricated = fabricatedCount(r.phrases, raw: j.raw)
        r.similarity = meanSimilarity(r.senses)
    } catch is Timeout {
        r.latencyMs = Int(Date().timeIntervalSince(t0) * 1000)
        r.error = "timeout"
    } catch {
        r.latencyMs = Int(Date().timeIntervalSince(t0) * 1000)
        r.error = "\(error)"
    }
    return r
}

@main
struct Runner {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 3, let data = FileManager.default.contents(atPath: args[1]) else {
            print("用法：runner <jobs.jsonl> <results.jsonl>")
            exit(2)
        }
        guard case .available = SystemLanguageModel.default.availability else {
            print("Foundation Models 不可用：\(SystemLanguageModel.default.availability)")
            exit(3)
        }
        let decoder = JSONDecoder(), encoder = JSONEncoder()
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        FileManager.default.createFile(atPath: args[2], contents: nil)
        let out = FileHandle(forWritingAtPath: args[2])!
        for (i, line) in lines.enumerated() {
            guard let job = try? decoder.decode(Job.self, from: Data(line.utf8)) else { continue }
            let r = await run(job)
            out.write(try! encoder.encode(r))
            out.write("\n".data(using: .utf8)!)
            FileHandle.standardError.write("\r  \(i + 1)/\(lines.count) \(job.caseId) \(job.method) rep\(job.rep) \(r.latencyMs) ms   ".data(using: .utf8)!)
        }
        FileHandle.standardError.write("\n".data(using: .utf8)!)
    }
}
