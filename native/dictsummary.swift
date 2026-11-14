// dictsummary — 用 macOS 端侧 Foundation Model 把词典原文压成一两行中文释义
//
// 用法: dictsummary --word colossal [--raw "<词典原文>"]
//   原文也可以从 stdin 传入。
//
// 输出 JSON: {"available":true,"summary":"① 巨大的 ② 规模惊人的"}
// 不可用时:  {"available":false,"reason":"..."}

import Foundation
import FoundationModels

struct Output: Codable {
    var available: Bool
    var summary: String?
    var reason: String?
}

func emit(_ out: Output) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(out), let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"available\":false,\"reason\":\"encode failed\"}")
    }
}

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

@main
struct Main {
    static func main() async {
        guard let word = argValue("--word"), !word.isEmpty else {
            emit(Output(available: false, summary: nil, reason: "no word"))
            return
        }

        var raw = argValue("--raw") ?? ""
        if raw.isEmpty {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            raw = String(data: data, encoding: .utf8) ?? ""
        }
        if raw.count > 2000 {
            raw = String(raw.prefix(2000))
        }

        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            break
        case .unavailable(let reason):
            emit(Output(available: false, summary: nil, reason: "unavailable: \(reason)"))
            return
        @unknown default:
            emit(Output(available: false, summary: nil, reason: "unknown availability"))
            return
        }

        let instructions = """
        You are a dictionary editor. Given an English word and its dictionary entry, output its most useful senses for a reader.
        Rules:
        - At most three senses, separated by "; "
        - Each sense a short English phrase, no examples, no etymology, no part-of-speech labels, no phonetics, no numbering
        - Do not add any preamble, explanation, or line breaks
        Example: extremely large; (of a statue) at least twice life size
        """

        let session = LanguageModelSession(instructions: instructions)
        let prompt = "Word: \(word)\nDictionary entry: \(raw.isEmpty ? "(none)" : raw)"

        do {
            let response = try await session.respond(to: prompt)
            let summary = response.content
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "\n", with: " ")
            emit(Output(available: true, summary: summary, reason: nil))
        } catch {
            emit(Output(available: false, summary: nil, reason: "\(error)"))
        }
    }
}
