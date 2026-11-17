// 本机真实词典 + 端侧模型的语言选择演示：先 bash build.sh，再 node scripts/lang_demo.js
// 与插件走同一套 lang.js 决策；dictlookup / dictsummary 用 build/ 下刚编译的二进制。全程离线
"use strict";

var path = require("path");
var cp = require("child_process");
var L = require("../addon/content/lang.js");

var ROOT = path.join(__dirname, "..");
var LOOKUP = path.join(ROOT, "build/dictlookup");
var SUMMARY = path.join(ROOT, "build/dictsummary");
var CACHE = path.join(ROOT, "build/dictionaries-demo.json");

function run(bin, args) {
    var t0 = Date.now();
    var out = cp.execFileSync(bin, args, { encoding: "utf8" });
    return { json: JSON.parse(out), ms: Date.now() - t0 };
}

var listing = run(LOOKUP, ["--list-dictionaries", "--json", "--cache", CACHE]);
var info = listing.json;
console.log("系统首选语言：" + info.systemLanguages.join("、"));
console.log("可用词典 " + info.dictionaries.length + " 本（" + (info.cached ? "读缓存" : "重新探测 " + info.probeMs + " ms") +
    "，本次调用 " + listing.ms + " ms）\n");

var timings = [];
function io() {
    return {
        lookup: function (word, order, stopAtLang) {
            var r = run(LOOKUP, [word, "--order", order.join("|"), "--cache", CACHE].concat(stopAtLang ? ["--stop-at-lang", stopAtLang] : []));
            timings.push(["dictlookup", r.ms]);
            return Promise.resolve(r.json);
        },
        convert: function (word, lang) {
            var r = run(SUMMARY, ["--word", word, "--convert-to", lang, "--title", "Water rights and irrigation in Spain"]);
            timings.push(["换词", r.ms]);
            return Promise.resolve(r.json.available ? r.json.converted : null);
        }
    };
}

var CASES = [
    ["英文词，自动（系统 en-US 在前）", "water", {}],
    ["汉字词，自动", "水", {}],
    ["英文词，显式简体中文", "water", { targetPref: "zh-Hans" }],
    ["英文词，显式繁体中文", "water", { targetPref: "zh-Hant" }],
    ["汉字词，只在同语言内解释", "政府", { sameLanguageOnly: true }],
    ["西语词 agua，系统英文（应选西英词典）", "agua", {}],
    ["西语词 gobierno，系统英文", "gobierno", {}],
    ["英文词，假设系统首选西班牙语（应选西英词典的英→西方向）", "water", { systemLanguages: ["es-ES"] }],
    ["法语词 gouvernement，系统英文", "gouvernement", {}],
    ["德语词 Regierung，系统英文", "Regierung", {}],
    ["英文词，假设系统首选西班牙语，只允许 NOAD，开兜底（B）", "water", { systemLanguages: ["es-ES"], scope: ["New Oxford American Dictionary"], fallback: true }],
    ["西语词 agua，只允许 NOAD，开兜底（A）", "agua", { scope: ["New Oxford American Dictionary"], fallback: true }]
];

function demo(c) {
    var o = {
        word: c[1], targetPref: "auto", sameLanguageOnly: false, systemLanguages: info.systemLanguages,
        dictionaries: info.dictionaries, signature: info.signature, userOrder: [], scope: [], fallback: false
    };
    for (var k in c[2]) o[k] = c[2][k];
    L.clearMemo();
    timings = [];
    return L.resolve(o, io()).then(function (r) {
        console.log("== " + c[0] + "：「" + c[1] + "」");
        console.log("   目标语言 " + r.decision.targetLabel + "（来源：" + r.decision.targetSource + "）");
        if (r.status !== "ok") {
            console.log("   → " + L.statusMessage(r, c[1]));
        } else {
            console.log("   → 词典「" + r.entry.dict + "」，实际释义语言 " + L.label(r.entry.explains) +
                (r.fallback ? "\n   → " + L.fallbackNotice(r) : ""));
            var word = r.fallback && r.fallback.kind === "A" ? r.fallback.convertedWord : c[1];
            var args = ["--word", word, "--raw", r.entry.text];
            if (r.lang !== "en") args.push("--target-lang", r.lang);
            if (r.transcribe) args.push("--transcribe");
            var s = run(SUMMARY, args);
            timings.push([r.transcribe ? "转写" : "压义项", s.ms]);
            console.log("   → 模型输出（" + (s.json.targetLang || "?") + "）：" +
                (s.json.available ? (s.json.senses || []).join(" ｜ ") : "失败：" + s.json.reason));
        }
        console.log("   耗时：" + timings.map(function (t) { return t[0] + " " + t[1] + " ms"; }).join("，") + "\n");
    });
}

CASES.reduce(function (p, c) { return p.then(function () { return demo(c); }); }, Promise.resolve());
