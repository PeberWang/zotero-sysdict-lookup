// dictsummary — 用 macOS 端侧 Foundation Model 把词典原文压成两三条精简英文义项，
// 有语境时一次调用内同时按当前文献重排
//
// 用法:
//   dictsummary --word colossal [--raw "<词典原文>"]                 # 无语境：只压义项
//   dictsummary --word interest --raw "..." --title "..." \
//       [--abstract "..."] [--journal "..."] [--year 2021] [--authors "A; B"] \
//       [--history a,b --history c] [--timeout 6] [--print-prompt]   # 有语境：压义项 + 重排
//   任一模式都可加 --target-lang <语言>（en、zh-Hans、zh-Hant、ja、es…；默认 en；auto 按原文文字推断）
//   有语境时默认 --rank-method candidates（A 候选法）；--rank-method onestep 为整段原文一步生成（C）
//   兜底 A：dictsummary --word agua --convert-to en [--title …]     # 按语境把词换成目标语言的一个词
//   兜底 B：dictsummary --word … --raw … --target-lang es --transcribe [--title …]   # 释义转写成目标语言
//   校验不合格的重试：任一模式加 --feedback "<原因>" --previous "<上次输出>"（由插件发起，最多一次）
//   原文也可以从 stdin 传入。
//
// 输出 JSON:
//   {"available":true,"ranked":false,"summary":"a; b","senses":["a","b"]}
//   {"available":true,"ranked":true,"summary":"b; a","senses":["b","a"],"condensed":["a","b"],"reordered":true,...}
// 不可用 / 失败: {"available":false,"ranked":false,"reason":"..."}
//
// 全程端侧，不联网。

import Foundation
import FoundationModels

/* ---------------- 预算（字符数，写死） ---------------- */

enum Budget {
    static let raw = 2000          // 词典原文，沿用旧上限
    static let title = 200
    static let abstract = 600
    static let journal = 100
    static let authors = 80        // 前三位作者姓氏
    static let historyWords = 12   // 只取最近 12 个词
    static let historyWordChars = 30
    static let candidates = 12     // 兜底用的词典原义项条数（不进 prompt）
    static let candidateChars = 90
    static let senseChars = 80     // 模型返回的单条短语上限，超出按未通过校验处理
}

struct Output: Codable {
    var available: Bool
    var ranked: Bool
    var summary: String?
    var senses: [String]?
    var targetLang: String?
    var method: String?         // candidates（A，默认）| onestep（C）
    var picks: [Int]?           // A：选中的候选编号（1 起），按贴合度排序
    var candidates: [String]?   // A：交给模型的候选义项
    var transcribed: Bool?      // 兜底 B：释义由模型转写成了目标语言，未做落地校验
    var promptChars: Int?
    var dropped: [String]?      // 未通过落地校验的输出及其处理
    var fallback: String? = nil // "A"：按语境换词；B 由 transcribed 标明
    var converted: String? = nil
    var reason: String?
}

func emit(_ out: Output) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(out), let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"available\":false,\"ranked\":false,\"reason\":\"encode failed\"}")
    }
}

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func argValues(_ name: String) -> [String] {
    let args = CommandLine.arguments
    var values: [String] = []
    var i = 0
    while i < args.count {
        if args[i] == name, i + 1 < args.count {
            values.append(args[i + 1])
            i += 2
        } else {
            i += 1
        }
    }
    return values
}

