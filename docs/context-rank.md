# 按当前文献语境重排义项：设计说明

## 一句话

划词时，把当前文献的元数据和本文此前划过的词，在**一次**端侧模型调用里交给 Apple Foundation Models。默认采用**候选法（A）**：代码先把词条切成带字母的候选义项，模型只能在候选里挑选和排序，所以编不出词条以外的意思。首选加一个蓝色小圆点。任何一步失败，都保持原来的显示。

## 0. 为什么默认是候选法（2026-11-16 第四轮）

一共试过三种做法，在 `bench/` 的 24 个**构造**案例上各跑 3 次（详见 `bench/report.md`）：

| | A 候选法（默认） | B 原文两步 | C 原文一步 |
| --- | --- | --- | --- |
| 首选命中（95% CI） | 83%（67–96） | 83%（67–96） | 62%（42–79） |
| 前三覆盖 | 92% | 96% | 71% |
| 解析失败 | 0% | 0% | 17% |
| 编造率（代理指标） | 6% | 0% | 23% |
| 延迟 p50 | 642 ms | 970 ms | 565 ms |

- 构造集很小，三组配对差的区间都跨 0。但 A 的首选命中不低于另两种，没有解析失败，延迟也只比 C 多约 80 ms；C 的编造与解析问题是结构性的（见 `bench/report.md` 第 3.4 节）。所以按验收意见，默认改回 A。
- **B 已从插件代码中删除**：首选命中与 A 持平，但慢约 50%，而第二步「重排」几乎不起作用。它只在 `bench/runner.swift` 里按原样保留，用于复现对照。
- **C 保留为可选项**：偏好 `rankMethod=onestep`，或者 CLI 加 `--rank-method onestep`。兜底 B 的「转写」需要生成，仍走 C 的路径。

下文第 2 节描述 C（整段原文）的设计，作为可选路径的说明；默认路径见第 2.5 节。

## 1. 上下文怎么取

| 来源 | 取法 | 时机 |
| --- | --- | --- |
| 元数据 | `renderTextSelectionPopup` 事件里的 `event.reader.itemID` → 附件 → `parentItem`；读 `title`、`abstractNote`、`publicationTitle`（依次退到 `proceedingsTitle` / `conferenceName` / `bookTitle`）、`date` 的年份、前三位作者姓氏 | 每次划词现读，没有后台轮询 |
| 划词历史 | `~/Library/Application Support/Zotero/sysdict/history/<itemID>.json`，`[{w, ts}]` 按时间顺序 | 内存里有一份 `historyCache`，第一次划词时同步读入（文件很小）。弹窗渲染时先取**本次之前**的快照，查词成功后才把当前词追加进去 |

- 没有父条目（独立 PDF）时元数据为空，只用历史。两者都空就走原来的无语境路径。
- 历史写入：同词去重，挪到末尾；最多保留 50 个词，超过 30 天的丢弃，先到哪个限制就按哪个。
- 历史清理：每次写入时裁剪；插件启动 10 秒后扫一遍 `history/`，剔除过期条目，删掉空文件或损坏的文件。

## 2. 可选路径 C：整段原文 → 一次生成

> 第二、三轮曾把它设为默认（整段原文进 prompt，候选切分只在落地校验失败时兜底）。第四轮依据基准改回 A，C 降为可选。

### 为什么不用 `@Generable`

本机实测（macOS 27.0.1，Command Line Tools，Swift 6.4）：

1. **`@Generable` / `@Guide` 宏无法编译**：`plugin for module 'FoundationModelsMacros' not found`。宏插件只随完整 Xcode 提供，CLT 里没有。
2. **改用运行时的 `DynamicGenerationSchema` 可以编译，也能跑通**（arm64 / x86_64 都能编）。
3. 但 **guided generation 在默认 guardrail 下会大面积误杀**：「Credit Supply and Firm Investment」「Shadow banking」「Monetary policy transmission」等金融、政治经济学语境全部报 `May contain sensitive content`，有时连无语境的请求也会被拦。`SystemLanguageModel(guardrails: .permissiveContentTransformations)` 只对 **String 输出**放宽，对 schema 输出无效，实测同样被拦。
4. 让模型输出「首选下标」整数也不可靠：实测下标与内容对不上。

所以用的是任务书允许的退路：**permissive guardrail + 纯文本 + 代码端解析与落地校验**。

### 一次生成，一行输出（2026-11-16 第三轮改）

两步版（`Senses:` 先压缩、`Ranked:` 再重排）实测第二步几乎不起作用：6 个案例里只改过 1 次首选，还改错了。所以合成一步：模型从整段原文里挑出**最贴合本文的至多三条，按贴合度排序**，压成短语，只输出一行 `Senses: …`。`Ranked` 与 `reordered` 已删除。

