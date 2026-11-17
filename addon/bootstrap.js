// Zotero 划词弹窗 → macOS 系统词典（DictionaryServices）+ 端侧模型精简
//
// 流程：
//   1. dictlookup 取苹果词典原文（毫秒级），拆成词头 / 音标 / 简明释义
//   2. 先渲染精简版（音标 + 中文义项），不阻塞
//   3. 后台调 dictsummary（Apple Foundation Models 端侧模型）压成 2–3 条精简英文义项；
//      模型不可用时保留第 2 步的解析结果，版式不变
//   4. 有语境时（当前文献元数据 / 本文划词历史），第 3 步改为同一次调用里按语境重排，
//      首条加轻标记；失败时同样保持已显示的内容。详见 docs/context-rank.md
//
// 词典与模型都在本机，不联网。

"use strict";

var PLUGIN_ID = "sysdict-lookup@mingpei.local";
var PREFIX = "extensions.zotero.sysdict.";
var registered = false;
var helperB64 = { dictlookup: null, dictsummary: null };

/* ---------------- 基础工具 ---------------- */

function baseDir() {
    var home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).clone();
    home.appendRelativePath("Library/Application Support/Zotero/sysdict");
    return home;
}

function log(msg) {
    try { Zotero.debug("[sysdict] " + msg); } catch (e) {}
    try {
        var dir = baseDir();
        if (!dir.exists()) dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
        var file = dir.clone();
        file.append("lookup.log");
        var stream = Components.classes["@mozilla.org/network/file-output-stream;1"]
            .createInstance(Components.interfaces.nsIFileOutputStream);
        stream.init(file, 0x02 | 0x10 | 0x08, 0o644, 0);
        var line = new Date().toISOString() + " " + msg + "\n";
        var bytes = unescape(encodeURIComponent(line));
        stream.write(bytes, bytes.length);
        stream.close();
    } catch (e) {}
}

function pref(key, fallback) {
    try {
        // 第二个参数 true：按完整键名读取。不传时 Zotero 会再拼一次 extensions.zotero.，
        // 0.4.0 之前因此读的是 extensions.zotero.extensions.zotero.sysdict.*，README 里的偏好都不生效
        var value = Zotero.Prefs.get(PREFIX + key, true);
        return value === undefined || value === null || value === "" ? fallback : value;
    } catch (e) {
        return fallback;
    }
}


// 首次运行把内置的通用二进制助手释放到 Application Support
function releaseBinary(name, version) {
    var dir = baseDir();
    dir.append("bin");
    if (!dir.exists()) dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);

    var exe = dir.clone();
    exe.append(name);
    var marker = dir.clone();
    marker.append("." + name + ".version");

    try {
        if (exe.exists() && marker.exists() &&
            String(Zotero.File.getContents(marker)).trim() === version) {
            return exe;
        }
    } catch (e) {}

    var b64 = helperB64[name];
    if (!b64) return exe;

    try {
        var binary = atob(b64);
        var out = Components.classes["@mozilla.org/network/file-output-stream;1"]
            .createInstance(Components.interfaces.nsIFileOutputStream);
        out.init(exe, 0x02 | 0x08 | 0x20, 0o755, 0);
        out.write(binary, binary.length);
        out.close();
        exe.permissions = 0o755;
        Zotero.File.putContents(marker, version);
        log("已释放内置助手 " + name);
    } catch (e) {
        log("释放 " + name + " 失败：" + e);
    }
    return exe;
}

function helperFile(name) {
    var override = pref(name + "Path", "");
    if (override) {
        var file = Components.classes["@mozilla.org/file/local;1"]
            .createInstance(Components.interfaces.nsIFile);
        file.initWithPath(override);
        return file;
    }
    var dir = baseDir();
    dir.appendRelativePath("bin");
    dir.append(name);
    return dir;
}

function openExternal(url) {
    return Zotero.Utilities.Internal.subprocess("/usr/bin/open", [url])
        .catch(function (e) { log("open 失败：" + url + " -> " + e); });
}