func clip(_ text: String, _ limit: Int) -> String {
    let flat = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    if flat.count <= limit { return flat }
    return String(flat.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
}

/* ---------------- 候选义项：从词条原文确定性切分 ---------------- */

// 苹果词典原文形如 "word | ipa | noun 1 sense: example. • subsense: example. 2 ... verb ... PHRASES ... ORIGIN ..."
// 按编号与 • 切开，去掉例句与方括号标签，只保留释义本身
func extractCandidates(_ raw: String) -> [String] {
    var text = raw
    for marker in [" PHRASES ", " PHRASAL VERBS ", " DERIVATIVES ", " ORIGIN ", " USAGE "] {
        if let r = text.range(of: marker) { text = String(text[..<r.lowerBound]) }
    }
    // 去掉词头与音标段
    let bars = text.components(separatedBy: " | ")
    if bars.count >= 3 { text = bars.dropFirst(2).joined(separator: " | ") }

    let pieces = text.replacingOccurrences(
        of: "(?:^|\\s)(?:(?:noun|verb|adjective|adverb|preposition|conjunction|pronoun|exclamation)\\s+)?(?:\\d{1,2}\\s|•\\s)",
        with: "\u{1}", options: .regularExpression
    ).components(separatedBy: "\u{1}")

    var out: [String] = []
    for piece in pieces {
        var sense = piece
        if let r = sense.range(of: ": ") { sense = String(sense[..<r.lowerBound]) }
        if let r = sense.rangeOfCharacter(from: CharacterSet(charactersIn: "▸▶")) { sense = String(sense[..<r.lowerBound]) }
        sense = sense.replacingOccurrences(of: "\\[[^\\]]*\\]", with: "", options: .regularExpression)
        sense = sense.replacingOccurrences(of: "\\b(noun|verb|adjective|adverb)\\s*$", with: "", options: .regularExpression)
        sense = sense.trimmingCharacters(in: CharacterSet(charactersIn: " .;:|").union(.whitespaces))
        if sense.count < 8 || !sense.contains(" ") { continue }
        // "(also régime)" 这类变体拼写标注，去掉括号后不剩释义
        let bare = sense.replacingOccurrences(of: "\\([^)]*\\)", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        if bare.count < 8 { continue }
        out.append(clip(sense, Budget.candidateChars))
        if out.count >= Budget.candidates { break }
    }
    return out
}

/* ---------------- 语境 ---------------- */

struct Context {
    var title = ""
    var abstract = ""
    var journal = ""
    var year = ""
    var authors = ""
    var history: [String] = []

    var isEmpty: Bool { title.isEmpty && abstract.isEmpty && journal.isEmpty && history.isEmpty }

    static func fromArgs(excluding word: String) -> Context {
        var c = Context()
        c.title = clip(argValue("--title") ?? "", Budget.title)
        c.abstract = clip(argValue("--abstract") ?? "", Budget.abstract)
        c.journal = clip(argValue("--journal") ?? "", Budget.journal)
        c.year = String((argValue("--year") ?? "").prefix(4))
        c.authors = clip(argValue("--authors") ?? "", Budget.authors)
        // 历史按时间顺序，最近的在后；去重保留最后一次，去掉当前词
        var seen = Set<String>()
        var words: [String] = []
        let all = argValues("--history").flatMap { $0.split(separator: ",") }
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        for w in all.reversed() {
            let key = w.lowercased()
            if key == word.lowercased() || seen.contains(key) { continue }
            seen.insert(key)
            words.append(String(w.prefix(Budget.historyWordChars)))
            if words.count >= Budget.historyWords { break }
        }
        c.history = words.reversed()
        return c
    }

    var promptBlock: String {
        var lines: [String] = []
        if !title.isEmpty { lines.append("Paper title: \(title)") }
        if !journal.isEmpty { lines.append("Venue: \(journal)" + (year.isEmpty ? "" : " (\(year))")) }
        if !authors.isEmpty { lines.append("Authors: \(authors)") }
        if !abstract.isEmpty { lines.append("Abstract: \(abstract)") }
        if !history.isEmpty { lines.append("Words looked up earlier in this paper, oldest first: \(history.joined(separator: ", "))") }
        return lines.joined(separator: "\n")
    }
}

/* ---------------- 模型调用 ---------------- */

struct Timeout: Error {}

func withTimeout<T: Sendable>(_ seconds: Double, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await body() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw Timeout()
        }
        let first = try await group.next()!
        group.cancelAll()
        return first
    }
}

/* ---------------- 目标语言 ---------------- */

// 释义输出语言。en 的提示词与旧版逐字相同；中文用中文提示词；其他语言用英文提示词加语言要求
struct TargetLanguage: Equatable {
    let code: String

    static let en = TargetLanguage(code: "en")
    static let zhHans = TargetLanguage(code: "zh-Hans")
    static let zhHant = TargetLanguage(code: "zh-Hant")

    var rawValue: String { code }
    var isChinese: Bool { self == .zhHans || self == .zhHant }

    var englishName: String {
        switch code {
        case "en": return "English"
        case "zh-Hans": return "Simplified Chinese"
        case "zh-Hant": return "Traditional Chinese"
        default: return Locale(identifier: "en").localizedString(forLanguageCode: code) ?? code
        }
    }

    static let simpMarks = Set("们这说时为发对关见门问间车东书长学习语国过还进现实点开种动样经应该给让认识义线话总题机")
    static let tradMarks = Set("們這說時為發對關見門問間車東書長學習語國過還進現實點開種動樣經應該給讓認識義線話總題機")

    // --target-lang auto：按词条原文的文字推断
    static func infer(from raw: String) -> TargetLanguage {
        var han = 0, latin = 0, kana = 0, hangul = 0, simp = 0, trad = 0
        for ch in raw.unicodeScalars {
            switch ch.value {
            case 0x41...0x5A, 0x61...0x7A: latin += 1
            case 0x3040...0x30FF: kana += 1
            case 0xAC00...0xD7AF: hangul += 1
            case 0x3400...0x9FFF:
                han += 1
                let c = Character(ch)
                if simpMarks.contains(c) { simp += 1 }
                if tradMarks.contains(c) { trad += 1 }
            default: break
            }
        }
        let n = max(1, han + latin + kana + hangul)
        if Double(kana) / Double(n) >= 0.05 { return TargetLanguage(code: "ja") }
        if Double(hangul) / Double(n) >= 0.05 { return TargetLanguage(code: "ko") }
        if Double(han) / Double(n) >= 0.10 { return trad > simp * 2 ? .zhHant : .zhHans }
        return .en
    }

