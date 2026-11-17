# Forum post and reply

Thread: <https://forums.zotero.org/discussion/134807/system-dictionary-lookup-macos-system-dictionary-in-the-readers-selection-popup>

## Part A: revised forum post

For updating the original post or posting again.

**Title:** System Dictionary Lookup: short, paper-aware senses from the macOS dictionary in the selection popup

---

macOS already shows the full dictionary entry for any word in the reader with Cmd-Ctrl-D or a force-click, and if that works for you, you don't need this plugin. It uses the same system dictionaries but changes three things: how the lookup is triggered, how much is shown, and which sense comes first.

1. No shortcut. Selecting a word is the trigger, so there is no key combination to remember, no force-click and no context menu.
2. Less on screen. The native popup is the whole entry (pronunciation, every sense, examples, etymology, derivatives) and covers the text. The plugin shows the IPA and two or three senses inside Zotero's own selection popup.
3. Ranked for the paper. The item's title, abstract, venue, year and authors, plus the words you already looked up in that item, go into one on-device Apple Foundation Models call that puts the likeliest sense first and marks it with a blue dot.

By default the model only picks and orders senses cut out of the dictionary entry, so it cannot add a meaning the entry doesn't have. It is a small model and can be wrong; the second line is often the one you wanted. Only the first homograph is looked up (`bank` has the river sense, not the financial one). Nothing leaves the machine. Without Apple Intelligence the plugin still shows the parsed entry in dictionary order, and ranking can be turned off in the settings.

Requires macOS and Zotero 7+; condensing and ranking need macOS 26+ with Apple Intelligence. The helpers are universal arm64 + x86_64 binaries bundled in the XPI and extracted on first launch.

Repository: <https://github.com/PeberWang/zotero-sysdict-lookup>
Download: <https://github.com/PeberWang/zotero-sysdict-lookup/releases/latest>
License: MIT

中文简介：macOS 用 Cmd-Ctrl-D 或用力点按就能在阅读器里查完整词条，够用就不必装。插件用同一套系统词典，区别在三处：划中即触发，不用记组合键；只给音标加两三条释义，不盖住正文；把当前条目的标题、摘要、期刊和本文查词历史送进同一次端侧模型调用，把这篇论文里最可能的意思排第一并加蓝点。默认只在词条已有义项里挑选排序，不编新义项；小模型可能出错，第二条往往才是你要的。全程离线，不出本机。

---

## Part B: reply to dstillman

> You're right: Cmd-Ctrl-D and force-click already show the full macOS entry in the reader. The plugin isn't meant to add that lookup again but to change what comes back: it opens on selection, shows only the IPA and two or three senses, and puts first the sense that fits the current item, judged from its metadata and the words already looked up in that paper. The native popup can't do that last part. It all runs on device.
