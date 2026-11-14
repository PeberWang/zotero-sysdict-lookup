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

Under `extensions.zotero.sysdict.` in the config editor:

| Key | Default | Description |
| --- | --- | --- |
| `autoLookup` | `true` | Look up as soon as text is selected; set `false` to show a button instead |
| `maxWords` | `3` | Maximum number of words in a selection |
| `order` | empty | Custom dictionary order, `\|`-separated, e.g. `New Oxford American Dictionary\|牛津英汉汉英词典` |

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
./build.sh
```

Output: `build/sysdict-lookup.xpi`. The script compiles `native/dictlookup.m` for
arm64 and x86_64, embeds it as base64 in `addon/native/dictlookup.b64.js`, and
packages the XPI.

## Apple Foundation Models

After the dictionary lookup returns, the plugin asks the **on-device model** (the
`FoundationModels` framework, macOS 26+ with Apple Intelligence enabled) to condense
the entry into at most three short English senses. Results are cached per word, so a
word is only summarised once.

If the model is unavailable or the call fails, the deterministically parsed senses
are shown instead — same layout, no second view, no error message. Nothing leaves
the machine in either path.

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

安装：从 [Releases](https://github.com/PeberWang/zotero-sysdict-lookup/releases) 下载
`sysdict-lookup.xpi`，Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件。仅支持 macOS。