    static func from(arg: String?, raw: String) -> TargetLanguage {
        guard let arg = arg, !arg.isEmpty else { return .en }
        if arg == "auto" { return infer(from: raw) }
        let lower = arg.lowercased()
        if lower.hasPrefix("zh") {
            return lower.contains("hant") || lower.contains("tw") || lower.contains("hk") ? .zhHant : .zhHans
        }
        return TargetLanguage(code: String(lower.split(separator: "-").first ?? "en"))
    }

    var condenseInstructions: String {
        switch code {
        case "en":
            return """
            You are a dictionary editor. Given an English word and its dictionary entry, output its most useful senses for a reader.
            Rules:
            - At most three senses, separated by "; "
            - Each sense a short English phrase, no examples, no etymology, no part-of-speech labels, no phonetics, no numbering
            - Do not add any preamble, explanation, or line breaks
            - Each sense must fit on at most two short lines (80 characters at most)
            - Do not copy example sentences from the entry
            Example: extremely large; (of a statue) at least twice life size
            """
        case "zh-Hans":
            return """
            你是词典编辑。根据词条原文，给出这个词对读者最有用的义项。
            规则：
            - 最多三条，用"；"分隔
            - 每条是简短的简体中文短语，不要例句、词源、词性、音标、编号
            - 不要任何前言、解释或换行
            - 每条不超过两行（最多 40 个字）
            - 不要整句照抄词条里的例句
            示例：巨大的；（雕像）至少两倍真人大小的
            """
        case "zh-Hant":
            return """
            你是詞典編輯。根據詞條原文，給出這個詞對讀者最有用的義項。
            規則：
            - 最多三條，用「；」分隔
            - 每條是簡短的繁體中文短語，不要例句、詞源、詞性、注音、編號
            - 不要任何前言、解釋或換行
            - 每條不超過兩行（最多 40 個字）
            - 不要整句照抄詞條裡的例句
            示例：巨大的；（雕像）至少兩倍真人大小的
            """
        default:
            return """
            You are a dictionary editor. Given a word and its dictionary entry, output its most useful senses for a reader.
            Rules:
            - At most three senses, separated by "; "
            - Each sense a short phrase written in \(englishName), no examples, no etymology, no part-of-speech labels, no phonetics, no numbering
            - Do not add any preamble, explanation, or line breaks
            - Each sense must fit on at most two short lines (80 characters at most)
            - Do not copy example sentences from the entry
            """
        }
    }

    // 排序提示词里的示例。中文若沿用 bank，模型会把示例里的「金融机构」「河岸」抄进别的词，故换成与学术语境无关的 spring
    var rankExample: (word: String, topic: String, senses: String) {
        switch code {
        case "zh-Hans": return ("spring", "groundwater", "泉水；春季；弹簧")
        case "zh-Hant": return ("spring", "groundwater", "泉水；春季；彈簧")
        default: return ("bank", "river erosion",
                         "the land alongside a river; a financial institution holding deposits; a stock held in reserve")
        }
    }
}

// 校验不合格后的重试（插件侧最多重试一次）：把上次的输出与不合格原因附在 prompt 末尾，让模型知道错在哪
func withFeedback(_ prompt: String) -> String {
    guard let feedback = argValue("--feedback"), !feedback.isEmpty else { return prompt }
    let previous = argValue("--previous") ?? ""
    return prompt + "\n\nYour previous answer was rejected. " + feedback +
        (previous.isEmpty ? "" : "\nPrevious answer: " + clip(previous, 400)) +
        "\nAnswer again, following every rule."
}

func printPromptIfAsked(_ instructions: String, _ prompt: String) {
    guard CommandLine.arguments.contains("--print-prompt") else { return }
    FileHandle.standardError.write(("--- instructions ---\n\(instructions)\n--- prompt ---\n\(prompt)\n---\n").data(using: .utf8)!)
}

// 无语境：只压义项
func condense(word: String, raw: String, lang: TargetLanguage, timeout: Double) async -> Output {
    let instructions = lang.condenseInstructions
    let prompt = withFeedback("Word: \(word)\nDictionary entry: \(raw.isEmpty ? "(none)" : raw)")
    printPromptIfAsked(instructions, prompt)
    do {
        let content = try await withTimeout(timeout) {
            let session = LanguageModelSession(instructions: instructions)
            return try await session.respond(to: prompt).content
        }
        var summary = content.trimmingCharacters(in: .whitespacesAndNewlines)
        // 中文输出常把义项分行，统一成分号
        summary = lang == .en ? summary.replacingOccurrences(of: "\n", with: " ")
                              : splitSenses(summary).joined(separator: "；")
        let senses = splitSenses(summary)
        return Output(available: true, ranked: false, summary: lang == .en ? summary : senses.prefix(3).joined(separator: "；"),
                      senses: Array(senses.prefix(3)), targetLang: lang.rawValue,
                      promptChars: instructions.count + prompt.count)
    } catch is Timeout {
        return Output(available: false, ranked: false, targetLang: lang.rawValue, reason: "timeout")
    } catch {
        return Output(available: false, ranked: false, targetLang: lang.rawValue, reason: "\(error)")
    }
}

