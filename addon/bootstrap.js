// Zotero 划词弹窗 → macOS 系统词典（DictionaryServices）+ 端侧模型精简
//
// 流程：
//   1. dictlookup 取苹果词典原文（毫秒级），拆成词头 / 音标 / 简明释义
//   2. 先渲染精简版（音标 + 中文义项），不阻塞
//   3. 后台调 dictsummary（Apple Foundation Models 端侧模型）压成 2–3 条精简英文义项；
//      模型不可用时保留第 2 步的解析结果，版式不变
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
        var value = Zotero.Prefs.get(PREFIX + key);
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

function cacheFile(word) {
    var dir = baseDir();
    dir.append("cache");
    if (!dir.exists()) dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
    var file = dir.clone();
    file.append(word.toLowerCase().replace(/[^a-z'\-]/g, "_") + ".json");
    return file;
}

/* ---------------- 选区清洗 ---------------- */

function normalizeSelection(raw) {
    var text = String(raw || "");

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
    ".sysdict-hint{font-size:10.5px;opacity:.45;margin-top:5px;}",
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

function runHelper(word) {
    var file = helperFile("dictlookup");
    if (!file.exists() || !file.isExecutable()) {
        throw new Error("词典助手缺失：" + file.path);
    }

    var args = [word];
    var order = pref("order", "");
    if (order) args.push("--order", order);

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

function summarize(word, raw) {
    var file = helperFile("dictsummary");
    if (!file.exists() || !file.isExecutable()) return Promise.resolve(null);
    if (!raw) return Promise.resolve(null);

    return Zotero.Utilities.Internal
        .subprocess(file.path, ["--word", word, "--raw", raw])
        .then(function (out) {
            var parsed = JSON.parse(out);
            return parsed && parsed.available ? parsed.summary : null;
        })
        .catch(function (e) {
            log("dictsummary 失败：" + e);
            return null;
        });
}

function readCachedSummary(word) {
    try {
        var file = cacheFile(word);
        if (!file.exists()) return null;
        var data = JSON.parse(Zotero.File.getContents(file));
        return data && data.summary ? data.summary : null;
    } catch (e) {
        return null;
    }
}

function writeCachedSummary(word, summary, raw) {
    try {
        Zotero.File.putContents(cacheFile(word), JSON.stringify({
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
    panel.appendChild(foot);

    return { panel: panel, body: body };
}

function renderCompact(doc, body, word, data) {
    body.textContent = "";

    var picked = pickEnglish(data);
    var entry = picked.english;

    if (!entry) {
        body.appendChild(el(doc, "div", "sysdict-hint", "未收录「" + word + "」"));
        return;
    }

    var head = el(doc, "div", "sysdict-head");
    head.appendChild(el(doc, "span", "sysdict-word", data.word || word));
    if (entry.ipa) head.appendChild(el(doc, "span", "sysdict-ipa", " /" + entry.ipa.replace(/^\/|\/$/g, "") + "/"));
    body.appendChild(head);

    var list = el(doc, "div", "sysdict-senses");
    (entry.senses || []).slice(0, 3).forEach(function (sense) {
        list.appendChild(el(doc, "div", "sysdict-sense", sense));
    });
    body.appendChild(list);

    if (data.completedFrom) {
        body.appendChild(el(doc, "div", "sysdict-hint", "选区「" + data.completedFrom + "」"));
    }

    return { list: list, englishRaw: entry.text || "" };
}

// 模型结果：分号分隔的短义项，替换掉解析出来的那几条
function applySenses(doc, listEl, text) {
    var parts = String(text || "").split(/;\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return;
    listEl.textContent = "";
    parts.slice(0, 3).forEach(function (sense) {
        listEl.appendChild(el(doc, "div", "sysdict-sense", sense));
    });
}

function fillPanel(doc, body, word) {
    body.textContent = "查询中…";
    return runHelper(word).then(function (data) {
        var ui = renderCompact(doc, body, word, data);
        if (!ui || !ui.englishRaw) return;

        var cached = readCachedSummary(word);
        if (cached) {
            applySenses(doc, ui.list, cached);
            return;
        }

        // 端侧模型精简；失败或不可用时保持解析结果
        return summarize(word, ui.englishRaw).then(function (summary) {
            if (!summary) return;
            writeCachedSummary(word, summary, ui.englishRaw);
            applySenses(doc, ui.list, summary);
        });
    }).catch(function (e) {
        body.textContent = "查词失败：" + (e && e.message ? e.message : e);
        log("查询失败：" + e);
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

        if (pref("autoLookup", true)) {
            fillPanel(doc, parts.body, word);
        } else {
            parts.body.textContent = "";
            var btn = el(doc, "button", "sysdict-btn", "查系统词典");
            btn.addEventListener("click", function (ev) {
                ev.stopPropagation();
                ev.preventDefault();
                fillPanel(doc, parts.body, word);
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
        register();
        log("startup v" + version);
    } catch (e) {
        log("startup 出错：" + e);
    }
}

function shutdown() {
    registered = false;
}

function onMainWindowLoad({ window }, reason) {}
function onMainWindowUnload({ window }, reason) {}
