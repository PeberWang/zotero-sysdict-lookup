// 划词补全的端到端演示：真实文献全文（Zotero 条目 8MVP38QT，见 scripts/fixtures）+ 真实 dictlookup。
// 先 bash build.sh，再 node scripts/completion_demo.js
// fixture 只保留了演示划词补全范围内的词形与逐页频次，重建出的索引对这些划词给出的候选与排序与原文一致
"use strict";

var path = require("path");
var cp = require("child_process");
var L = require("../addon/content/lang.js");

var ROOT = path.join(__dirname, "..");
var LOOKUP = path.join(ROOT, "build/dictlookup");
var CACHE = path.join(ROOT, "build/dictionaries-demo.json");
var fixture = require("./fixtures/fulltext_8MVP38QT_subset.json");

function run(args) {
    var t0 = process.hrtime.bigint();
    var out = cp.execFileSync(LOOKUP, args, { encoding: "utf8" });
    return { json: JSON.parse(out), ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

// 由逐页频次重建全文（每页把词形按次数写出，页间用 \f）
var pages = [];
for (var i = 0; i < fixture.pageCount; i++) pages.push([]);
Object.keys(fixture.tokens).forEach(function (key) {
    var t = fixture.tokens[key];
    t.pages.forEach(function (pc) { for (var k = 0; k < pc[1]; k++) pages[pc[0]].push(t.form); });
});
var text = pages.map(function (p) { return p.join(" "); }).join("\f");

var info = run(["--list-dictionaries", "--json", "--cache", CACHE]).json;
var t0 = process.hrtime.bigint();
var index = L.buildTextIndex(text);
var indexMs = Number(process.hrtime.bigint() - t0) / 1e6;

var lookups = 0, lookupMs = 0;
var io = {
    lookup: function (w, order, stop) {
        var r = run([w, "--order", order.join("|"), "--cache", CACHE].concat(stop ? ["--stop-at-lang", stop] : []));
        lookups++;
        lookupMs += r.ms;
        return Promise.resolve(r.json);
    },
    convert: function () { return Promise.resolve(null); },
    textIndex: function () { return Promise.resolve(index); }
};

console.log("文献：" + fixture.source.split(";")[0]);
console.log("系统首选语言：" + info.systemLanguages.join("、") + "；目标语言取第一项\n");

fixture.demos.reduce(function (p, d) {
    return p.then(function () {
        L.clearMemo();
        lookups = 0;
        lookupMs = 0;
        var c0 = process.hrtime.bigint();
        var cands = L.completionCandidates(d.sel, index, { pageIndex: d.pageIndex });
        var candMs = Number(process.hrtime.bigint() - c0) / 1e6;
        var opts = { word: d.sel, dictionaries: info.dictionaries, signature: info.signature, systemLanguages: info.systemLanguages,
                     targetPref: "auto", sameLanguageOnly: false, userOrder: [], scope: [], fallback: false, pageIndex: d.pageIndex };
        return L.resolveWithCompletion(opts, io).then(function (r) {
            var inText = index.freq[d.sel.toLowerCase()] || 0;
            console.log("== 划词原文「" + d.sel + "」（第 " + (d.pageIndex === null ? "?" : d.pageIndex + 1) + " 页；原文全词：" + (d.full || "无") +
                "；划词本身在原文出现 " + inText + " 次）");
            console.log("   全文候选：" + (cands.length ? cands.slice(0, 3).map(function (c) {
                return c.word + "（" + c.freq + " 次" + (c.samePage ? "，同页" : "") + "）";
            }).join("、") : "无"));
            if (r.status === "ok") {
                var how = r.completion ? (r.completion.source === "fulltext" ? "按原文补全" + (r.completion.precheck ? "（原文预检）" : "") : "dictlookup 末字母补全") +
                    " → " + r.completion.completed : "无需补全";
                console.log("   " + how + "；命中「" + r.entry.dict + "」，释义语言 " + L.label(r.entry.explains, "zh-Hans"));
                if (r.completion) console.log("   弹窗说明：" + L.completionNotice(r));
                console.log("   第一条义项：" + (L.cleanSenses(r.entry.senses)[0] || L.entrySenses(r.entry.text)[0]));
            } else {
                console.log("   未命中：" + L.statusMessage(r, d.sel, info.dictionaries));
            }
            console.log("   耗时：候选 " + candMs.toFixed(2) + " ms，查词 " + lookups + " 次共 " + lookupMs.toFixed(0) + " ms\n");
        });
    });
}, Promise.resolve()).then(function () {
    console.log("索引：" + index.pageCount + " 页、" + index.tokens + " 个词形，重建用时 " + indexMs.toFixed(2) + " ms（fixture 子集）");
    // 开销参考：随机生成约 1 MB、10 万级不同词形的文本（比真实论文、专著的词形数更多，偏保守）
    var letters = "abcdefghijklmnopqrstuvwxyz", seed = 7, parts = [], len = 0;
    var rnd = function () {        // xorshift32：避免大数乘法超出浮点精度后序列过早循环
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        return (seed >>> 0) / 4294967296;
    };
    while (len < 1e6) {
        var n = 3 + Math.floor(rnd() * 10), w = "";
        for (var q = 0; q < n; q++) w += letters[Math.floor(rnd() * 26)];
        parts.push(w);
        len += n + 1;
        if (parts.length % 3000 === 0) parts.push("\f");
    }
    var b0 = process.hrtime.bigint();
    var bigIndex = L.buildTextIndex(parts.join(" "));
    var bigMs = Number(process.hrtime.bigint() - b0) / 1e6;
    var q0 = process.hrtime.bigint();
    var found = L.completionCandidates(parts[12345].slice(0, -1), bigIndex, { pageIndex: 3 });
    var qMs = Number(process.hrtime.bigint() - q0) / 1e6;
    console.log("合成约 1 MB 文本：" + bigIndex.pageCount + " 页、" + bigIndex.tokens + " 个词形；建索引 " + bigMs.toFixed(0) +
        " ms，找一次候选 " + qMs.toFixed(1) + " ms（命中 " + found.length + " 个）");
});