/* ---------------- 语境排序 A：候选法（默认） ----------------
 *
 * 词条原文先由代码切成带字母的候选义项，模型只在候选里挑与排。基准（bench/report.md，24 个构造案例）里
 * 首选命中 83%、解析失败 0%、最快，优于整段原文一步生成（C，62%、解析失败 17%、编造 23%），故为默认。
 *   英文目标：模型输出 "<字母>: <短语>"，短语按内容落回候选（插件第一版的做法，原样保留）
 *   中文目标：候选直接取中英词典的中文义项，每条带词典里的英文提示标签（"(money, wealth) 资本"）；
 *             模型只输出字母，显示的是词典原文的中文，不经模型生成。原因见 docs/context-rank.md「中文排序」
 *   其他目标：候选取该词典的释义片段，同样只输出字母、显示原文
 */

let candidateLabels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]

let candidateInstructions = """
You are a dictionary editor helping someone read an academic paper.
You get a word, facts about the paper, and candidate senses of the word from a dictionary, labelled with letters.
Pick the candidate senses that best fit how the word is most likely used in this paper, best fit first, at most three.
Output one line per pick, formatted exactly as: <letter>: <short phrase>
The short phrase restates that same candidate in at most ten words. No examples, no explanation, nothing else.
"""

let letterInstructions = """
You are a dictionary editor helping someone read an academic paper.
You get a word, facts about the paper, and candidate senses of the word from a dictionary, labelled with letters; \
each may have an English hint in brackets.
Pick the candidate senses that best fit how the word is most likely used in this paper, best fit first, at most three.
Output only the letters, one per line. Nothing else.
"""

// 中英词典的中文义项：按 ①② 切开，截到 ▸ 之前；保留括号里的英文提示，汉字部分去掉拼音与词性
func zhCandidates(_ raw: String) -> [(hint: String, zh: String)] {
    var out: [(String, String)] = []
    let markers = CharacterSet(charactersIn: "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳")
    for piece in raw.components(separatedBy: markers).dropFirst() {
        var head = piece.components(separatedBy: CharacterSet(charactersIn: "▸▶")).first ?? ""
        // 「B. transitive verb …」这类词性分段标记之后属于下一段
        if let r = head.range(of: "\\s[A-H]\\.\\s", options: .regularExpression) { head = String(head[..<r.lowerBound]) }
        let ns = head as NSString
        let hintRe = try! NSRegularExpression(pattern: "\\(([^)]*)\\)")
        let hints = hintRe.matches(in: head, range: NSRange(location: 0, length: ns.length))
            .map { ns.substring(with: $0.range(at: 1)) }
            .filter { !$0.unicodeScalars.contains { (0x3400...0x9FFF).contains($0.value) } }
        // 单语中文词典：截到第一个句号；去掉开头的词性字与〔〕标签
        var body = head.replacingOccurrences(of: "〔[^〕]*〕|［[^］]*］|（[^）]*）", with: "", options: .regularExpression)
        if let r = body.range(of: "。") { body = String(body[..<r.lowerBound]) }
        body = body.replacingOccurrences(of: "^\\s*[名动動形副量代连連介助叹嘆拟擬数數](?=[\\s\\p{Han}])", with: "", options: .regularExpression)
        let segments = body.components(separatedBy: CharacterSet(charactersIn: ";；"))
            .map { seg in String(seg.unicodeScalars.filter { (0x3400...0x9FFF).contains($0.value) || "、/…".unicodeScalars.contains($0) }.map(Character.init)) }
            .filter { !$0.isEmpty }
        if segments.isEmpty { continue }
        let zh = clip(segments.joined(separator: "，"), 30)
        if out.contains(where: { $0.1 == zh }) { continue }
        out.append((hints.joined(separator: "; "), zh))
        if out.count >= Budget.candidates { break }
    }
    return out
}

func candidatePrompt(word: String, context: Context, list: [String]) -> String {
    let lines = list.enumerated().map { "\(candidateLabels[$0.offset]). \($0.element)" }.joined(separator: "\n")
    return "Word: \(word)\n\(context.promptBlock)\nCandidate senses:\n\(lines)"
}

