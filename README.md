[![Listed in Zotero Chinese](https://zotero-chinese.com/badges/listed.svg)](https://zotero-chinese.com/plugins/)

# Zotero System Dictionary

Select a word in Zotero's reader and the selection popup shows its IPA and two or three
senses from the macOS dictionaries, with the sense most likely meant in this paper first.

macOS already shows the full dictionary entry for any word in the reader with Cmd-Ctrl-D
or a force-click, no plugin needed. If that works for you, you don't need this. The plugin
uses the same system dictionaries and differs in three ways:

1. **No shortcut** — selecting the word is the trigger. Nothing to remember, no force-click, no context menu.
2. **Less on screen** — the native popup is the whole entry (pronunciation, every sense, examples, etymology, derivatives) and covers the text. Here it is IPA plus two or three senses inside Zotero's own popup: read and move on.
3. **Ranked for the paper** — the item's title, abstract, venue and the words you already looked up in it go into one on-device model call that puts the likeliest sense first, marked with a blue dot.

- **Grounded** — by default the model only picks and orders senses cut out of the dictionary entry; it cannot add one
- **On device** — DictionaryServices plus Apple Foundation Models; nothing leaves the machine. Without Apple Intelligence the parsed entry is shown in dictionary order

## Install

1. Download `sysdict-lookup.xpi` from [Releases](https://github.com/PeberWang/zotero-sysdict-lookup/releases)
2. Zotero → Tools → Plugins → gear → Install Plugin From File
3. Open any PDF and select an English word

On first launch the plugin extracts its bundled helpers (universal arm64 + x86_64
binaries) to `~/Library/Application Support/Zotero/sysdict/bin/`.

**Requirements**: macOS (DictionaryServices), Zotero 7 or later. The New Oxford
American Dictionary must be enabled in System Settings → General → Dictionary
(it is by default on macOS). Condensing and ranking need macOS 26+ with Apple
Intelligence enabled; without it the plugin still works and shows the parsed entry.

## Context-aware ranking

A word often has several senses that fit the sentence, and the right one depends on the
field: *interest* in a monetary-policy paper is not *interest* in a property-rights paper.
When the PDF belongs to a Zotero item, the plugin orders the senses for that item.

**Input.** At the moment of selection the plugin reads the parent item's title, abstract,
venue (publication, proceedings, conference or book title), year and the first three
authors' surnames, plus the 12 most recent other words you looked up in the same item.
These go into one on-device model call together with the entry. Fields are clipped
(title 200, abstract 600, venue 100, authors 80 characters; entry 2000 characters).

**Constraint.** By default (`rankMethod=candidates`) the entry is first split into
lettered candidate senses in code, and the model only picks and orders them. Each pick is
matched back to a candidate; anything that does not match is discarded, so the model cannot
invent a meaning. For Chinese explanations the candidates are the Chinese senses of the
English–Chinese dictionary. The experimental `rankMethod=onestep` lets the model write
senses from the full entry instead, checked by word overlap against the entry.

**Marker.** The first sense gets a blue dot and a small label (*best fit here* /
按语境首选), meaning "inferred for this paper" rather than the dictionary's own order. If the
model returns fewer than three senses, the rest are filled in from the unranked senses.

**Turning it off.** Set `contextRank` to `false` and the popup shows the condensed senses in
dictionary order, with no metadata read and no history kept. Ranking is also skipped when
the PDF has no parent item with a title, abstract or venue and there is no history yet, and
when the model is unavailable or times out; the popup then keeps the unranked senses.

- **Can be wrong** — it is a small model; the second line is often the one you wanted
- **Bounded** — history is kept per item in `sysdict/history/`, at most 50 words or 30 days, whichever comes first; ranked results are cached in memory for 10 minutes
- **Evidence** — on 24 constructed cases (not real reading data) the candidate method got the first sense right in 83% of cases, tied with a slower two-step method and ahead of the one-step method (62%); with this few cases the intervals overlap ([bench/report.md](bench/report.md))

Only the first homograph of a word is available (e.g. `bank` in the river sense, not the
financial one), so the ranking cannot surface a meaning the entry does not contain.
Design notes (Chinese): [docs/context-rank.md](docs/context-rank.md). To try it without
Zotero: `bash build.sh && zsh scripts/rank_demo.sh`.

## Preferences

Zotero → Settings → **系统词典** (System Dictionary) has a pane for the language settings,
dictionary scope, fallback switch and the list of detected dictionaries. Every key is also
under `extensions.zotero.sysdict.` in the config editor (before 0.4.0 these keys were read
from the wrong branch and had no effect):

| Key | Default | Description |
| --- | --- | --- |
| `autoLookup` | `true` | Look up as soon as text is selected; set `false` to show a button instead |
| `maxWords` | `3` | Maximum number of words in a selection |
| `order` | empty | Custom dictionary order, `\|`-separated, e.g. `New Oxford American Dictionary\|牛津英汉汉英词典` |
| `targetLang` | `auto` | Explanation language: `auto` (first system language), `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `es`, `fr`, `de` |
| `sameLanguageOnly` | `false` | Explain a word only in its own language (English in English, Chinese in Chinese) |
| `dictScope` | empty | Only use these dictionaries, `\|`-separated; empty means all |
| `fallback` | `false` | Allow the on-device model to bridge languages when no dictionary fits (always labelled) |
| `rankMethod` | `candidates` | Context ranking: `candidates` (pick from dictionary senses, default) or `onestep` (experimental) |
| `contextRank` | `true` | Rank senses by the current paper and the words you looked up in it; set `false` for the plain dictionary order |

## How it works

```
selection in the reader
   ↓ renderTextSelectionPopup
bootstrap.js takes the selection text (getSelection first, annotation.text as fallback)
   ↓
dictlookup — bundled universal binary calling DictionaryServices
   ↓
headword / IPA / parsed senses, shown at once
   ↓
dictsummary — Apple Foundation Models, on device
   (with item context: pick and order senses; without: condense)
   ↓
senses replaced in Zotero's selection popup
```

PDF selections occasionally miss the last letters (`colossa` instead of `colossal`).
If the item has a Zotero full-text index, the plugin checks whether the selection occurs in
the paper; if not, it tries up to three words from the paper that start with it, preferring
the same page. `dictlookup` itself also tries completing one trailing letter and only
accepts an unambiguous match. A completion is always shown in the popup, with a link to
look up the original selection.

## Build from source

Requires Xcode Command Line Tools:

```sh
bash build.sh
```

Output: `build/sysdict-lookup.xpi`. The script compiles `native/dictlookup.m` and
`native/dictsummary.swift` for arm64 and x86_64, embeds them as base64 in
`addon/native/*.b64.js`, and packages the XPI.

## Apple Foundation Models

After the dictionary lookup returns, the plugin asks the **on-device model** (the
`FoundationModels` framework, macOS 26+ with Apple Intelligence enabled) to condense
the entry into at most three short senses in the explanation language. Without item
context the condensed result is cached on disk per word and language, so a word is only
summarised once; with item context the same call also does the ranking described above.

If the model is unavailable or the call fails, the deterministically parsed senses
are shown instead — same layout, no second view, no error message. Nothing leaves
the machine in either path.

## Explanation language

The plugin probes each downloaded dictionary with a few English and Chinese words and
records which language it actually explains them in, without going by the dictionary's
name. It then picks the explanation language: your setting if you set one, otherwise the
first of the system's preferred languages. The dictionaries are tried in your order, and
the first one that contains the word *and* explains it in that language is used, judged on
the definition it actually returns. With an English-first system, English words still go
to the New Oxford American Dictionary, exactly as before.

If no dictionary fits, the popup says so (word language, target language, where to enable
dictionaries). With `fallback` on, the on-device model may instead map the word into the
first dictionary's language, or rewrite the senses into the target language. Either case
is labelled in the popup and the original stays one click away.

The explanation language is judged on the definition text only: headword, inflections,
pronunciation and examples are stripped first. Bilingual dictionaries are then recognised
within their language pair, so the Spanish–English dictionary explains *agua* in English
and *water* in Spanish. On this machine 64 of 65 test lookups were classified correctly. Details (in Chinese):
[docs/languages.md](docs/languages.md). Try it without Zotero: `node scripts/lang_demo.js`.

## Limitations

- macOS only (DictionaryServices)
- Scanned PDFs need OCR first
- Triggers on English words and short phrases (up to `maxWords`), and on Chinese words of up to eight characters when a dictionary covering Chinese is enabled
- Only the first homograph of a word is looked up
- Ranking needs Apple Intelligence and a Zotero parent item (or earlier lookups in the same item)

## License

MIT

---

## 中文说明

在 Zotero 阅读器里划中一个词，划词弹窗直接显示音标和两三条来自 macOS 词典的释义，并把这篇论文里最可能的意思排在第一。

macOS 本身已经能在阅读器里对任意词弹出完整词条：按 Cmd-Ctrl-D，或在触控板上用力点按，不需要插件。原生弹窗够用，就不必装这个。
插件用的是同一套系统词典，区别在三处：

1. **不用按键**：划中即触发。不用记 Cmd-Ctrl-D，不用三指重按，也不用去右键菜单里找。
2. **做减法，不打断**：原生弹窗是一条完整词条，音标、多条释义、例句、词源、派生词堆在一起，体量大，还盖住正文。插件只给音标加两三条释义，放在 Zotero 自己的划词弹窗里，读完即走。
3. **按本文排序**：把当前条目的标题、摘要、期刊和本文此前查过的词送进同一次端侧模型调用，把这篇论文里最可能的意思排第一，并加蓝点。

- **有据可查**：默认只让模型在词条切出的义项里挑选排序，加不出词条以外的意思
- **端侧**：DictionaryServices + Apple Foundation Models，不出本机；没有 Apple Intelligence 时按词典原顺序显示解析结果

**按当前文献语境排序**：划词时读取父条目的标题、摘要、期刊（或会议、书名）、年份和前三位作者姓氏，
以及本文此前查过的最近 12 个其他词，与词条一起放进同一次端侧模型调用（标题 200、摘要 600、期刊 100、作者 80 字符、词条 2000 字符截断）。
默认用候选法（`rankMethod=candidates`）：代码先把词条切成带字母编号的义项，模型只在其中挑选排序，每条结果都要对回某个候选，对不上就丢弃，
所以编不出词条以外的意思。中文释义时，候选直接取中英词典的中文义项。实验性的 `rankMethod=onestep` 让模型从整段词条直接写义项，再按实词重合度校验。
首选义项加蓝色小圆点和一行小字（「按语境首选」），表示这是按本文推断的，不是词典原顺序；模型返回不足三条时，用未排序的义项补齐。
`contextRank=false` 时只显示词典顺序的精简释义，不读元数据、不记历史；没有父条目信息且没有历史、或模型不可用/超时时，也保持未排序结果。
小模型可能判断错，第二条往往才是你要的。历史按条目存放在 `sysdict/history/`，最多 50 词或 30 天；排序结果只在内存缓存 10 分钟。
在 24 个构造案例（不是真实阅读样本）上，候选法首选命中 83%，与更慢的两步法持平，高于一步法（62%）；样本小，区间重叠（见 [bench/report.md](bench/report.md)）。
只取第一个同形异义词条（如 `bank` 只有河岸义，没有银行义），排序无法给出词条里不存在的义项。设计说明见 [docs/context-rank.md](docs/context-rank.md)。

**解释语言**：插件先对每本已下载的词典试查几个英文词和汉字词，按返回文字推断它用什么语言解释，不看词典名。
目标语言默认取系统首选语言第一项，可在 Zotero 设置 → 系统词典 里改。释义语言只看释义本身（先剥掉词头、音标、例句），
双语词典在其语言对内判断，例如系统英文时划西班牙语词，会选西英词典。查词时按词典顺序逐本尝试，
取第一本收录该词、并且实际释义是目标语言的词典；都不满足就明确提示，不静默回退。英文为首选语言时，行为与以前相同。
可选的兜底（默认关闭）由端侧模型换词或转写，结果都会标明。说明见 [docs/languages.md](docs/languages.md)。

**划词补全**：PDF 选区偶尔丢掉末尾字母。条目有 Zotero 全文索引时，插件先看选区是否在原文里出现，没有就按原文里以它开头的词（同页优先）最多试三个；
`dictlookup` 自身也会尝试补一个末字母，只接受唯一匹配。补全结果会在弹窗里标明，并可一键查原选区。

安装：从 [Releases](https://github.com/PeberWang/zotero-sysdict-lookup/releases) 下载
`sysdict-lookup.xpi`，Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件。仅支持 macOS；压缩与排序需要 macOS 26+ 并开启 Apple Intelligence。
