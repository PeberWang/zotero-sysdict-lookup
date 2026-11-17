import Foundation
@main struct T { static func main() {
    let raw = (try? String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)) ?? ""
    var ctx = Context(); ctx.title = "Shadow banking and regulatory arbitrage in China"; ctx.history = ["lender", "liquidity"]
    let fake = ["money paid for the use of money lent",            // 正常
                "regulatory arbitrage by shadow lenders",          // 语境泄漏 + 原文无 → 丢弃
                "a stake, share, or involvement in an undertaking, especially a financial one, held by investors in many firms worldwide", // 超长 → 退回原义项
                "liquidity of shadow banking markets"]             // 语境泄漏 → 丢弃
    let g = ground(fake, raw: raw, context: ctx)
    print("kept:", g.senses); print("dropped:", g.dropped)
    print("parse numbered:", parseSenses("1. alpha beta gamma\n2. delta epsilon"))
    print("parse two-line:", parseSenses("Senses: a b c; d e f"))
    let zh = zhCandidates("bias | BrE ˈbʌɪəs | A. noun ① uncountable (inclination) 倾向 qīngxiàng▸ a female bias 对女性的偏爱 ② (prejudice) 偏见 piānjiàn▸ x ⑤ Statistics 偏差 piānchā B. transitive verb 使有偏见 shǐ yǒu piānjiàn")
    print("zh candidates:", zh.map { "\($0.hint)|\($0.zh)" })
    print("letters:", parseLetters("B\nA\nB\nZ", count: 3), parseLetters("Answer: C, A", count: 3))
}}
