# Zotero System Dictionary

在 Zotero 内置 PDF 阅读器里划一个英文单词，划词弹窗直接给出**音标 + 两三条简明英英释义**，
词条来自 macOS 自带词典（New Oxford American Dictionary / Oxford Dictionary of English）。

- **离线**：调用 macOS 的 DictionaryServices，不联网、不传词
- **即时**：本地查询，毫秒级
- **干净**：只保留音标和核心义项，自动剥掉例句、词源、派生词
- **不打扰**：不弹独立窗口，直接长在 Zotero 自己的划词弹窗里

## 安装

1. 从 [Releases](https://github.com/PeberWang/zotero-sysdict-lookup/releases) 下载 `sysdict-lookup.xpi`
2. Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件
3. 打开任意 PDF，选中英文单词

首次启动时，插件会把内置的词典助手（通用二进制，arm64 + x86_64）释放到
`~/Library/Application Support/Zotero/sysdict/bin/`。

**要求**：macOS（DictionaryServices）、Zotero 7 及以上。系统里需要有牛津词典
（macOS 默认自带；系统设置 → 通用 → 词典 里确认已勾选）。

## 设置

`about:config` 里以 `extensions.zotero.sysdict.` 开头：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `autoLookup` | `true` | 划词后自动查询；设为 `false` 则显示「查系统词典」按钮 |
| `maxWords` | `3` | 最多查几个词，超过就不触发 |
| `order` | 空 | 自定义词典顺序，用 `\|` 分隔，如 `New Oxford American Dictionary\|牛津英汉汉英词典` |

## 工作原理

```
Zotero 阅读器划词
   ↓ renderTextSelectionPopup 事件
bootstrap.js 取选区文本（getSelection 优先，annotation.text 兜底）
   ↓
dictlookup（内置通用二进制，调用 DictionaryServices）
   ↓
拆出词头 / 音标 / 前三条义项
   ↓
渲染进 Zotero 的划词弹窗
```

PDF 划词偶尔会少选最后一个字母（`colossa` 而不是 `colossal`），`dictlookup` 会在查不到时
尝试补一个字母，唯一命中才采用。

## 从源码构建

需要 Xcode Command Line Tools：

```sh
./build.sh
```

产物：`build/sysdict-lookup.xpi`。构建脚本会：

1. 编译 `native/dictlookup.m`（arm64 + x86_64 通用二进制）
2. 把它转成 base64 写进 `addon/native/dictlookup.b64.js`
3. 打包 xpi

## 已知限制

- 仅 macOS：依赖 DictionaryServices
- 扫描版 PDF 需要先 OCR，否则没有文字层
- 只对英文单词/短语触发（最多 `maxWords` 个词）

## 许可

MIT