// 英文：解析 "<字母>: <短语>"。显示的是短语，所以以短语内容为准落回候选：标签与内容一致就用标签；
// 不一致时取重合度最高的候选；谁都对不上（模型自编）就丢弃。结果只可能是候选义项的子序列
func parsePicks(_ text: String, candidates: [String]) -> [(Int, String)] {
    let labels = Array(candidateLabels.prefix(candidates.count))
    let candWords = candidates.map(contentWords)
    var picks: [(Int, String)] = []
    var used = Set<Int>()
    let regex = try! NSRegularExpression(pattern: "^\\s*(?:\\d{1,2}[.)]\\s*)?[*\\[(]*([A-L])[*\\])]*\\s*[:.)\\-]\\s*(.*)$")
    let normalized = text.replacingOccurrences(of: "[,;|]\\s+(?=[A-L]\\s*[:.)])", with: "\n", options: .regularExpression)
    for line in normalized.components(separatedBy: .newlines) {
        let ns = line as NSString
        guard let m = regex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { continue }
        guard let labeled = labels.firstIndex(of: ns.substring(with: m.range(at: 1))) else { continue }
        var phrase = ns.substring(with: m.range(at: 2))
            .trimmingCharacters(in: CharacterSet(charactersIn: " .;,*\"").union(.whitespaces))
        if phrase.count > Budget.senseChars { phrase = "" }
        var index = labeled
        if !phrase.isEmpty {
            let scores = candWords.map { overlap(contentWords(phrase), $0) }
            let best = scores.indices.max { scores[$0] < scores[$1] }!
            if scores[best] < 0.34 { continue }                       // 自编义项
            if scores[labeled] < scores[best] - 0.2 { index = best }  // 标签错位
        } else {
            phrase = clip(candidates[labeled], Budget.senseChars)
        }
        if used.contains(index) { continue }
        used.insert(index)
        picks.append((index + 1, phrase))
        if picks.count >= 3 { break }
    }
    return picks
}

// 非英文：只认字母，按出现顺序去重
func parseLetters(_ text: String, count: Int) -> [Int] {
    var picks: [Int] = []
    let labels = Array(candidateLabels.prefix(count))
    let regex = try! NSRegularExpression(pattern: "(?<![A-Za-z])([A-L])(?![a-z])")
    let ns = text as NSString
    for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        guard let i = labels.firstIndex(of: ns.substring(with: m.range(at: 1))), !picks.contains(i + 1) else { continue }
        picks.append(i + 1)
        if picks.count >= 3 { break }
    }
    return picks
}

func rankByCandidates(word: String, raw: String, context: Context, lang: TargetLanguage,
                      timeout: Double, printPrompt: Bool) async -> Output? {
    let letters = lang != .en
    var shown: [String] = [], listed: [String] = []
    if lang.isChinese {
        let zh = zhCandidates(raw)
        shown = zh.map { $0.zh }
        listed = zh.map { ($0.hint.isEmpty ? "" : "(\($0.hint)) ") + $0.zh }
    } else {
        shown = extractCandidates(raw)
        listed = shown
    }
    guard shown.count >= 2 else { return nil }      // 无可排序，由调用方改走无语境精简

    let instructions = letters ? letterInstructions : candidateInstructions
    let prompt = withFeedback(candidatePrompt(word: word, context: context, list: listed))
    if printPrompt {
        FileHandle.standardError.write(("--- instructions ---\n\(instructions)\n--- prompt ---\n\(prompt)\n---\n").data(using: .utf8)!)
    }
    let chars = instructions.count + prompt.count
    do {
        let content = try await withTimeout(timeout) {
            let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
            let session = LanguageModelSession(model: model, instructions: instructions)
            return try await session.respond(to: prompt, options: GenerationOptions(samplingMode: .greedy)).content
        }
        if printPrompt {
            FileHandle.standardError.write(("--- model output ---\n\(content)\n---\n").data(using: .utf8)!)
        }
        var picks: [Int] = [], senses: [String] = []
        if letters {
            picks = parseLetters(content, count: shown.count)
            senses = picks.map { clip(shown[$0 - 1], Budget.senseChars) }
        } else {
            let parsed = parsePicks(content, candidates: shown)
            picks = parsed.map { $0.0 }
            senses = parsed.map { $0.1 }
        }
        guard !senses.isEmpty else {
            return Output(available: false, ranked: false, targetLang: lang.rawValue, method: "candidates",
                          candidates: shown, promptChars: chars, reason: "unparsable: \(clip(content, 120))")
        }
        return Output(available: true, ranked: true, summary: senses.joined(separator: lang.isChinese ? "；" : "; "),
                      senses: senses, targetLang: lang.rawValue, method: "candidates", picks: picks,
                      candidates: shown, promptChars: chars)
    } catch is Timeout {
        return Output(available: false, ranked: false, targetLang: lang.rawValue, method: "candidates",
                      candidates: shown, promptChars: chars, reason: "timeout")
    } catch {
        return Output(available: false, ranked: false, targetLang: lang.rawValue, method: "candidates",
                      candidates: shown, promptChars: chars, reason: "\(error)")
    }
}

/* ---------------- 语境排序 C：整段原文一步生成（可选，--rank-method onestep；兜底 B 的转写也走这里） ---------------- */