// 英文释义沿用旧文件名（已有缓存继续可用）；其他语言加后缀，非 ASCII 词用编码避免撞名
function cacheFile(word, lang) {
    var dir = baseDir();
    dir.append("cache");
    if (!dir.exists()) dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
    var file = dir.clone();
    var base = /^[\x00-\x7f]*$/.test(word)
        ? word.toLowerCase().replace(/[^a-z'\-]/g, "_")
        : encodeURIComponent(word).replace(/%/g, "");
    file.append(base + (lang && lang !== "en" ? "@" + lang : "") + ".json");
    return file;
}

/* ---------------- 语境：当前文献元数据 + 本文划词历史 ---------------- */

var HISTORY_MAX_WORDS = 50;
var HISTORY_MAX_AGE = 30 * 24 * 3600 * 1000;
var HISTORY_SEND = 12;               // 传给模型的最近词数，与 dictsummary 的 Budget.historyWords 一致
var RANK_CACHE_TTL = 10 * 60 * 1000;
var RANK_CACHE_MAX = 200;
var SUMMARY_TIMEOUT = 8000;          // JS 侧兜底；dictsummary 自身 6 秒超时
var FALLBACK_TIMEOUT = 3500;         // 兜底模型调用：dictsummary 自身 3 秒超时，JS 侧再留余量

var historyCache = new Map();        // itemID -> [{ w, ts }]，按时间顺序
var rankCache = new Map();           // word|itemID|历史尾部 -> { senses, ts }

function historyFile(itemID) {
    var dir = baseDir();
    dir.append("history");
    if (!dir.exists()) dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
    var file = dir.clone();
    file.append(String(itemID).replace(/[^0-9A-Za-z_-]/g, "_") + ".json");
    return file;
}

function pruneHistory(list) {
    var cutoff = Date.now() - HISTORY_MAX_AGE;
    var kept = (list || []).filter(function (h) { return h && h.w && h.ts > cutoff; });
    return kept.slice(-HISTORY_MAX_WORDS);
}

function loadHistory(itemID) {
    if (historyCache.has(itemID)) return historyCache.get(itemID);
    var list = [];
    try {
        var file = historyFile(itemID);
        if (file.exists()) list = pruneHistory(JSON.parse(Zotero.File.getContents(file)));
    } catch (e) {}
    historyCache.set(itemID, list);
    return list;
}

function recordHistory(itemID, word) {
    try {
        var key = word.toLowerCase();
        var list = loadHistory(itemID).filter(function (h) { return h.w.toLowerCase() !== key; });
        list.push({ w: word, ts: Date.now() });
        list = pruneHistory(list);
        historyCache.set(itemID, list);
        Zotero.File.putContentsAsync(historyFile(itemID).path, JSON.stringify(list))
            .catch(function (e) { log("写历史失败：" + e); });
    } catch (e) {
        log("记录历史失败：" + e);
    }
}

// 启动后清理一次：过期条目剔除，空文件删除
function cleanHistoryDir() {
    try {
        var dir = baseDir();
        dir.append("history");
        if (!dir.exists()) return;
        var entries = dir.directoryEntries;
        while (entries.hasMoreElements()) {
            var file = entries.getNext().QueryInterface(Components.interfaces.nsIFile);
            if (!/\.json$/.test(file.leafName)) continue;
            try {
                var list = JSON.parse(Zotero.File.getContents(file));
                var kept = pruneHistory(list);
                if (!kept.length) file.remove(false);
                else if (kept.length !== list.length) Zotero.File.putContents(file, JSON.stringify(kept));
            } catch (e) {
                try { file.remove(false); } catch (e2) {}
            }
        }
    } catch (e) {
        log("清理历史失败：" + e);
    }
}

function field(item, name) {
    try { return String(item.getField(name) || ""); } catch (e) { return ""; }
}

// 只在划词时调用：reader → 附件 → 父条目
function readItemContext(reader) {
    var itemID = reader && reader.itemID;
    if (!itemID) return null;
    var ctx = { itemID: itemID, title: "", abstract: "", journal: "", year: "", authors: "" };
    try {
        var item = Zotero.Items.get(itemID);
        var parent = item && item.parentItem ? item.parentItem : item;
        if (parent && parent.isRegularItem && parent.isRegularItem()) {
            ctx.title = field(parent, "title");
            ctx.abstract = field(parent, "abstractNote");
            ctx.journal = field(parent, "publicationTitle") || field(parent, "proceedingsTitle") ||
                field(parent, "conferenceName") || field(parent, "bookTitle");
            var date = field(parent, "date");
            var parsed = date && Zotero.Date.strToDate(date);
            ctx.year = parsed && parsed.year ? String(parsed.year) : "";
            ctx.authors = (parent.getCreators() || []).slice(0, 3)
                .map(function (c) { return c.lastName || c.name || ""; })
                .filter(Boolean).join("; ");
        }
    } catch (e) {
        log("读取元数据失败：" + e);
    }
    return ctx;
}

function contextHasSignal(ctx) {
    return !!(ctx && (ctx.title || ctx.abstract || ctx.journal || (ctx.history && ctx.history.length)));
}

function rankKey(word, ctx, lang) {
    return [word.toLowerCase(), lang || "en", pref("rankMethod", "candidates"), ctx.itemID,
            ctx.history.slice(-5).join(",").toLowerCase()].join("|");
}

function readRankCache(key) {
    var hit = rankCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > RANK_CACHE_TTL) {
        rankCache.delete(key);
        return null;
    }
    return hit.senses;
}

function writeRankCache(key, senses) {
    rankCache.delete(key);
    rankCache.set(key, { senses: senses, ts: Date.now() });
    while (rankCache.size > RANK_CACHE_MAX) rankCache.delete(rankCache.keys().next().value);
}

/* ---------------- 解释语言：词典探测 + 选词典（规则见 docs/languages.md） ---------------- */

var DICT_INFO_WAIT = 1500;          // 划词时最多等探测这么久；首次探测约 0.4–0.6 s，之后读缓存约 50 ms
var langScope = null;               // content/lang.js 导出的 SysDictLang
var dictInfo = null;                // dictlookup --list-dictionaries 的结果
var dictInfoPromise = null;

function dictInfoFile() {
    var file = baseDir();
    if (!file.exists()) file.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
    file.append("dictionaries.json");
    return file;
}

// 探测结果由 dictlookup 按「词典集合 + 系统版本」签名缓存在 dictionaries.json；force 时丢弃缓存重探
function loadDictInfo(force) {
    if (dictInfoPromise && !force) return dictInfoPromise;
    var file = helperFile("dictlookup");
    if (!file.exists() || !file.isExecutable()) {
        dictInfoPromise = Promise.resolve(null);
        return dictInfoPromise;
    }
    var cache = dictInfoFile();
    if (force) {
        try { if (cache.exists()) cache.remove(false); } catch (e) {}
    }
    var t0 = Date.now();
    dictInfoPromise = Zotero.Utilities.Internal
        .subprocess(file.path, ["--list-dictionaries", "--json", "--cache", cache.path])
        .then(function (out) {
            var parsed = JSON.parse(out);
            dictInfo = parsed && parsed.dictionaries ? parsed : null;
            if (dictInfo) {
                log("词典探测：" + dictInfo.dictionaries.length + " 本可用，" +
                    (dictInfo.cached ? "读缓存" : "重新探测 " + dictInfo.probeMs + " ms") +
                    "，总耗时 " + (Date.now() - t0) + " ms");
            }
            return dictInfo;
        })
        .catch(function (e) {
            log("词典探测失败：" + e);
            dictInfo = null;
            return null;
        });
    return dictInfoPromise;
}

function waitDictInfo() {
    if (dictInfo) return Promise.resolve(dictInfo);
    var timer = Zotero.Promise.delay(DICT_INFO_WAIT).then(function () { return null; });
    return Promise.race([loadDictInfo(false), timer]);
}

function hanLookupAvailable() {
    return !!(dictInfo && dictInfo.dictionaries.some(function (d) { return d.han; }));
}

function userOrder() {
    return prefList("order");
}

function prefList(key) {
    return String(pref(key, "")).split("|")
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
}

// 每次划词现读偏好：面板里改了立即生效，不用重启
function langOptions() {
    return {
        targetPref: pref("targetLang", "auto"),
        sameLanguageOnly: !!pref("sameLanguageOnly", false),
        systemLanguages: dictInfo ? dictInfo.systemLanguages || [] : [],
        dictionaries: dictInfo ? dictInfo.dictionaries : [],
        signature: dictInfo ? dictInfo.signature : "",
        userOrder: userOrder(),
        scope: prefList("dictScope"),
        fallback: !!pref("fallback", false)
    };
}

// 兜底结果都与语境相关：只放内存，键含 itemID 与历史尾部，10 分钟过期，从不写盘
var fallbackCache = new Map();

function ctxKey(ctx) {
    if (!ctx) return "noitem|";
    return ctx.itemID + "|" + (ctx.history || []).slice(-5).join(",").toLowerCase();
}

function readFallbackCache(key) {
    var hit = fallbackCache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > RANK_CACHE_TTL) {
        fallbackCache.delete(key);
        return undefined;
    }
    return hit.value;
}