另一个实测发现：**语境要放在原文之后，并以问句收尾**。端侧模型明显偏重 prompt 末尾，把标题和摘要放在原文之前时，单行版首选只对 2/5；放到后面并加一句 *Which senses does this paper need?*，就是 4/5。

解析依然宽松：模型改用编号列表或每行一条时也能收集；整行只用逗号分隔多条短义项时，会按逗号切开；万一还给了 `Ranked:` 行，就以它为准。

### 落地校验（防止编造词条以外的意思）

对输出的每一条短语（`ground()`）：

1. 取实词（长度 > 2、不在停用词表里，截前 5 个字母作粗略词干）；
2. **原文重合度** = 短语实词中出现在词条原文里的比例，要求 ≥ 0.5；
3. **语境泄漏** = 只出现在标题 / 摘要 / 历史、而不在原文里的实词，最多允许 1 个；
4. 短语长度 ≤ 80 字符。

不满足时，用 `extractCandidates(raw)` 切出的词典原义项兜底：取与短语重合度最高的一条（≥ 0.34），**退回词典原义项**原文；连这也对不上就**丢弃**。处理记录写进输出的 `dropped` 字段。一条都没剩下，就返回 `available:false`，弹窗保持原样。

`scripts/swift_logic_test.sh` 用伪造的输出验证了三条分支：正常短语保留、带语境泄漏的「regulatory arbitrage by shadow lenders」被丢弃、超长短语退回词典原义项。

这一层能拦住**用语境词拼出来的假义项**，但拦不住「从原文里挑错了义项」。后者是排序质量问题，不是编造。

### Prompt 长什么样

instructions（写死，英文目标；中文目标把示例换成 spring，并加「Write every sense in …」）：

```
You are a dictionary editor helping someone read an academic paper.
You get a word, facts about the paper, and the word's full dictionary entry.
Pick at most three senses from the entry that best fit how the word is used in this paper, best fit first, and shorten each to a phrase of four to ten words that keeps the entry's own key words. Never add a meaning taken from the paper. No examples, no etymology, no part-of-speech labels.
Output exactly one line and nothing else. Example for the word "bank" in a paper about river erosion:
Senses: the land alongside a river; a financial institution holding deposits; a stock held in reserve
```

prompt（`dictsummary --print-prompt` 会把 prompt 和模型原始输出打到 stderr）：

```
Word: interest
Dictionary entry: interest in·ter·est | ˈint(ə)rəst… | noun 1 the state of wanting to know…（整段，≤ 2000 字）
Paper title: Property rights and land tenure in rural China
Venue: Journal of Development Economics (2021)
Abstract: We examine how insecure land tenure affects investment by farm households.
Words looked up earlier in this paper, oldest first: tenure, title, lease
Which senses does this paper need?
```

措辞是用 5 个变体对比之后选的（探针在 `build/probe/variants.swift`，不进仓库）。几个教训：
- 用占位符模板（`Senses: first sense; second sense`）会被模型原样照抄，必须给具体示例；
- 要求「保留原文关键词」的措辞，比「改写成短语」更容易通过落地校验；
- 两步版的 5 个变体都没有全对，最好的是 3 对 1 近似；一步版把语境放到原文之后，是 4/5。

采样用 `.greedy`，同样的输入给出同样的结果，便于复现。

## 2.5 默认路径 A：候选法

- **英文目标**：`extractCandidates` 把词条按编号与 `•` 切开，去掉例句（`:` 与 `▸` 之后）和方括号标签，最多 12 条，每条 90 字符，用字母 A–L 标注。模型输出 `<字母>: <短语>`；短语按实词重合度落回候选（标签与内容一致用标签，不一致取最接近的候选，都对不上就丢弃）。提示词与插件第一版逐字相同，6 个 demo 案例的结果与当时完全一致。
- **中文目标**：候选**直接取中英词典的中文义项**（`zhCandidates`）。按 ①② 切开，截到 `▸` 之前，在遇到 `B.` 这类词性分段标记时截断，去掉拼音，保留词典给的英文提示标签，例如 `(money, wealth) 资本`。模型只输出字母，弹窗显示的是**词典原文的中文**，不经模型生成。
- **其他目标**（例如用西英词典给西班牙语释义）：候选取该词典的释义片段，同样只输出字母、显示原文。
- 候选少于 2 条时（单义词），改走无语境精简。

### 中文排序：查因与修复

第三轮观察到「中文目标下 `interest` 三个语境首选都是趣味」。第四轮做了诊断（`build/probe/zhdiag*.swift`），用 10 个中文目标案例，其中包括 capital 的资本 / 首都、bias 的偏见 / 偏差、culture 的群体文化 / 培养菌这几组对照：