// 一次生成：从整段原文里挑出最贴合本文的三条，按贴合度排序，压成短语
// transcribe 为真时（兜底 B）：原文释义不是目标语言，要求转写成目标语言
func rankInstructions(_ lang: TargetLanguage, transcribe: Bool = false) -> String {
    let example = lang.rankExample
    var languageRule = ""
    if transcribe {
        languageRule = "The entry is not in \(lang.englishName); translate each sense into \(lang.englishName). "
    } else if lang != .en {
        languageRule = "Write every sense in \(lang.englishName), whatever the language of the paper. "
    }
    let keepWords = transcribe ? "" : " that keeps the entry's own key words"
    return """
    You are a dictionary editor helping someone read an academic paper.
    You get a word, facts about the paper, and the word's full dictionary entry.
    Pick at most three senses from the entry that best fit how the word is used in this paper, best fit first, \
    and shorten each to a phrase of four to ten words\(keepWords). \
    \(languageRule)Never add a meaning taken from the paper. No examples, no etymology, no part-of-speech labels.
    Output exactly one line and nothing else. Example for the word "\(example.word)" in a paper about \(example.topic):
    Senses: \(example.senses)
    """
}

// 语境放在原文之后、以问句收尾：端侧模型明显偏重 prompt 末尾，放在前面时首选只对 2/5，放在后面 4/5（实测）
func rankPrompt(word: String, context: Context, raw: String) -> String {
    let block = context.promptBlock
    return "Word: \(word)\nDictionary entry: \(raw)" + (block.isEmpty ? "" : "\n\(block)\nWhich senses does this paper need?")
}

let stopwords: Set<String> = ["the", "a", "an", "of", "or", "and", "to", "in", "for", "on", "by", "with", "at",
                              "as", "is", "be", "that", "which", "something", "someone", "especially", "one", "its",
                              "are", "from", "into", "not", "any", "such", "this", "being"]

let hanStopChars: Set<Character> = Set("的是或和与與及等之在了其为為以于於被把一个個种種某指")

func isHan(_ ch: Character) -> Bool {
    ch.unicodeScalars.allSatisfy { (0x3400...0x9FFF).contains($0.value) }
}

// 实词集合：拉丁字母按词（截前 5 个字母作粗略词干，money/monetary 不混，lent/lending 能对上），
// 汉字按字（去掉虚字）。中文没有分词器可用，按字比按词更稳，代价是同字异义也算重合
func contentWords(_ text: String) -> Set<String> {
    var out = Set<String>()
    for ch in text where isHan(ch) && !hanStopChars.contains(ch) { out.insert(String(ch)) }
    let latin = String(text.map { isHan($0) ? " " : $0 })
    for w in latin.lowercased().components(separatedBy: CharacterSet.letters.inverted)
        where w.count > 2 && !stopwords.contains(w) {
        out.insert(w.count > 5 ? String(w.prefix(5)) : w)
    }
    return out
}

// 短语实词里有多少出现在参照文本里
func overlap(_ phrase: Set<String>, _ reference: Set<String>) -> Double {
    phrase.isEmpty ? 0 : Double(phrase.intersection(reference).count) / Double(phrase.count)
}

// 落地校验阈值
enum Grounding {
    static let minRawOverlap = 0.5      // 短语实词至少一半出现在词条原文里
    static let maxLeaked = 1            // 只出现在语境、不在原文里的实词最多 1 个
    static let minCandidateOverlap = 0.34
}

struct Grounded {
    var senses: [String] = []
    var dropped: [String] = []          // "原短语 -> 处理"，便于排查
}

// 每条输出与原文比对：通过就保留；不通过时退回 extractCandidates 里最接近的词典原义项；
// 连原义项也对不上（模型自编）就丢弃。extractCandidates 只在这里兜底，不进 prompt、不限制生成
func ground(_ phrases: [String], raw: String, context: Context) -> Grounded {
    let rawWords = contentWords(raw)
    let leakWords = contentWords(context.promptBlock).subtracting(rawWords)
    var candidates: [String]? = nil
    var out = Grounded()
    var seen = Set<String>()

    for phrase in phrases {
        var sense = phrase
        let words = contentWords(phrase)
        let leaked = words.intersection(leakWords).count
        let score = overlap(words, rawWords)
        if words.isEmpty || score < Grounding.minRawOverlap || leaked > Grounding.maxLeaked || phrase.count > Budget.senseChars {
            if candidates == nil { candidates = extractCandidates(raw) }
            let scores = candidates!.map { overlap(words, contentWords($0)) }
            if let best = scores.indices.max(by: { scores[$0] < scores[$1] }), scores[best] >= Grounding.minCandidateOverlap {
                sense = clip(candidates![best], Budget.senseChars)
                out.dropped.append("\(phrase) -> 词典原义项")
            } else {
                out.dropped.append("\(phrase) -> 丢弃")
                continue
            }
        }
        let key = sense.lowercased()
        if seen.contains(key) { continue }
        seen.insert(key)
        out.senses.append(sense)
        if out.senses.count >= 3 { break }
    }
    return out
}

