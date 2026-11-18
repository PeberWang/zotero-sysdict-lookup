# Forum post and reply

Thread: https://forums.zotero.org/discussion/134807/system-dictionary-lookup-macos-system-dictionary-in-the-readers-selection-popup

## 直接复制这几行

下面三块是投递正文。整段复制，不要带上本文件的标题、说明、字段名或任何符号。粘贴前跑一次：bash ~/Desktop/Code工作区/audit/paste-check.sh /Users/mingpeiwang/Desktop/Code工作区/zotero-sysdict-lookup/docs/forum-post.md，除标题行外应当零命中。

### 1. 帖子正文（英文，两段）

Title 字段填这一行（不要复制下面的说明文字）：

System Dictionary Lookup: short, paper-aware senses from the macOS dictionary in the selection popup

正文从这里开始复制：

macOS already shows the full dictionary entry for any word in the reader with Cmd-Ctrl-D or a force-click, and if that works for you, you don't need this plugin. It uses the same system dictionaries and changes three things. You select a word instead of pressing keys, so there is no shortcut to remember and no context menu. You get the IPA and two or three senses inside Zotero's own popup, not the whole entry with examples, etymology and derivatives. And the sense that fits this paper comes first: the item's title, abstract, venue, year and authors, plus the words you already looked up in that item, go into one on-device Apple Foundation Models call that marks the likeliest sense with a blue dot.

By default the model only picks and orders senses cut out of the dictionary entry, so it cannot add a meaning the entry doesn't have. It is a small model and can be wrong, and the second line is often the one you wanted. Only the first homograph is looked up, so bank gives the river sense and not the financial one. Nothing leaves the machine. Without Apple Intelligence the parsed entry is shown in dictionary order, and ranking can be turned off in the settings. It needs macOS and Zotero 7 or later, and condensing and ranking need macOS 26 or later with Apple Intelligence. Repository and download: https://github.com/PeberWang/zotero-sysdict-lookup，MIT 许可，通用 arm64 与 x86_64 助手已打进 XPI。

### 2. 帖子正文（中文，两段）

标题字段：划词查系统词典：只显示两三条释义，并按这篇论文排序

正文从这里开始复制：

macOS 自带的 Cmd-Ctrl-D 或用力点按已经能在阅读器里显示完整词条，够用就不必装这个插件。它用同一套系统词典，改的是三件事。划中单词就能查，不用记快捷键。只显示音标加两三条释义，不是带例句、词源、派生词的整条。并且把这篇论文里最可能的意思排在前面，用蓝点标出来。

排序用的是当前条目的标题、摘要、期刊、年份、作者，以及你在这条文献里查过的词，送进一次端侧模型调用。默认只让它从词条已有的义项里挑选排序，不会编出新意思。模型很小，可能出错，第二条往往才是你要的。只查第一个同形异义，所以 bank 给的是河岸那一义。全程不出本机。没有 Apple Intelligence 时按词典顺序显示，排序也可以关掉。需要 macOS 与 Zotero 7 以上，压缩与排序需要 macOS 26 以上并开启 Apple Intelligence。仓库与下载：https://github.com/PeberWang/zotero-sysdict-lookup，MIT 许可，arm64 与 x86_64 助手随 XPI 一起发布。

### 3. 回复 dstillman（英文，两段）

正文从这里开始复制：

Fair point, and I should have said this in the original post: this does not replace Cmd-Ctrl-D, and it is not for people who are happy with it. What it adds is this. It stays inside Zotero, so you never leave the page you are reading. It is condensed: IPA plus two or three senses instead of the whole entry, with the rest stripped, done on device with Apple Foundation Models, and shown in dictionary order when Apple Intelligence is off. It also handles partial selections, so colossa resolves to colossal when the completion is unambiguous.

The person I built it for reads academic PDFs in a second language, where the cost is not looking up a word but reading a long English entry five times a page. If your habit is Cmd-Ctrl-D and the full entry is useful to you, you are right that a plugin adds nothing. I would take a view on this: do you read the inline condensation as noise, or would a two-senses-then-click-to-expand version be more honest to the dictionary? I would rather change the default than defend it.

## 事故与废弃写法

2026-11-17 发到论坛的那条回复，正文整段被一对英文双引号包住，六处换行写成了反斜杠加 n 的两连形式，内层引号写成了反斜杠加双引号，全条共十四个反斜杠。线上只显示成一行，读起来是「一串反斜杠和字母 n」。上面第 3 块是重出的干净版，字段里不要出现任何引号包裹。

同时确认：同一线程的原帖（两天前那条）字符是干净的，换行是平台正常生成的折行，链接是平台自动识别成超链接的，符号层面没有问题；本地这份草稿也没有反斜杠。问题只出在那条回复从生成到粘贴这一层。

## 为什么不在 Markdown 里存旧稿

旧版这里用编号列表列三个卖点、用尖括号包链接、用反引号包单词 bank。这些标记在论坛里可能被渲染，也可能原样显示；一旦原样显示就是符号垃圾。现在统一改成纯文本：卖点并进句子，链接写成裸网址，单词不加反引号。上一版的英文三段稿与三点编号稿已删除，不再保留，避免有人错拿。