function writeFallbackCache(key, value) {
    fallbackCache.delete(key);
    fallbackCache.set(key, { value: value, ts: Date.now() });
    while (fallbackCache.size > RANK_CACHE_MAX) fallbackCache.delete(fallbackCache.keys().next().value);
}

function contextArgs(ctx) {
    var args = [];
    if (!ctx) return args;
    if (ctx.title) args.push("--title", ctx.title);
    if (ctx.abstract) args.push("--abstract", ctx.abstract);
    if (ctx.journal) args.push("--journal", ctx.journal);
    if (ctx.year) args.push("--year", ctx.year);
    if (ctx.authors) args.push("--authors", ctx.authors);
    if (ctx.history && ctx.history.length) args.push("--history", ctx.history.join(","));
    return args;
}

// 兜底 A：dictsummary --convert-to，按语境把词换成语言 L 的一个词；失败、超时返回 null
function convertWord(word, lang, ctx) {
    var key = ["A", word.toLowerCase(), lang, ctxKey(ctx)].join("|");
    var cached = readFallbackCache(key);
    if (cached !== undefined) return Promise.resolve(cached);
    var file = helperFile("dictsummary");
    if (!file.exists() || !file.isExecutable()) return Promise.resolve(null);
    var call = Zotero.Utilities.Internal
        .subprocess(file.path, ["--word", word, "--convert-to", lang, "--timeout", "3"].concat(contextArgs(ctx)))
        .then(function (out) {
            var parsed = JSON.parse(out);
            if (!parsed || !parsed.available || !parsed.converted) {
                log("兜底 A 换词失败：" + word + " → " + lang + "：" + (parsed && parsed.reason));
                return null;
            }
            return parsed.converted;
        })
        .catch(function (e) { log("兜底 A 换词出错：" + e); return null; });
    var timer = Zotero.Promise.delay(FALLBACK_TIMEOUT).then(function () { return null; });
    return Promise.race([call, timer]).then(function (converted) {
        writeFallbackCache(key, converted);
        return converted;
    });
}

/* ---------------- 划词补全：条目全文索引 ----------------
 * Zotero 7 没有 Fulltext.getItemContent；全文在附件存储目录的 .zotero-ft-cache（Fulltext.getItemCacheFile），
 * OCR 过并被索引的 PDF 也有。只在需要补全时读一次，按 itemID 缓存词形索引（最多 3 篇），不做后台轮询 */
var FULLTEXT_CACHE_MAX = 3;
var fulltextCache = new Map();      // itemID → Promise<index|null>

function getFulltextIndex(itemID) {
    if (!itemID || !langScope) return Promise.resolve(null);
    if (fulltextCache.has(itemID)) return fulltextCache.get(itemID);
    var t0 = Date.now();
    var pending = Promise.resolve().then(function () {
        var item = Zotero.Items.get(itemID);
        if (!item || !Zotero.Fulltext || typeof Zotero.Fulltext.getItemCacheFile !== "function") return null;
        var file = Zotero.Fulltext.getItemCacheFile(item);
        if (!file || !file.exists()) return null;
        return Zotero.File.getContentsAsync(file.path).then(function (text) {
            var index = langScope.buildTextIndex(String(text || ""));
            log("全文索引：item " + itemID + "，" + String(text || "").length + " 字符，" + index.pageCount + " 页，" +
                index.tokens + " 个词形，用时 " + (Date.now() - t0) + " ms");
            return index;
        });
    }).catch(function (e) {
        log("读取全文失败：" + e);
        return null;
    });
    fulltextCache.set(itemID, pending);
    while (fulltextCache.size > FULLTEXT_CACHE_MAX) fulltextCache.delete(fulltextCache.keys().next().value);
    return pending;
}

/* ---------------- 选区清洗 ---------------- */

var HAN_MAX_CHARS = 8;

function normalizeSelection(raw) {
    var text = String(raw || "");

    // 汉字选区：去掉空白、标点与非汉字，PDF 抽取的中文常带断行空格
    if (/[\u3400-\u9fff]/.test(text)) {
        return text.replace(/[^\u3400-\u9fff]/g, "");
    }

    var ligatures = { "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st" };
    text = text.replace(/[\ufb00-\ufb06]/g, function (c) { return ligatures[c] || c; });
    text = text.replace(/\u00ad/g, "");
    text = text.replace(/[\u2010\u2011\u2012\u2013]/g, "-");
    text = text.replace(/[\u2018\u2019\u02bc]/g, "'");
    text = text.replace(/([A-Za-z])-\s*[\r\n]+\s*([a-z])/g, "$1$2");
    text = text.replace(/([A-Za-z]{2,})- +([a-z]{2,})/g, "$1$2");
    text = text.replace(/[\s\u00a0]+/g, " ").trim();
    text = text.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "");
    text = text.replace(/'s$/i, "");
    return text;
}