func splitSenses(_ text: String) -> [String] {
    text.components(separatedBy: CharacterSet(charactersIn: ";；\n"))
        .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " .。*\"-•<>[]").union(.whitespaces)) }
        .map { $0.replacingOccurrences(of: "^\\d{1,2}[.)]\\s*", with: "", options: .regularExpression) }
        .filter { !$0.isEmpty }
}

// 解析 "Senses: …" 一行。模型偶尔改用编号列表或每行一条，也收集起来（视为已按贴合度排好）；
// 偶尔仍会多给一行 "Ranked: …"，以它为准
func parseSenses(_ text: String) -> [String] {
    var senses: [String] = [], ranked: [String] = [], loose: [String] = []
    for line in text.components(separatedBy: .newlines) {
        let clean = line.replacingOccurrences(of: "*", with: "").trimmingCharacters(in: .whitespaces)
        if clean.isEmpty { continue }
        if let r = clean.range(of: "^senses?\\s*[:：]", options: [.regularExpression, .caseInsensitive]) {
            senses = splitSenses(String(clean[r.upperBound...]))
        } else if let r = clean.range(of: "^ranked\\s*[:：]", options: [.regularExpression, .caseInsensitive]) {
            ranked = splitSenses(String(clean[r.upperBound...]))
        } else if !clean.contains(":") || clean.range(of: "^\\d{1,2}[.)]", options: .regularExpression) != nil {
            loose.append(contentsOf: splitSenses(clean))
        }
    }
    var result = !ranked.isEmpty ? ranked : (senses.isEmpty ? loose : senses)
    // 偶尔整行只用逗号分隔多条短义项（"stake in land, legal concern, common concern"）
    if result.count == 1 {
        let parts = result[0].components(separatedBy: ", ").map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.count >= 2 && parts.allSatisfy({ !$0.isEmpty && $0.split(separator: " ").count <= 5 }) { result = parts }
    }
    return result
}

func rank(word: String, raw: String, context: Context, lang: TargetLanguage, transcribe: Bool,
          timeout: Double, printPrompt: Bool) async -> Output {
    let instructions = rankInstructions(lang, transcribe: transcribe)
    let prompt = withFeedback(rankPrompt(word: word, context: context, raw: raw))
    if printPrompt {
        FileHandle.standardError.write(("--- instructions ---\n\(instructions)\n--- prompt ---\n\(prompt)\n---\n").data(using: .utf8)!)
    }
    let chars = instructions.count + prompt.count
    do {
        // 默认 guardrail 会把金融、政治类论文语境大面积误判为敏感；permissiveContentTransformations
        // 只对 String 输出放宽，所以用纯文本而非 guided generation（见 docs/context-rank.md）
        let content = try await withTimeout(timeout) {
            let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
            let session = LanguageModelSession(model: model, instructions: instructions)
            return try await session.respond(to: prompt, options: GenerationOptions(samplingMode: .greedy)).content
        }
        if printPrompt {
            FileHandle.standardError.write(("--- model output ---\n\(content)\n---\n").data(using: .utf8)!)
        }
        let parsed = parseSenses(content)
        // 转写成别的语言后与原文没有词形重合，落地校验无从做起；改为在界面上标明「已转写」并可展开原文
        let grounded = transcribe
            ? Grounded(senses: Array(parsed.filter { $0.count <= Budget.senseChars * 2 }.prefix(3)), dropped: [])
            : ground(parsed, raw: raw, context: context)
        guard !grounded.senses.isEmpty else {
            return Output(available: false, ranked: false, targetLang: lang.rawValue, promptChars: chars,
                          dropped: grounded.dropped.isEmpty ? nil : grounded.dropped,
                          reason: "ungrounded or unparsable: \(clip(content, 120))")
        }
        return Output(available: true, ranked: true,
                      summary: grounded.senses.joined(separator: lang.isChinese ? "；" : "; "),
                      senses: grounded.senses, targetLang: lang.rawValue,
                      transcribed: transcribe ? true : nil, promptChars: chars,
                      dropped: grounded.dropped.isEmpty ? nil : grounded.dropped)
    } catch is Timeout {
        return Output(available: false, ranked: false, targetLang: lang.rawValue, promptChars: chars, reason: "timeout")
    } catch {
        return Output(available: false, ranked: false, targetLang: lang.rawValue, promptChars: chars, reason: "\(error)")
    }
}

/* ---------------- 兜底 A：按语境把词换成另一种语言的词 ---------------- */

