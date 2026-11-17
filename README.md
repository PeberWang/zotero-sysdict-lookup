# Zotero System Dictionary

Look up English words from macOS's built-in dictionaries without leaving Zotero's PDF reader.
Select a word and the selection popup shows **IPA + two or three concise English senses** —
no examples, no etymologies, no clutter.

- **Offline** — queries macOS DictionaryServices locally; nothing is sent anywhere
- **Instant** — milliseconds, no network round trip
- **Terse** — headword, pronunciation, and the first two or three senses only
- **Native** — lives inside Zotero's own selection popup, no extra window
- **On-device condensation** — Apple Foundation Models rewrites the entry into two or three short senses; if Apple Intelligence is unavailable the parsed entry is shown unchanged

![screenshot](docs/screenshot.png)

## Install

1. Download `sysdict-lookup.xpi` from [Releases](https://github.com/PeberWang/zotero-sysdict-lookup/releases)
2. Zotero → Tools → Plugins → gear → Install Plugin From File
3. Open any PDF and select an English word

On first launch the plugin extracts its bundled dictionary helper (a universal
arm64 + x86_64 binary) to `~/Library/Application Support/Zotero/sysdict/bin/`.

**Requirements**: macOS (DictionaryServices), Zotero 7 or later. The New Oxford
American Dictionary must be enabled in System Settings → General → Dictionary
(it is by default on macOS).

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
headword / IPA / first three senses
   ↓
rendered into Zotero's selection popup
```

PDF selections occasionally miss the last letter (`colossa` instead of `colossal`).
When a lookup fails, `dictlookup` tries completing one trailing letter and only
accepts an unambiguous match.

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
the entry into at most three short English senses. Results are cached per word, so a
word is only summarised once.

If the model is unavailable or the call fails, the deterministically parsed senses
are shown instead — same layout, no second view, no error message. Nothing leaves
the machine in either path.

## Context-aware ranking

When the PDF belongs to a Zotero item, the senses are ordered for **the paper you are
reading**: the item's title, abstract, venue, year and authors, plus the last words you
looked up in the same item, go into one on-device model call. By default the entry is
first split into lettered candidate senses and the model only picks and orders them, so it
cannot invent a meaning. In a 24-case constructed benchmark this was the most accurate and
the fastest of the three approaches tried (`bench/report.md`). For Chinese explanations the
candidates are the Chinese senses of the English–Chinese dictionary. The first sense gets
a small blue dot, meaning "inferred for this paper" rather than the dictionary's own order.

- **On-device, offline** — same Foundation Models call as above, no extra request; nothing is sent anywhere
- **Grounded** — the model picks from senses cut out of the entry; an experimental mode (`rankMethod=onestep`) lets it write senses from the full entry instead, with a word-overlap check
- **Can be wrong** — it is a small model; the second line is often the one you wanted
- **Bounded** — history is kept per item in `sysdict/history/`, at most 50 words or 30 days, whichever comes first
- **Optional** — set `extensions.zotero.sysdict.contextRank` to `false` to turn it off

Only the first homograph of a word is available (e.g. `bank` in the river sense, not the
financial one), so the ranking cannot surface a meaning the entry does not contain.
Design notes (Chinese): [docs/context-rank.md](docs/context-rank.md). To try it without
Zotero: `bash build.sh && zsh scripts/rank_demo.sh`.

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
- Triggers on English words and short phrases only

## License

MIT

---

## 中文说明

在 Zotero 内置 PDF 阅读器里划中英文单词，划词弹窗直接给出**音标 + 两三条简明英英释义**，
词条来自 macOS 自带的 New Oxford American Dictionary，离线、毫秒级；例句、词源、派生词自动剥离。
另有「词典 App」按钮可跳转系统词典。

**按当前文献语境排序**：划词时把当前条目的标题、摘要、期刊、年份、作者，以及本文此前划过的词，
放进同一次端侧模型调用，把最可能的意思排在第一，并加一个蓝色小圆点。默认用候选法：代码先把词条切成带编号的义项，
模型只在其中挑选排序，编不出词条以外的意思；在 24 个构造案例的基准里，它最准也最快（见 `bench/report.md`）。
中文释义时，候选直接取中英词典的中文义项。仍然离线；小模型可能判断错。历史按条目存放，最多 50 词或 30 天。可用偏好 `contextRank=false` 关闭。
设计说明见 [docs/context-rank.md](docs/context-rank.md)。

**解释语言**：插件先对每本已下载的词典试查几个英文词和汉字词，按返回文字推断它用什么语言解释，不看词典名。
目标语言默认取系统首选语言第一项，可在 Zotero 设置 → 系统词典 里改。释义语言只看释义本身（先剥掉词头、音标、例句），
双语词典在其语言对内判断，例如系统英文时划西班牙语词，会选西英词典。查词时按词典顺序逐本尝试，
取第一本收录该词、并且实际释义是目标语言的词典；都不满足就明确提示，不静默回退。英文为首选语言时，行为与以前相同。
可选的兜底（默认关闭）由端侧模型换词或转写，结果都会标明。说明见 [docs/languages.md](docs/languages.md)。

安装：从 [Releases](https://github.com/PeberWang/zotero-sysdict-lookup/releases) 下载
`sysdict-lookup.xpi`，Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件。仅支持 macOS。
