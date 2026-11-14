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
        你是一个英汉词典编辑。用户给你一个英文单词和它的词典原文，你只输出这个词最核心的中文释义。
        规则：
        - 最多两个义项，用 ①② 编号，没有第二义项就只给一个
        - 每个义项不超过 12 个汉字，只写词义，不写例句、词源、词性缩写、音标
        - 不要任何解释、前缀、换行或标点装饰
        例：① 巨大的 ② 规模惊人的
        """

        let session = LanguageModelSession(instructions: instructions)
        let prompt = "单词：\(word)\n词典原文：\(raw.isEmpty ? "（无）" : raw)"

        do {
            let response = try await session.respond(to: prompt)
            let summary = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
            emit(Output(available: true, summary: summary, reason: nil))
        } catch {
            emit(Output(available: false, summary: nil, reason: "\(error)"))
        }
    }
}