// 只输出一个词（或至多三个词的固定搭配），并校验文字系统，防止模型输出一句解释
func validConversion(_ text: String, original: String, lang: TargetLanguage) -> String? {
    let word = text.trimmingCharacters(in: CharacterSet(charactersIn: " .。,，\"'“”‘’「」*`").union(.whitespacesAndNewlines))
        .components(separatedBy: .newlines).first ?? ""
    if word.isEmpty || word.uppercased() == "NONE" || word.count > 30 { return nil }
    if word.lowercased() == original.lowercased() { return nil }
    if lang.isChinese {
        guard word.allSatisfy({ isHan($0) }) else { return nil }
    } else {
        guard word.split(separator: " ").count <= 2,
              word.unicodeScalars.allSatisfy({ CharacterSet.letters.contains($0) || $0 == " " || $0 == "-" || $0 == "'" }),
              !word.contains(where: { isHan($0) }) else { return nil }
    }
    return word
}

func convert(word: String, context: Context, lang: TargetLanguage, timeout: Double, printPrompt: Bool) async -> Output {
    let instructions = """
    A reader selected a word in an academic paper, but the dictionary they use is in \(lang.englishName).
    Give the one \(lang.englishName) word that the selected word most likely means in this paper. \
    Use the paper's title, abstract and the words looked up earlier only to choose between meanings; \
    do not add words from the paper. \
    Output exactly one \(lang.englishName) word and nothing else. If you cannot tell, output NONE.
    """
    let block = context.promptBlock
    let prompt = "Selected word: \(word)" + (block.isEmpty ? "" : "\n\(block)")
    if printPrompt {
        FileHandle.standardError.write(("--- instructions ---\n\(instructions)\n--- prompt ---\n\(prompt)\n---\n").data(using: .utf8)!)
    }
    let chars = instructions.count + prompt.count
    do {
        let content = try await withTimeout(timeout) {
            let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
            let session = LanguageModelSession(model: model, instructions: instructions)
            return try await session.respond(to: prompt, options: GenerationOptions(samplingMode: .greedy)).content
        }
        if printPrompt {
            FileHandle.standardError.write(("--- model output ---\n\(content)\n---\n").data(using: .utf8)!)
        }
        guard let converted = validConversion(content, original: word, lang: lang) else {
            return Output(available: false, ranked: false, targetLang: lang.rawValue, promptChars: chars,
                          fallback: "A", reason: "conversion rejected: \(clip(content, 80))")
        }
        return Output(available: true, ranked: false, targetLang: lang.rawValue, promptChars: chars,
                      fallback: "A", converted: converted)
    } catch is Timeout {
        return Output(available: false, ranked: false, targetLang: lang.rawValue, promptChars: chars, fallback: "A", reason: "timeout")
    } catch {
        return Output(available: false, ranked: false, targetLang: lang.rawValue, promptChars: chars, fallback: "A", reason: "\(error)")
    }
}

@main
struct Main {
    static func main() async {
        guard let word = argValue("--word"), !word.isEmpty else {
            emit(Output(available: false, ranked: false, reason: "no word"))
            return
        }

        let convertTo = argValue("--convert-to")
        var raw = argValue("--raw") ?? ""
        // 转换模式不需要原文；不读 stdin，否则在 Zotero 的子进程里会一直等一个不会关闭的管道
        if raw.isEmpty, convertTo == nil, isatty(STDIN_FILENO) == 0 {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            raw = String(data: data, encoding: .utf8) ?? ""
        }
        if raw.count > Budget.raw {
            raw = String(raw.prefix(Budget.raw))
        }

        let printPrompt = CommandLine.arguments.contains("--print-prompt")
        let transcribe = CommandLine.arguments.contains("--transcribe")
        // 兜底调用的超时上限 3 秒（任务书要求）；常规调用 6 秒
        let timeout = Double(argValue("--timeout") ?? "") ?? (convertTo != nil || transcribe ? 3 : 6)
        let lang = TargetLanguage.from(arg: argValue("--target-lang"), raw: raw)
        let context = Context.fromArgs(excluding: word)

        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            break
        case .unavailable(let reason):
            emit(Output(available: false, ranked: false, reason: "unavailable: \(reason)"))
            return
        @unknown default:
            emit(Output(available: false, ranked: false, reason: "unknown availability"))
            return
        }

        if let convertTo = convertTo {
            emit(await convert(word: word, context: context, lang: TargetLanguage.from(arg: convertTo, raw: ""),
                               timeout: timeout, printPrompt: printPrompt))
        } else if raw.isEmpty || (context.isEmpty && !transcribe) {
            emit(await condense(word: word, raw: raw, lang: lang, timeout: timeout))
        } else if transcribe || argValue("--rank-method") == "onestep" {
            emit(await rank(word: word, raw: raw, context: context, lang: lang, transcribe: transcribe,
                            timeout: timeout, printPrompt: printPrompt))
        } else if let out = await rankByCandidates(word: word, raw: raw, context: context, lang: lang,
                                                   timeout: timeout, printPrompt: printPrompt) {
            emit(out)
        } else {
            // 候选不足两条，无可排序：按无语境精简
            emit(await condense(word: word, raw: raw, lang: lang, timeout: timeout))
        }
    }
}