function isLookupable(word) {
    if (!word) return false;
    if (/^[\u3400-\u9fff]+$/.test(word)) return word.length <= HAN_MAX_CHARS && hanLookupAvailable();
    var tokens = word.split(" ").filter(function (t) { return t; });
    var maxWords = parseInt(pref("maxWords", 3), 10) || 3;
    if (!tokens.length || tokens.length > maxWords) return false;
    return tokens.every(function (t) { return /^[A-Za-z][A-Za-z'\-]*$/.test(t); });
}

/* ---------------- 样式 ---------------- */

var PANEL_WIDTH = 320;

var CSS = [
    ".sysdict-panel{font-family:-apple-system,'SF Pro Text',system-ui,sans-serif;font-size:12.5px;line-height:1.5;",
    "color:#1d1d1f;padding:8px 10px 9px;margin-top:6px;border-top:1px solid rgba(0,0,0,.10);",
    "text-align:left;white-space:normal;user-select:text;overflow-y:auto;}",
    ".sysdict-panel *{box-sizing:border-box;}",
    "@media (prefers-color-scheme:dark){.sysdict-panel{color:#e8e8ed;border-top-color:rgba(255,255,255,.15);}}",
    ".sysdict-head{margin-bottom:5px;}",
    ".sysdict-word{font-weight:600;font-size:13px;}",
    ".sysdict-ipa{font-size:12px;opacity:.65;}",
    ".sysdict-senses{margin:0;}",
    ".sysdict-sense{margin:0 0 3px;padding-left:9px;text-indent:-9px;}",
    ".sysdict-sense:before{content:'\\2022\\00a0';opacity:.5;}",
    // 每条义项最多两行：字符预算按词边界截断（lang.js truncateSense），CSS 再兜底，防宽字母超出
    ".sysdict-senses .sysdict-sense{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}",
    ".sysdict-sense-top:before{color:#0a84ff;opacity:1;}",
    ".sysdict-badge{margin-left:6px;font-size:10px;color:#0a84ff;opacity:.85;white-space:nowrap;}",
    ".sysdict-completion{font-size:10.5px;margin-top:6px;padding:4px 6px;border-radius:5px;background:rgba(10,132,255,.10);}",
    ".sysdict-hint{font-size:10.5px;opacity:.45;margin-top:5px;}",
    ".sysdict-status{font-size:11.5px;opacity:.75;}",
    ".sysdict-fallback{font-size:10.5px;margin-top:6px;padding:4px 6px;border-radius:5px;background:rgba(255,159,10,.12);}",
    ".sysdict-link{font:inherit;font-size:10.5px;margin-left:6px;padding:0 5px;border-radius:4px;",
    "border:1px solid rgba(0,0,0,.18);background:transparent;color:inherit;cursor:pointer;}",
    ".sysdict-original{margin-top:4px;opacity:.75;}",
    ".sysdict-menu{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;}",
    ".sysdict-menu .sysdict-hint{flex-basis:100%;margin-top:2px;}",
    ".sysdict-menu .sysdict-original{flex-basis:100%;max-height:120px;overflow-y:auto;font-size:11px;}",
    ".sysdict-foot{margin-top:8px;display:flex;align-items:center;gap:8px;}",
    ".sysdict-btn{font:inherit;font-size:11px;line-height:1.3;padding:3px 8px;border-radius:6px;",
    "border:1px solid rgba(0,0,0,.18);background:transparent;color:inherit;cursor:pointer;}",
    "@media (prefers-color-scheme:dark){.sysdict-btn{border-color:rgba(255,255,255,.22);}}",
    ".sysdict-btn:hover{background:rgba(0,0,0,.05);}"
].join("");

function injectStyle(doc) {
    if (doc.getElementById("sysdict-style")) return;
    var style = doc.createElement("style");
    style.id = "sysdict-style";
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
}

/* ---------------- 取词 ---------------- */

// order 为数组时按它查（解释语言决策给出），stopAtLang 让 dictlookup 命中目标语言即停；
// 否则沿用旧行为（偏好 order 或 dictlookup 默认顺序）
function runHelper(word, order, stopAtLang) {
    var file = helperFile("dictlookup");
    if (!file.exists() || !file.isExecutable()) {
        throw new Error("词典助手缺失：" + file.path);
    }

    var args = [word];
    if (order && order.length) {
        args.push("--order", order.join("|"));
        if (stopAtLang) args.push("--stop-at-lang", stopAtLang);
        // 探测缓存里有每本词典的语言对，释义语言按它判定
        args.push("--cache", dictInfoFile().path);
    } else if (pref("order", "")) {
        args.push("--order", pref("order", ""));
    }

    var internal = Zotero.Utilities && Zotero.Utilities.Internal;

    if (internal && typeof internal.subprocess === "function") {
        return internal.subprocess(file.path, args).then(function (out) {
            return JSON.parse(out);
        });
    }

    var tmp = Services.dirsvc.get("TmpD", Components.interfaces.nsIFile).clone();
    tmp.append("sysdict-" + Date.now() + ".json");
    return internal.exec(file.path, args.concat(["--out", tmp.path]))
        .then(function () { return Zotero.File.getContentsAsync(tmp.path); })
        .then(function (contents) {
            try { tmp.remove(false); } catch (e) {}
            return JSON.parse(contents);
        });
}

// ctx 为空：只压义项，返回 { summary, ranked:false }
// ctx 非空：同一次调用里压义项并按语境重排，返回 { senses, ranked:true }
// 任何失败都返回 null，调用方保持原有显示
// transcribe 为真：兜底 B，把非目标语言的释义转写成 lang（dictsummary 3 秒超时）
function summarize(word, raw, ctx, lang, transcribe) {
    var file = helperFile("dictsummary");
    if (!file.exists() || !file.isExecutable()) return Promise.resolve(null);
    if (!raw) return Promise.resolve(null);

    var args = ["--word", word, "--raw", raw];
    if (lang && lang !== "en") args.push("--target-lang", lang);
    if (transcribe) args.push("--transcribe");
    // 语境排序默认用候选法（A）；偏好 rankMethod=onestep 时改用整段原文一步生成（C），依据见 bench/report.md
    if (ctx && !transcribe && pref("rankMethod", "candidates") === "onestep") args.push("--rank-method", "onestep");
    args = args.concat(contextArgs(ctx));

    // 模型输出按同一套规则校验（lang.js validateSenses）：不合格带原因重试一次，仍不合格退回规则层（返回 null，
    // 弹窗保持词典义项经显示层清理后的样子）。重试只能用第一次剩下的时间，总耗时不超过原来的上限
    var budget = transcribe ? FALLBACK_TIMEOUT : SUMMARY_TIMEOUT;
    var deadline = Date.now() + budget;
    var once = function (feedback, previous) {
        var remaining = deadline - Date.now();
        if (remaining < 1200) return Promise.resolve(null);
        var a = args.slice();
        if (feedback) {
            a.push("--feedback", feedback, "--previous", previous || "",
                   "--timeout", String(Math.max(1, Math.floor(remaining / 1000) - 0.5)));
        }
        var call = Zotero.Utilities.Internal
            .subprocess(file.path, a)
            .then(function (out) {
                var parsed = JSON.parse(out);
                if (!parsed || !parsed.available) {
                    if (parsed && parsed.reason) log("dictsummary 未返回：" + parsed.reason);
                    return null;
                }
                return parsed;
            })
            .catch(function (e) {
                log("dictsummary 失败：" + e);
                return null;
            });
        var timer = Zotero.Promise.delay(remaining).then(function () { return null; });
        return Promise.race([call, timer]);
    };
    if (!langScope) return once(null, null);

    var lastParsed = null;
    var callForValidation = function (feedback, previous) {
        return once(feedback, previous).then(function (parsed) {
            lastParsed = parsed;
            if (!parsed) return null;
            var senses = parsed.senses && parsed.senses.length ? parsed.senses
                : String(parsed.summary || "").split(/[;；]\s*/).filter(Boolean);
            return { senses: senses, raw: parsed.summary || senses.join("; "), parsed: parsed };
        });
    };
    // 候选法在非英文目标下只回字母、显示词典原文，不是模型写的文字，不做校验
    return once(null, null).then(function (first) {
        if (!first || (first.method === "candidates" && lang && lang !== "en")) return first;
        var used = false;
        var injected = function (feedback, previous) {
            if (!used) {
                used = true;
                var senses = first.senses && first.senses.length ? first.senses
                    : String(first.summary || "").split(/[;；]\s*/).filter(Boolean);
                lastParsed = first;
                return Promise.resolve({ senses: senses, raw: first.summary || senses.join("; "), parsed: first });
            }
            return callForValidation(feedback, previous);
        };
        var mode = transcribe ? "transcribe" : ctx ? (first.method || "onestep") : "condense";
        return langScope.validatedGeneration(injected, { lang: lang || "en", raw: raw, word: word, mode: mode })
            .then(function (v) {
                log("[validate] " + JSON.stringify(v.log));
                if (v.status === "pass" || v.status === "retry-pass") return lastParsed;
                return null;   // 两次都不合格：退回规则层
            });
    });
}

function readCachedSummary(word, lang) {
    try {
        var file = cacheFile(word, lang);
        if (!file.exists()) return null;
        var data = JSON.parse(Zotero.File.getContents(file));
        return data && data.summary ? data.summary : null;
    } catch (e) {
        return null;
    }
}

function writeCachedSummary(word, summary, raw, lang) {
    try {
        Zotero.File.putContents(cacheFile(word, lang), JSON.stringify({
            summary: summary,
            rawLength: raw ? raw.length : 0,
            ts: Date.now()
        }));
    } catch (e) {}
}

/* ---------------- 面板 ---------------- */

function pickEnglish(data) {
    var entries = (data && data.entries) || [];
    var english = null;
    entries.forEach(function (entry) {
        if (!english && /New Oxford|Oxford Dictionary of English/.test(entry.dict)) english = entry;
    });
    return { entries: entries, english: english };
}

function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

function buildPanel(doc, word) {
    var panel = doc.createElement("div");
    panel.className = "sysdict-panel";
    panel.style.width = PANEL_WIDTH + "px";

    var viewHeight = (doc.defaultView && doc.defaultView.innerHeight) || 800;
    panel.style.maxHeight = Math.max(150, Math.min(280, Math.round(viewHeight * 0.4))) + "px";

    var body = doc.createElement("div");
    body.className = "sysdict-body";
    panel.appendChild(body);

    var foot = doc.createElement("div");
    foot.className = "sysdict-foot";
    var openBtn = doc.createElement("button");
    openBtn.className = "sysdict-btn";
    openBtn.textContent = "词典 App";
    openBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        openExternal("dict://" + encodeURIComponent(word));
    });
    foot.appendChild(openBtn);

    // 「更多」：查词完成后由 fillPanel 填入 state（结果、目标语言）；成功与失败两种状态共用同一套菜单
    var parts = { panel: panel, body: body, foot: foot, openBtn: openBtn, state: null };
    var moreBtn = doc.createElement("button");
    moreBtn.className = "sysdict-btn";
    moreBtn.textContent = "更多…";
    moreBtn.setAttribute("data-action", "more");
    var menu = null;
    moreBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        if (menu) {
            menu.remove();
            menu = null;
            return;
        }
        if (!parts.state || !langScope) return;
        var st = parts.state;
        var view = langScope.statusView(st.result, word, st.dictionaries);
        menu = renderMoreMenu(doc, body, view.buttons[1].items, st.result.data, word, st.target);
        panel.insertBefore(menu, foot);
    });
    foot.appendChild(moreBtn);
    parts.moreBtn = moreBtn;
    panel.appendChild(foot);

    return parts;
}