| 做法 | 首选命中 |
| --- | --- |
| C，英文指令 + 「Write every sense in Simplified Chinese」，语境在原文**之后**（第三轮末的版本） | 7/10 |
| C，换成中文指令 | 6/10 |
| 中文候选、英文标签在后，语境在候选之后 | 5/10 |
| 中文候选、英文标签在后，中文指令 | 4/10 |
| 英文（NOAD）候选排序，再让模型写中文 | 选中的义项多数不对 |
| **中文候选、英文标签在前，A 的提示结构（语境在候选之前），只输出字母** | **8/10**（CLI 实测） |

结论：
1. **失效的主因不是指令语言**。换成中文指令反而略差。第三轮观察到的「总是趣味」，出现在把语境挪到原文之后的修正**之前**；那一版的语境放在原文前面，被模型的近因效应压过了。
2. 采用表里最后一行，作为中文目标下 A 的实现：既是「直接从中英词典取中文义项再排」，也让中文和英文共用一套 A 结构。
3. 剩下的 2 例错误：*Selection bias in online survey estimates* 给了「偏见」而不是「偏差」；*Curiosity and attention in children's reading* 给了「趣味」而不是「兴趣」。两例都是近义义项之间的混淆。

## 3. 预算

**默认路径 A**：原文不整段进 prompt，只进候选（12 条 × 90 字符，约 1.1k），加上元数据与历史，实测 `promptChars` 为 880–1580（基准均值 1492，约 373 token）。下表是可选路径 C 的预算。

全部写死在 `native/dictsummary.swift` 的 `enum Budget`（单位：字符；JS 侧的 `HISTORY_SEND = 12` 与之保持一致）。

| 字段 | 上限 | 说明 |
| --- | --- | --- |
| 词条原文 | 2000 | 沿用旧上限，整段进 prompt |
| 标题 | 200 | |
| 摘要 | 600 | 超出截断并加 `…` |
| 期刊 / 会议 | 100 | 另附 4 位年份 |
| 作者 | 80 | 前三位姓氏 |
| 历史 | 最近 12 个词 × 30 | 去重，并去掉当前词 |
| instructions | 约 640 | 固定（英文目标） |
| 单条输出短语 | 80 | 超出按未通过校验处理 |
| 兜底原义项 | 12 条 × 90 | 只在校验失败时于代码里使用，不进 prompt |

最坏情况合计约 4.1k 字符，约 1.1k token，仍远低于端侧模型 4096 token 的上下文。`rank_demo.sh` 的实测 `promptChars` 为 1440–3000，延迟中位数 0.46–0.73 s（两步版 0.86–1.25 s，只给候选的版本 0.27–0.72 s）。

## 4. 缓存

| 层 | 键 | 存放 | 失效 |
| --- | --- | --- | --- |
| 上下文无关的精简义项 | `word` | `cache/<word>.json`（原有 `cacheFile`） | 不过期，原样保留 |
| 兜底原义项切分 | — | 不缓存，只在校验失败时做，确定性字符串处理，耗时可忽略 | — |
| 带语境的排序 | `word \| itemID \| 历史最后 5 个词` | 内存 `rankCache` | 10 分钟 TTL，最多 200 条，关闭插件即清 |

带语境的结果从不写盘，也不会成为全局唯一的答案。

## 5. 退化

调用链上每一处失败都返回 `null`，弹窗停留在已经渲染的内容上：有上下文无关缓存就显示缓存，否则显示 dictlookup 的解析义项。不排序，也不报错。

- 模型不可用（`availability != .available`）→ `available:false`
- Swift 侧 6 s 超时（`--timeout` 可调）→ `reason:"timeout"`；JS 侧另有 8 s 兜底
- guardrail 或其他异常 → `available:false` 并带上原因
- 输出解析不出，或者全部未通过落地校验 → `reason:"ungrounded or unparsable: …"`
- 偏好 `contextRank=false` → 完全是旧行为

重排失败时**不会**再补一次无语境调用，以免变慢。原因会写进 `lookup.log`。

## 6. 已知边界

- **dictlookup 只返回第一个同形词**。`bank` 的「银行」义在 bank² 里，原文里根本没有，所以 `bank` 在 shadow banking 语境下的首选是 *the cushion of a pool table*（实测）。这属于查词层的限制，按任务书没有改动。
- **端侧小模型的判断会错**。A 在 6 个 demo 案例里，「Special interests and lobbying」语境下的首选是 *a subject about which one is concerned*，正确的 *a group … common concern* 不在首位；基准里 A 的首选命中是 83%。
- 中文目标下 A 是 8/10（构造的 10 例），见上文「中文排序」。
- 原文超过 2000 字时，靠后的义项看不到。
- 落地校验是词形重合，不懂同义改写。保留原文关键词的短语能通过；措辞完全换掉的正确短语可能被退回成原义项（显示变长，但意思不错）。
- 重排调用用的是 `permissiveContentTransformations`。它放宽的是对**输出改写**的过滤，输入仍是用户自己文献的元数据，全程在本机运行。
