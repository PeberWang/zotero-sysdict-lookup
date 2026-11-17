// 弹窗预览：用最小的假 DOM 加载真实的 bootstrap.js，查词走 build/dictlookup，压义项走 build/dictsummary（端侧模型），
// 把弹窗内容按树打印出来。不需要 Zotero。先 bash build.sh，再：
//   node scripts/popup_preview.js colossal                      # 系统首选语言
//   node scripts/popup_preview.js colossal targetLang=zh-Hant dictScope="New Oxford American Dictionary"
//   node scripts/popup_preview.js xyzzy
// 结尾会断言：有「词典 App」与「更多」两个按钮，且词典 App 指向 dict://<原词>。失败时退出码非 0
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var cp = require("child_process");

var ROOT = path.join(__dirname, "..");
var word = process.argv[2] || "colossal";
var prefs = {};
var paperTitle = null;
var summaryOverride = null;
process.argv.slice(3).forEach(function (kv) {
    var i = kv.indexOf("=");
    if (kv.slice(0, i) === "title") paperTitle = kv.slice(i + 1);   // title=…：模拟当前文献语境，走语境排序（会出首选标签）
    else if (kv.slice(0, i) === "summary") summaryOverride = path.resolve(kv.slice(i + 1));   // summary=…：换一个 dictsummary（测试桩）
    else prefs[kv.slice(0, i)] = kv.slice(i + 1);
});

/* ---------------- 最小假 DOM ---------------- */

function Node(tag) {
    this.tagName = tag;
    this.className = "";
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this._text = "";
}
Object.defineProperty(Node.prototype, "textContent", {
    get: function () { return this._text + this.children.map(function (c) { return c.textContent; }).join(""); },
    set: function (v) { this.children.forEach(function (c) { c.parentNode = null; }); this.children = []; this._text = String(v); }
});
Node.prototype.appendChild = function (c) {
    if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
    c.parentNode = this;
    this.children.push(c);
    return c;
};
Node.prototype.insertBefore = function (c, ref) {
    if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
    c.parentNode = this;
    var i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
};
Node.prototype.remove = function () {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
};
Node.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
Node.prototype.getAttribute = function (k) { return this.attrs[k]; };
Node.prototype.addEventListener = function (t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); };
Node.prototype.click = function () {
    var ev = { stopPropagation: function () {}, preventDefault: function () {} };
    (this.listeners.click || []).forEach(function (f) { f(ev); });
};
Node.prototype.all = function () {
    return [this].concat.apply([this], this.children.map(function (c) { return c.all().slice(1).concat([]); }))
        .concat([]);
};
function walk(n, fn) { fn(n); n.children.forEach(function (c) { walk(c, fn); }); }
Node.prototype.querySelector = function (sel) {
    var cls = sel.replace(/^\./, "");
    var hit = null;
    this.children.forEach(function (c) { walk(c, function (x) { if (!hit && (" " + x.className + " ").indexOf(" " + cls + " ") >= 0) hit = x; }); });
    return hit;
};
var doc = { createElement: function (t) { return new Node(t); }, defaultView: { innerHeight: 800 } };

/* ---------------- 加载 bootstrap.js，替换文件与子进程依赖 ---------------- */

var logs = [];
var opened = [];
function subprocess(file, args) {
    return new Promise(function (resolve, reject) {
        cp.execFile(file, args, { encoding: "utf8", maxBuffer: 1 << 24 }, function (err, out) { err ? reject(err) : resolve(out); });
    });
}
var ctx = {
    console: console,
    Services: {},
    Components: { interfaces: {} },
    Zotero: {
        Prefs: { get: function (k) { var key = k.replace("extensions.zotero.sysdict.", ""); return prefs[key]; } },
        Promise: { delay: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); } },
        Utilities: { Internal: { subprocess: subprocess, openPreferences: function () {} } },
        debug: function () {}
    },
    setTimeout: setTimeout
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "addon/bootstrap.js"), "utf8"), ctx);
ctx.SysDictLangLib = require(path.join(ROOT, "addon/content/lang.js"));
vm.runInContext([
    "langScope = SysDictLangLib;",
    "helperFile = function (n) { var p = n === 'dictsummary' && __summary ? __summary : " + JSON.stringify(path.join(ROOT, "build")) + " + '/' + n; return { path: p, exists: function () { return true; }, isExecutable: function () { return true; } }; };",
    "dictInfoFile = function () { return { path: " + JSON.stringify(path.join(ROOT, "build/dictionaries-preview.json")) + " }; };",
    "readCachedSummary = function () { return null; }; writeCachedSummary = function () {};",
    "recordHistory = function () {}; log = function (m) { __logs.push(m); }; openExternal = function (u) { __opened.push(u); };",
    "readRankCache = function () { return null; }; writeRankCache = function () {};"
].join("\n"), Object.assign(ctx, { __logs: logs, __opened: opened, __summary: summaryOverride }));

/* ---------------- 运行与打印 ---------------- */

function dump(n, depth) {
    var pad = new Array(depth + 1).join("  ");
    if (n.style && n.style.display === "none") return;
    var own = n._text ? " " + JSON.stringify(n._text) : "";
    var tag = n.tagName === "button" ? "[按钮 " + (n.attrs["data-action"] || "dictapp") + "]" : "<" + (n.className || n.tagName) + ">";
    console.log(pad + tag + own);
    n.children.forEach(function (c) { dump(c, depth + 1); });
}

var parts = ctx.buildPanel(doc, word);
// 面板底部「词典 App」按钮没有 data-action，补上便于打印与断言
parts.openBtn.setAttribute("data-action", "dictapp");
ctx.loadDictInfo(false).then(function () {
    var paper = paperTitle ? { itemID: 1, title: paperTitle, abstract: "", journal: "", year: "", authors: "", history: [] } : null;
    return ctx.fillPanel(doc, parts, word, paper, null);
}).then(function () {
    console.log("== 「" + word + "」" + (Object.keys(prefs).length ? " " + JSON.stringify(prefs) : "") + " 的弹窗");
    dump(parts.panel, 0);

    var buttons = [];
    walk(parts.panel, function (n) {
        if (n.tagName !== "button") return;
        var hidden = false;
        for (var p = n; p; p = p.parentNode) if (p.style && p.style.display === "none") hidden = true;
        if (!hidden) buttons.push(n);
    });
    var dictBtn = buttons.filter(function (b) { return b.attrs["data-action"] === "dictapp"; })[0];
    var moreBtn = buttons.filter(function (b) { return b.attrs["data-action"] === "more"; })[0];
    if (dictBtn) dictBtn.click();
    if (moreBtn) moreBtn.click();
    console.log("== 点「" + (moreBtn ? moreBtn.textContent : "?") + "」之后");
    dump(parts.panel, 0);
    if (logs.length) console.log("== lookup.log\n" + logs.join("\n"));

    var ok = !!dictBtn && !!moreBtn && opened[0] === "dict://" + encodeURIComponent(word);
    console.log("\n按钮检查：词典 App " + (dictBtn ? "✓「" + dictBtn.textContent + "」→ " + opened[0] : "✗") +
        "；更多 " + (moreBtn ? "✓「" + moreBtn.textContent + "」" : "✗"));
    process.exit(ok ? 0 : 1);
}).catch(function (e) { console.error(e); process.exit(2); });