// 非 Oxford 英文格式的词条（中文、双语词典）：按 ①② / 数字编号 / • 粗切，去掉 ▸ 例句与词性标签，
// 切不出来就截取整段，保证至少有内容可显示
function looseSenses(text) {
    var bars = String(text || "").split(" | ");
    var body = bars.length >= 3 ? bars.slice(2).join(" ") : bars[bars.length - 1];
    var pieces = body.split(/[\u2460-\u2473]|(?:^|\s)\d{1,2}\s|\s\u2022\s/);
    if (pieces.length > 1) pieces.shift();          // 第一个标记之前是词头、拼音、词性
    var senses = pieces.map(function (p) {
        return p.split(/[\u25b8\u25b6]/)[0]
            .replace(/〔[^〕]*〕|［[^］]*］|\[[^\]]*\]/g, "")
            .replace(/^\s*(?:[A-Z]\.\s*)?(?:noun|verb|adjective|adverb|uncountable|countable|n\.|v\.|adj\.)\s*/i, "")
            .replace(/^\s*[名动動形副量代连連介助叹嘆拟擬数數]\s+/, "")
            .split(/[。；]/)[0]
            .trim();
    }).filter(function (p) { return p.length > 0; });
    if (!senses.length) senses = [body.trim()];
    return senses.slice(0, 3).map(function (p) { return p.length > 60 ? p.slice(0, 59) + "…" : p; });
}

// entry 由调用方选好；loose 为真时不用 dictlookup 针对 Oxford 英文词条的结构化切分
function renderCompact(doc, body, word, data, entry, loose, note) {
    body.textContent = "";

    if (!entry) {
        body.appendChild(el(doc, "div", "sysdict-hint", "未收录「" + word + "」"));
        return;
    }

    var head = el(doc, "div", "sysdict-head");
    head.appendChild(el(doc, "span", "sysdict-word", data.word || word));
    if (entry.ipa) head.appendChild(el(doc, "span", "sysdict-ipa", " /" + entry.ipa.replace(/^\/|\/$/g, "") + "/"));
    body.appendChild(head);

    var list = el(doc, "div", "sysdict-senses");
    // 义项编号统一剥离（1 / ① / (1) / a. …），剥完为空或只剩数字的条目丢弃
    var senses = loose || !(entry.senses && entry.senses.length)
        ? (langScope ? langScope.entrySenses(entry.text) : looseSenses(entry.text))
        : (langScope ? langScope.cleanSenses(entry.senses) : entry.senses);
    if (!senses.length) senses = langScope ? langScope.entrySenses(entry.text) : looseSenses(entry.text);
    senses.slice(0, 3).forEach(function (sense) {
        list.appendChild(el(doc, "div", "sysdict-sense", sense));
    });
    body.appendChild(list);

    // dictlookup 的末字母补全在 0.4.0 起由 showResult 的补全说明行明示；旧逻辑（探测失败）仍用这一行
    if (data.completedFrom && !langScope) {
        body.appendChild(el(doc, "div", "sysdict-hint", "选区「" + data.completedFrom + "」"));
    }
    if (note) body.appendChild(el(doc, "div", "sysdict-hint", note));

    return { list: list, englishRaw: entry.text || "" };
}

function stopped(handler) {
    return function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        handler(ev);
    };
}

function openSettings() {
    try {
        Zotero.Utilities.Internal.openPreferences("sysdict-prefpane");
    } catch (e) {
        log("打开设置失败：" + e);
    }
}

// 失败、无词典、语言不符等状态：提示（跟随目标语言）+ 按钮栏「词典 App」「更多」，不静默回退。
// view 由 lang.js 的 statusView() 给出；按钮直接画在提示下方，不依赖面板底部，长提示也不会把按钮挤出可视区
function renderStatusView(doc, body, view, data, word, target) {
    body.textContent = "";
    body.appendChild(el(doc, "div", "sysdict-status", view.message));

    var bar = el(doc, "div", "sysdict-foot sysdict-status-foot");
    var menu = null;
    view.buttons.forEach(function (b) {
        var btn = el(doc, "button", "sysdict-btn", b.label);
        btn.setAttribute("data-action", b.id);
        if (b.href) btn.setAttribute("data-href", b.href);
        if (b.id === "dictapp") {
            btn.addEventListener("click", stopped(function () { openExternal(b.href); }));
        } else if (b.id === "more") {
            btn.addEventListener("click", stopped(function () {
                if (menu) {
                    menu.remove();
                    menu = null;
                    return;
                }
                menu = renderMoreMenu(doc, body, b.items, data, word, target);
                body.appendChild(menu);
            }));
        }
        bar.appendChild(btn);
    });
    body.appendChild(bar);
    return bar;
}

// 「更多」：手动指定用哪本词典查 / 查看原文释义 / 打开本插件设置
function renderMoreMenu(doc, body, items, data, word, target) {
    var menu = el(doc, "div", "sysdict-menu");
    var entries = (data && data.entries) || [];
    items.forEach(function (item) {
        if (item.id === "pick") {
            menu.appendChild(el(doc, "div", "sysdict-hint", item.label));
            if (!item.dictionaries.length) menu.appendChild(el(doc, "div", "sysdict-hint", item.emptyLabel));
            item.dictionaries.forEach(function (name) {
                var b = el(doc, "button", "sysdict-link", name);
                b.setAttribute("data-action", "pick");
                b.addEventListener("click", stopped(function () {
                    var entry = entries.filter(function (e) { return e.dict === name; })[0];
                    if (!entry) return;
                    // 用户手动指定：按该词典原文显示，并标明释义语言
                    var keep = body.querySelector(".sysdict-status-foot");
                    renderCompact(doc, body, word, data, entry, entry.explains !== "en",
                        entry.dict + " " + langScope.explainedIn(entry.explains, target));
                    if (keep) body.appendChild(keep);
                }));
                menu.appendChild(b);
            });
        } else if (item.id === "original" && item.available) {
            var o = el(doc, "button", "sysdict-link", item.label);
            o.setAttribute("data-action", "original");
            o.addEventListener("click", stopped(function () {
                var text = String(entries[0].text || "");
                menu.appendChild(el(doc, "div", "sysdict-original", text.length > 800 ? text.slice(0, 799) + "…" : text));
            }));
            menu.appendChild(o);
        } else if (item.id === "settings") {
            var st = el(doc, "button", "sysdict-link", item.label);
            st.setAttribute("data-action", "settings");
            st.addEventListener("click", stopped(openSettings));
            menu.appendChild(st);
        }
    });
    return menu;
}

// 模型结果：分号分隔的短义项，替换掉解析出来的那几条
function applySenses(doc, listEl, text) {
    var parts = String(text || "").split(/[;；]\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (langScope) parts = langScope.cleanSenses(parts);
    if (!parts.length) return;
    listEl.textContent = "";
    parts.slice(0, 3).forEach(function (sense) {
        listEl.appendChild(el(doc, "div", "sysdict-sense", sense));
    });
}

function senseWords(text) {
    var t = String(text).toLowerCase();
    var latin = t.split(/[^a-z]+/).filter(function (w) { return w.length > 3; });
    var han = (t.match(/[\u3400-\u9fff]/g) || []).filter(function (c) { return "的是或和与及等之".indexOf(c) < 0; });
    return latin.concat(han);
}

function similar(a, b) {
    var wa = senseWords(a), wb = senseWords(b);
    if (!wa.length || !wb.length) return false;
    var hits = wa.filter(function (w) { return wb.indexOf(w) >= 0; }).length;
    return hits / Math.min(wa.length, wb.length) >= 0.5;
}

// 语境重排结果：模型给出 1–3 条，首条加轻标记；不足三条时用当前显示的（上下文无关）义项补齐
// 首选的含义写在弹窗里（小字标签），不再只靠悬停提示
function applyRanked(doc, listEl, senses, lang) {
    if (langScope) senses = langScope.cleanSenses(senses);
    if (!senses || !senses.length) return;
    var current = Array.prototype.map.call(listEl.children, function (n) { return n.textContent; });
    var shown = senses.slice(0, 3);
    current.forEach(function (sense) {
        if (shown.length >= 3) return;
        if (!shown.some(function (s) { return similar(s, sense); })) shown.push(sense);
    });
    listEl.textContent = "";
    shown.forEach(function (sense, i) {
        var node = el(doc, "div", i === 0 ? "sysdict-sense sysdict-sense-top" : "sysdict-sense", sense);
        if (i === 0) {
            var badge = el(doc, "span", "sysdict-badge", langScope ? langScope.topBadge(lang || "en") : "按语境首选");
            node.appendChild(badge);
        }
        listEl.appendChild(node);
    });
}

// 兜底说明行：明示发生了什么；A 可一键在词典 App 里查原词，B 可展开原文释义
function renderFallbackNotice(doc, body, result, originalSenses) {
    var f = result.fallback;
    if (!f) return null;
    var box = el(doc, "div", "sysdict-fallback");
    box.appendChild(el(doc, "span", "", langScope.fallbackNotice(result)));
    var labels = langScope.buttonLabels(f.target);
    var btn = el(doc, "button", "sysdict-link", f.kind === "A" ? labels.lookupOriginal : labels.originalButton);
    var extra = null;
    btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        if (f.kind === "A") {
            openExternal("dict://" + encodeURIComponent(f.originalWord));
            return;
        }
        if (extra) {
            extra.remove();
            extra = null;
            return;
        }
        extra = el(doc, "div", "sysdict-original");
        (originalSenses || []).forEach(function (s) { extra.appendChild(el(doc, "div", "sysdict-sense", s)); });
        box.appendChild(extra);
    });
    box.appendChild(btn);
    body.appendChild(box);
    return box;
}

// 补全说明行：明说补全了什么，划词原文保留可点开（在词典 App 里直查原词）
function renderCompletionNotice(doc, body, result) {
    var c = result.completion;
    var box = el(doc, "div", "sysdict-completion");
    box.appendChild(el(doc, "span", "", langScope.completionNotice(result)));
    var labels = langScope.buttonLabels(result.lang);
    var btn = el(doc, "button", "sysdict-link", labels.lookupOriginal + " \u201c" + c.original + "\u201d");
    btn.setAttribute("data-action", "original-word");
    btn.setAttribute("data-href", "dict://" + encodeURIComponent(c.original));
    btn.addEventListener("click", stopped(function () { openExternal("dict://" + encodeURIComponent(c.original)); }));
    box.appendChild(btn);
    body.appendChild(box);
    return box;
}

function entryNote(result) {
    var entry = result.entry;
    if (!entry || result.fallback) return "";
    var note = result.lang !== "en" ? entry.dict : "";
    if (result.exact === false) note += langScope.explainedIn(entry.explains, result.lang);
    return note;
}

function fillPanel(doc, parts, word, ctx, place) {
    var body = parts.body;
    body.textContent = "查询中…";
    return waitDictInfo().then(function () {
        var opts = langOptions();
        opts.word = word;
        opts.ctx = ctx;
        opts.pageIndex = place ? place.pageIndex : null;
        var io = {
            lookup: function (w, order, stopAtLang) { return runHelper(w, order, stopAtLang); },
            convert: function (w, lang) { return convertWord(w, lang, ctx); },
            textIndex: function () { return getFulltextIndex(place && place.itemID); }
        };
        var pending = langScope
            ? langScope.resolveWithCompletion(opts, io)
            : Promise.resolve({ status: "legacy" });
        return pending.then(function (result) {
            if (result.status === "legacy") {
                // 探测失败或策略模块没加载：完全按 0.3.x 的旧逻辑
                return runHelper(word).then(function (data) {
                    return { status: "ok", entry: pickEnglish(data).english, data: data, lang: "en", legacy: true };
                });
            }
            return result;
        }).then(function (result) {
            var target = result.decision ? result.decision.target : "en";
            if (result.status !== "ok") {
                // 失败也留痕：词、目标语言、试过的词典、每本被拒的原因
                var view = langScope.statusView(result, word, opts.dictionaries);
                if (parts.foot) parts.foot.style.display = "none";   // 按钮栏画在提示下方，避免重复
                renderStatusView(doc, body, view, result.data, word, target);
                if (result.completion) view.log.completion = result.completion;
                log("查词失败 " + JSON.stringify(view.log));
                return;
            }
            if (langScope && !result.legacy) {
                var labels = langScope.buttonLabels(target);
                if (parts.openBtn) parts.openBtn.textContent = labels.dictApp;
                if (parts.moreBtn) parts.moreBtn.textContent = labels.more;
                parts.state = { result: result, target: target, dictionaries: opts.dictionaries };
            } else if (parts.moreBtn) {
                parts.moreBtn.style.display = "none";   // 旧逻辑没有决策信息，不显示「更多」
            }
            return showResult(doc, body, word, ctx, result);
        });
    }).catch(function (e) {
        body.textContent = "查词失败：" + (e && e.message ? e.message : e);
        log("查询失败：" + e);
    });
}

function showResult(doc, body, word, ctx, result) {
    var data = result.data || {};
    var entry = result.entry;
    var lang = result.lang || "en";
    var shownWord = result.fallback && result.fallback.kind === "A" ? result.fallback.convertedWord
        : result.completion && result.completion.completed ? result.completion.completed : word;
    var loose = !result.legacy && entry && entry.explains !== "en";
    var ui = renderCompact(doc, body, shownWord, data, entry, loose, entryNote(result));
    if (ctx && entry) recordHistory(ctx.itemID, shownWord);
    if (!ui || !ui.englishRaw) return;
    if (result.completion && result.completion.completed) {
        log("补全 " + JSON.stringify(result.completion));
        renderCompletionNotice(doc, body, result);
    }

    if (result.fallback) {
        log("兜底 " + JSON.stringify(result.fallback));
        var original = Array.prototype.map.call(ui.list.children, function (n) { return n.textContent; });
        renderFallbackNotice(doc, body, result, original);
    }

    // 兜底结果与语境相关，只进内存缓存，键含 itemID 与历史尾部
    if (result.fallback || result.transcribe) {
        var fkey = ["S", shownWord.toLowerCase(), lang, entry.dict, result.transcribe ? "t" : "", ctxKey(ctx)].join("|");
        var hit = readFallbackCache(fkey);
        var apply = function (senses) {
            if (senses && senses.length) {
                applySenses(doc, ui.list, senses.join("；"));
            } else if (result.transcribe) {
                // 转写失败：保留原语言释义并标明语言，不装作是目标语言
                ui.list.parentNode.appendChild(el(doc, "div", "sysdict-hint",
                    langScope.transcribeFailed(entry.explains, lang)));
            }
        };
        if (hit !== undefined) return apply(hit);
        return summarize(shownWord, ui.englishRaw, contextHasSignal(ctx) ? ctx : null, lang, result.transcribe)
            .then(function (res) {
                var senses = res && res.senses && res.senses.length ? res.senses : null;
                writeFallbackCache(fkey, senses);
                apply(senses);
            });
    }

    var cached = readCachedSummary(word, lang);
    if (cached) applySenses(doc, ui.list, cached);

    if (contextHasSignal(ctx)) {
        var key = rankKey(word, ctx, lang);
        var ranked = readRankCache(key);
        if (ranked) {
            applyRanked(doc, ui.list, ranked, lang);
            return;
        }
        // 一次调用完成压义项 + 排序；失败时保持上面已显示的内容（缓存精简版或解析结果）
        return summarize(word, ui.englishRaw, ctx, lang).then(function (res) {
            if (!res || !res.ranked || !res.senses || !res.senses.length) {
                if (res && res.summary && !cached) {
                    writeCachedSummary(word, res.summary, ui.englishRaw, lang);
                    applySenses(doc, ui.list, res.summary);
                }
                return;
            }
            writeRankCache(key, res.senses);
            applyRanked(doc, ui.list, res.senses, lang);
        });
    }

    if (cached) return;

    // 端侧模型精简；失败或不可用时保持解析结果
    return summarize(word, ui.englishRaw, null, lang).then(function (res) {
        if (!res || !res.summary) return;
        writeCachedSummary(word, res.summary, ui.englishRaw, lang);
        applySenses(doc, ui.list, res.summary);
    });
}

/* ---------------- reader 事件 ---------------- */

function onRenderSelectionPopup(event) {
    try {
        var doc = event.doc;
        if (!doc) return;

        var fromAnnotation = (event.params && event.params.annotation && event.params.annotation.text) || "";
        var fromSelection = "";
        try {
            var selection = doc.getSelection ? doc.getSelection() : null;
            fromSelection = selection && !selection.isCollapsed ? String(selection) : "";
        } catch (e) {}

        var raw = fromSelection.length >= fromAnnotation.length ? fromSelection : fromAnnotation;
        var word = normalizeSelection(raw);
        if (!isLookupable(word)) return;

        injectStyle(doc);

        var host = doc.querySelector(".selection-popup");
        if (host) host.style.setProperty("max-width", (PANEL_WIDTH + 30) + "px", "important");

        var parts = buildPanel(doc, word);

        ["mousedown", "mouseup", "click", "dblclick"].forEach(function (type) {
            parts.panel.addEventListener(type, function (ev) { ev.stopPropagation(); });
        });

        if (typeof event.append === "function") {
            event.append(parts.panel);
        } else {
            (host || doc.body).appendChild(parts.panel);
        }

        // 补全用：当前条目与划词所在页（只在需要补全时才读全文）
        var place = {
            itemID: event.reader && event.reader.itemID,
            pageIndex: event.params && event.params.annotation && event.params.annotation.position &&
                typeof event.params.annotation.position.pageIndex === "number"
                ? event.params.annotation.position.pageIndex : null
        };

        // 语境在划词这一刻取：元数据现读，历史取本次之前的快照（不含当前词）
        var ctx = null;
        if (pref("contextRank", true)) {
            ctx = readItemContext(event.reader);
            if (ctx) {
                var key = word.toLowerCase();
                ctx.history = loadHistory(ctx.itemID)
                    .map(function (h) { return h.w; })
                    .filter(function (w) { return w.toLowerCase() !== key; })
                    .slice(-HISTORY_SEND);
            }
        }

        if (pref("autoLookup", true)) {
            fillPanel(doc, parts, word, ctx, place);
        } else {
            parts.body.textContent = "";
            var btn = el(doc, "button", "sysdict-btn", "查系统词典");
            btn.addEventListener("click", function (ev) {
                ev.stopPropagation();
                ev.preventDefault();
                fillPanel(doc, parts, word, ctx, place);
            });
            parts.body.appendChild(btn);
        }
    } catch (e) {
        log("划词处理出错：" + e);
    }
}

function register() {
    if (registered) return;
    if (!Zotero.Reader || typeof Zotero.Reader.registerEventListener !== "function") {
        log("当前 Zotero 没有 Reader.registerEventListener");
        return;
    }
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", onRenderSelectionPopup, PLUGIN_ID);
    registered = true;
}

/* ---------------- 设置面板 ---------------- */

// 供 content/preferences.js 读取：探测结果、当前设置下的预估选择
function exposeStatusAPI() {
    Zotero.SysDict = {
        lang: langScope,
        status: function () {
            var opts = langOptions();
            return {
                info: dictInfo,
                options: opts,
                previews: dictInfo && langScope ? {
                    latin: langScope.preview(opts, "water"),
                    han: langScope.preview(opts, "水")
                } : null
            };
        },
        refresh: function () { return loadDictInfo(true); }
    };
}

function registerPrefPane(rootURI) {
    try {
        if (!Zotero.PreferencePanes || typeof Zotero.PreferencePanes.register !== "function") {
            log("当前 Zotero 没有 PreferencePanes，设置只能通过配置编辑器修改");
            return;
        }
        Zotero.PreferencePanes.register({
            pluginID: PLUGIN_ID,
            id: "sysdict-prefpane",
            src: rootURI + "content/preferences.xhtml",
            scripts: [rootURI + "content/preferences.js"],
            label: "系统词典",
            image: rootURI + "content/icons/icon.png"
        }).catch(function (e) { log("注册设置面板失败：" + e); });
    } catch (e) {
        log("注册设置面板失败：" + e);
    }
}

/* ---------------- 生命周期 ---------------- */

function install(data, reason) {}
function uninstall(data, reason) {}

async function startup({ id, version, rootURI }, reason) {
    try {
        if (Zotero.initializationPromise) await Zotero.initializationPromise;
        ["dictlookup", "dictsummary"].forEach(function (name) {
            try {
                var scope = {};
                Services.scriptloader.loadSubScript(rootURI + "native/" + name + ".b64.js", scope);
                helperB64[name] = scope["SYSDICT_" + name.toUpperCase() + "_B64"] || null;
            } catch (e) {
                log("加载内置模块 " + name + " 失败：" + e);
            }
            releaseBinary(name, version);
        });
        try {
            var langLib = {};
            Services.scriptloader.loadSubScript(rootURI + "content/lang.js", langLib);
            langScope = langLib.SysDictLang || null;
        } catch (e) {
            log("加载 lang.js 失败：" + e);
        }
        register();
        loadDictInfo(false);
        exposeStatusAPI();
        registerPrefPane(rootURI);
        Zotero.Promise.delay(10000).then(cleanHistoryDir);
        log("startup v" + version);
    } catch (e) {
        log("startup 出错：" + e);
    }
}

function shutdown() {
    registered = false;
    try { delete Zotero.SysDict; } catch (e) {}
    dictInfo = null;
    dictInfoPromise = null;
    historyCache.clear();
    rankCache.clear();
    fallbackCache.clear();
    fulltextCache.clear();
}

function onMainWindowLoad({ window }, reason) {}
function onMainWindowUnload({ window }, reason) {}
