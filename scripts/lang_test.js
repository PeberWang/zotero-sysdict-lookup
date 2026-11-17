// 解释语言与兜底策略的单元测试（纯打桩，不调词典、不调模型）：node scripts/lang_test.js
// 三套词典配置 × 默认 / 开兜底 × A、B 两个案例，外加选词典规则本身的断言。失败时退出码非 0
"use strict";

var L = require("../addon/content/lang.js");

var failures = 0;
var passed = 0;
function check(name, actual, expected) {
    var ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) passed++;
    else {
        failures++;
        console.log("  ✗ " + name + "\n      实际: " + JSON.stringify(actual) + "\n      期望: " + JSON.stringify(expected));
    }
}

/* ---------------- 词典桩 ---------------- */

// 签名与 dictlookup --list-dictionaries 的结构一致；contents 是桩里「这本词典收录的词 → 实际释义语言」
var DICTS = {
    NOAD: { name: "New Oxford American Dictionary", latin: { explains: "en" }, contents: { water: "en", interest: "en" } },
    ODE: { name: "Oxford Dictionary of English", latin: { explains: "en" }, contents: { water: "en", colour: "en" } },
    OXZH: { name: "牛津英汉汉英词典", latin: { explains: "zh-Hans" }, han: { explains: "en" },
            contents: { water: "zh-Hans", "水": "en" } },
    XDHY: { name: "现代汉语规范词典", han: { explains: "zh-Hans" }, contents: { "水": "zh-Hans", "政府": "zh-Hans" } },
    ESEN: { name: "Gran Diccionario Oxford - Español-Inglés • Inglés-Español", latin: { explains: "es", pair: ["en", "es"] },
            contents: { agua: "en", gobierno: "en", water: "es" } }
};

function config(keys) {
    return keys.map(function (k) { return DICTS[k]; });
}

// dictlookup 桩：按 order 返回收录该词的词典，顺序一致，带 explains
function stubIO(dicts, conversions) {
    var calls = { lookup: [], convert: [] };
    return {
        calls: calls,
        lookup: function (word, order) {
            calls.lookup.push([word, order.slice()]);
            var entries = [];
            order.forEach(function (name) {
                var d = dicts.filter(function (x) { return x.name === name; })[0];
                if (d && d.contents[word]) entries.push({ dict: name, text: word + " …", explains: d.contents[word] });
            });
            return Promise.resolve({ word: word, entries: entries });
        },
        convert: function (word, lang) {
            calls.convert.push([word, lang]);
            var hit = (conversions || {})[word + ">" + lang];
            return Promise.resolve(hit === undefined ? null : hit);
        }
    };
}

function opts(extra) {
    var o = { systemLanguages: ["en-US"], targetPref: "auto", sameLanguageOnly: false, userOrder: [], scope: [], fallback: false };
    for (var k in extra) o[k] = extra[k];
    return o;
}

// 一行总结：用了哪条规则
function rule(r) {
    if (r.status !== "ok") return r.status + (r.reason ? ":" + r.reason : "") + (r.fallbackFailed ? " 兜底" + r.fallbackFailed + "失败" : "");
    if (!r.fallback) return "命中「" + r.entry.dict + "」(" + r.entry.explains + ")";
    if (r.fallback.kind === "A") return "兜底A：" + r.fallback.originalWord + "→" + r.fallback.convertedWord + " 查「" + r.fallback.dictionary + "」" + (r.transcribe ? "+转写" : "");
    return "兜底B：「" + r.fallback.dictionary + "」" + r.fallback.sourceLanguage + "→" + r.fallback.target + " 转写";
}

/* ---------------- 规则本身 ---------------- */

function testRules() {
    console.log("== 选词典规则");
    check("normalizeLang zh-Hant-HK", L.normalizeLang("zh-Hant-HK"), "zh-Hant");
    check("normalizeLang zh-HK", L.normalizeLang("zh-HK"), "zh-Hant");
    check("normalizeLang zh-CN", L.normalizeLang("zh_CN"), "zh-Hans");
    check("normalizeLang en-US", L.normalizeLang("en-US"), "en");
    check("目标语言取系统第一项", L.resolveTarget({ systemLanguages: ["en-US", "zh-Hant-HK", "zh-Hans-HK"] }).lang, "en");
    check("用户显式设置优先", L.resolveTarget({ targetPref: "zh-Hans", systemLanguages: ["en-US"] }).lang, "zh-Hans");
    check("同语言：汉字词跟随系统里第一个中文",
        L.resolveTarget({ sameLanguageOnly: true, word: "水", systemLanguages: ["en-US", "zh-Hant-HK"] }).lang, "zh-Hant");
    check("同语言：英文词", L.resolveTarget({ sameLanguageOnly: true, word: "water", systemLanguages: ["zh-Hans"] }).lang, "en");

    var dicts = config(["OXZH", "NOAD", "XDHY"]);
    check("顺序：无自定义时按已知质量", L.buildOrder({ word: "water", target: "en", dictionaries: dicts }),
        ["New Oxford American Dictionary", "牛津英汉汉英词典"]);
    L.clearMemo();
    check("顺序：自定义顺序优先、只含能查拉丁词的",
        L.buildOrder({ word: "water", target: "en", dictionaries: dicts, userOrder: ["牛津英汉汉英词典"] }),
        ["牛津英汉汉英词典", "New Oxford American Dictionary"]);
    L.clearMemo();
    check("顺序：词典范围限制在子集内",
        L.buildOrder({ word: "水", target: "en", dictionaries: dicts, scope: ["现代汉语规范词典"] }),
        ["现代汉语规范词典"]);
    L.clearMemo();

    // 以实际释义为准：签名说 zh-Hans，但这次实际返回 en → 视为 en
    var entries = [{ dict: "牛津英汉汉英词典", explains: "en" }, { dict: "New Oxford American Dictionary", explains: "en" }];
    check("以实际释义语言为准，命中即停", L.pickEntry(entries, "en").entry.dict, "牛津英汉汉英词典");
    check("简繁不一致算宽松匹配", L.pickEntry([{ dict: "x", explains: "zh-Hans" }], "zh-Hant").exact, false);
    check("拉丁非英语目标也正常决策（语言对判定，不再设闸）",
        L.decide({ word: "water", dictionaries: dicts, systemLanguages: ["es-ES"] }).status, "ready");
    check("探测缺失 → unknown（走旧逻辑）", L.decide({ word: "water", dictionaries: [], systemLanguages: ["en"] }).status, "unknown");
    check("A 换词语言：单语英文词典", L.conversionLanguage(DICTS.NOAD, "en"), "en");
    check("A 换词语言：英汉词典、目标中文 → 用英文词去查", L.conversionLanguage(DICTS.OXZH, "zh-Hans"), "en");
    check("A 换词语言：英汉词典、目标英文 → 用中文词去查", L.conversionLanguage(DICTS.OXZH, "en"), "zh-Hans");
}

/* ---------------- 三套配置 × A、B × 默认 / 兜底 ---------------- */

var CONFIGS = [
    { label: "只有英文", dicts: ["NOAD"], userOrder: [] },
    { label: "英文加中文", dicts: ["NOAD", "OXZH"], userOrder: [] },
    { label: "中文排第一加两本英文", dicts: ["XDHY", "NOAD", "ODE"], userOrder: ["现代汉语规范词典", "New Oxford American Dictionary", "Oxford Dictionary of English"] }
];

// A：划西班牙语词 agua，允许的词典都不收录；系统英文
// B：划英文词 water，目标简体中文
var CASES = {
    A: { word: "agua", o: { systemLanguages: ["en-US"] } },
    B: { word: "water", o: { targetPref: "zh-Hans" } }
};

var CONVERSIONS = { "agua>en": "water", "agua>zh-Hans": "水" };

var EXPECT = {
    "只有英文|A|off": "none:not-found",
    "只有英文|A|on": "兜底A：agua→water 查「New Oxford American Dictionary」",
    "只有英文|B|off": "none:wrong-language",
    "只有英文|B|on": "兜底B：「New Oxford American Dictionary」en→zh-Hans 转写",
    "英文加中文|A|off": "none:not-found",
    "英文加中文|A|on": "兜底A：agua→water 查「New Oxford American Dictionary」",
    "英文加中文|B|off": "命中「牛津英汉汉英词典」(zh-Hans)",
    "英文加中文|B|on": "命中「牛津英汉汉英词典」(zh-Hans)",
    "中文排第一加两本英文|A|off": "none:not-found",
    "中文排第一加两本英文|A|on": "兜底A：agua→水 查「现代汉语规范词典」+转写",
    "中文排第一加两本英文|B|off": "none:wrong-language",
    "中文排第一加两本英文|B|on": "兜底B：「New Oxford American Dictionary」en→zh-Hans 转写"
};

function runMatrix() {
    console.log("\n== 三套词典配置 × A、B × 默认 / 兜底");
    var jobs = [];
    CONFIGS.forEach(function (cfg) {
        ["A", "B"].forEach(function (kind) {
            [false, true].forEach(function (fallback) {
                jobs.push(function () {
                    L.clearMemo();
                    var dicts = config(cfg.dicts);
                    var io = stubIO(dicts, CONVERSIONS);
                    var c = CASES[kind];
                    var o = opts(c.o);
                    o.word = c.word;
                    o.dictionaries = dicts;
                    o.userOrder = cfg.userOrder;
                    o.fallback = fallback;
                    return L.resolve(o, io).then(function (r) {
                        var key = cfg.label + "|" + kind + "|" + (fallback ? "on" : "off");
                        var got = rule(r);
                        console.log("  " + (fallback ? "兜底开 " : "默认   ") + kind + "  " + cfg.label + "：" + got +
                            "  [查词 " + io.calls.lookup.length + " 次，换词 " + io.calls.convert.length + " 次]");
                        check(key, got, EXPECT[key]);
                        // 默认关闭时绝不调用模型换词
                        if (!fallback) check(key + " 默认不换词", io.calls.convert.length, 0);
                        // 兜底最多多一次模型调用（换词）；B 的转写合并在常规压义项调用里
                        check(key + " 至多一次额外调用", io.calls.convert.length <= 1, true);
                        if (r.fallback) {
                            check(key + " fallback 字段可追溯",
                                ["kind", "originalWord", "dictionary", "target"].every(function (k) { return !!r.fallback[k]; }), true);
                        }
                    });
                });
            });
        });
    });
    return jobs.reduce(function (p, job) { return p.then(job); }, Promise.resolve());
}

function testFailures() {
    console.log("\n== 兜底失败分支");
    var dicts = config(["NOAD"]);
    var o = opts({ word: "xyzzy", dictionaries: dicts, fallback: true });
    L.clearMemo();
    return L.resolve(o, stubIO(dicts, {})).then(function (r) {
        check("A 换词失败 → none 且说明兜底失败", [r.status, r.fallbackFailed], ["none", "A"]);
        check("A 失败文案提到兜底（目标英语 → 英文）", /The fallback \(A\) didn\u2019t work either/.test(L.statusMessage(r, "xyzzy")), true);
        L.clearMemo();
        return L.resolve(opts({ word: "xyzzy", dictionaries: dicts, fallback: true }), stubIO(dicts, { "xyzzy>en": "plugh" }));
    }).then(function (r) {
        check("A 换词后仍查不到 → none", [r.status, r.fallbackFailed, r.fallback.convertedWord], ["none", "A", "plugh"]);
        L.clearMemo();
        return L.resolve(opts({ word: "water", dictionaries: config(["NOAD"]), systemLanguages: ["es-ES"], fallback: true }),
            stubIO(config(["NOAD"]), {}));
    }).then(function (r) {
        check("拉丁非英语目标 + 兜底 → B 转写", [r.status, r.fallback && r.fallback.kind, r.transcribe], ["ok", "B", true]);
        check("B 的说明文案（目标西语，无西语文案表 → 英文）", L.fallbackNotice(r),
            "Senses rewritten from English into Spanish by the on-device model (original from New Oxford American Dictionary)");
        var none = { status: "none", reason: "not-found", decision: L.decide({ word: "agua", dictionaries: config(["NOAD"]), systemLanguages: ["en"] }) };
        check("无合适词典文案写清划的词与目标语言", /\u201cagua\u201d/.test(L.statusMessage(none, "agua")) &&
            /English/.test(L.statusMessage(none, "agua")), true);
    });
}

function testSpanish() {
    console.log("\n== 西英词典（验收硬要求）");
    var dicts = config(["NOAD", "ESEN"]);
    L.clearMemo();
    return L.resolve(opts({ word: "agua", dictionaries: dicts, systemLanguages: ["en-US"] }), stubIO(dicts)).then(function (r) {
        console.log("  系统英文划 agua：" + rule(r));
        check("系统英文划西语词选西英", [r.status, r.entry && r.entry.dict, r.fallback], ["ok", DICTS.ESEN.name, null]);
        L.clearMemo();
        return L.resolve(opts({ word: "water", dictionaries: dicts, systemLanguages: ["es-ES"] }), stubIO(dicts));
    }).then(function (r) {
        console.log("  系统西语划 water：" + rule(r));
        check("系统西语划英文词选西英（英→西方向）", [r.status, r.entry && r.entry.dict, r.fallback], ["ok", DICTS.ESEN.name, null]);
        L.clearMemo();
        return L.resolve(opts({ word: "water", dictionaries: dicts, systemLanguages: ["en-US"] }), stubIO(dicts));
    }).then(function (r) {
        console.log("  系统英文划 water：" + rule(r));
        check("系统英文划英文词仍选英英单语", r.entry && r.entry.dict, DICTS.NOAD.name);
    });
}

/* ---------------- 试用问题回归（OPENCLAW_TASK_TRIAL1） ---------------- */

var HAN = /[\u3400-\u9fff]/;

function testColossal() {
    console.log("\n== colossal：NOAD 的英文释义必须命中");
    // dictlookup 修正后 NOAD 对 colossal 给 explains=en（之前因词源 from French… 误判为 es?）
    var noad = { name: DICTS.NOAD.name, latin: { explains: "en", pair: ["en"] },
                 contents: { colossal: "en", algebra: "en", government: "en" } };
    var dicts = [noad, DICTS.OXZH];
    DICTS.OXZH.contents.colossal = "zh-Hans";
    var words = ["colossal", "algebra", "government"];
    return words.reduce(function (p, w) {
        return p.then(function () {
            L.clearMemo();
            return L.resolve(opts({ word: w, dictionaries: dicts, systemLanguages: ["en-US"] }), stubIO(dicts)).then(function (r) {
                check(w + " target=en → ok 且命中 NOAD", [r.status, r.entry && r.entry.dict], ["ok", DICTS.NOAD.name]);
            });
        });
    }, Promise.resolve());
}

// 四种失败状态的结果（不依赖 resolve，直接构造），用于文案与按钮断言
function failureResults(target) {
    var dicts = config(["NOAD", "ESEN"]);
    var d = function (word) { return L.decide({ word: word, dictionaries: dicts, systemLanguages: [target] }); };
    return {
        dicts: dicts,
        cases: [
            { name: "未收录", word: "xyzzy", r: { status: "none", reason: "not-found", decision: d("xyzzy"), data: { entries: [] } } },
            { name: "语言不符", word: "colossal", r: { status: "none", reason: "wrong-language", decision: d("colossal"),
                data: { entries: [{ dict: DICTS.NOAD.name, explains: "en", text: "colossal …" }] } } },
            { name: "无可判断", word: "water", r: { status: "unsupported", decision: d("water"), data: { entries: [] } } },
            { name: "兜底失败", word: "agua", r: { status: "none", reason: "not-found", decision: d("agua"), data: { entries: [] },
                fallbackFailed: "A", failureCode: "not-converted", failureArgs: ["en"],
                fallback: { kind: "A", originalWord: "agua", convertedLanguage: "en", dictionary: DICTS.NOAD.name, target: target } } }
        ]
    };
}

function testMessages() {
    console.log("\n== 文案跟随目标语言");
    // 目标语言为西语时，没有西语文案表，按英文出
    var expectLang = { "en": "en", "zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant", "ja": "ja", "es": "en" };
    Object.keys(expectLang).forEach(function (target) {
        var fr = failureResults(target);
        fr.cases.forEach(function (c) {
            var msg = L.statusMessage(c.r, c.word, fr.dicts);
            check(target + " " + c.name + "：文案语言", L.messageLanguage(c.r.decision.target), expectLang[target]);
            check(target + " " + c.name + "：不出现「拉丁字母」", /拉丁字母/.test(msg), false);
            if (expectLang[target] === "en") check(target + " " + c.name + "：英文文案不含汉字", HAN.test(msg), false);
            else check(target + " " + c.name + "：中日文案含汉字", HAN.test(msg), true);
        });
    });
    var en = failureResults("en");
    var wrong = L.statusMessage(en.cases[1].r, "colossal", en.dicts);
    console.log("  en 语言不符：" + wrong);
    check("英语词描述为 an English word", /\u201ccolossal\u201d \(an English word\)/.test(wrong), true);
    var zh = failureResults("zh-Hans");
    var zhWrong = L.statusMessage(zh.cases[1].r, "colossal", zh.dicts);
    console.log("  zh-Hans 语言不符：" + zhWrong);
    check("中文描述为「这个英语词」", /这个英语词「colossal」/.test(zhWrong), true);
    check("繁中", /這個英語詞「colossal」/.test(L.statusMessage(failureResults("zh-Hant").cases[1].r, "colossal", zh.dicts)), true);
    // 划词语言按词典证据：agua 只在西英词典里且释义是英文 → 西班牙语词
    var oxzhOnly = { status: "none", reason: "wrong-language", decision: L.decide({ word: "colossal", dictionaries: zh.dicts.concat([DICTS.OXZH]), systemLanguages: ["en"] }),
                     data: { entries: [{ dict: DICTS.OXZH.name, explains: "zh-Hans" }] } };
    var oxzhDicts = [{ name: DICTS.OXZH.name, latin: { explains: "zh-Hans", pair: ["en", "zh-Hans"] } }];
    var oxzhMsg = L.statusMessage(oxzhOnly, "colossal", oxzhDicts);
    console.log("  en 只有英汉词典：" + oxzhMsg);
    check("英汉词典里的英文词也描述为英语词，单本用单数", /\(an English word\) is in 牛津英汉汉英词典, but it doesn\u2019t explain it in English/.test(oxzhMsg), true);
    var agua = { status: "none", reason: "wrong-language", decision: L.decide({ word: "agua", dictionaries: zh.dicts, systemLanguages: ["fr"] }),
                 data: { entries: [{ dict: DICTS.ESEN.name, explains: "en" }] } };
    check("agua 推断为西班牙语词", L.wordLanguageFromEvidence(agua.decision, agua.data.entries, zh.dicts), "es");
}

function testButtons() {
    console.log("\n== 失败状态的按钮栏");
    ["en", "zh-Hans", "zh-Hant", "ja"].forEach(function (target) {
        var fr = failureResults(target);
        fr.cases.forEach(function (c) {
            var v = L.statusView(c.r, c.word, fr.dicts);
            var ids = v.buttons.map(function (b) { return b.id; });
            check(target + " " + c.name + "：有「词典 App」与「更多」", ids, ["dictapp", "more"]);
            var original = c.r.fallback ? c.r.fallback.originalWord : c.word;
            check(target + " " + c.name + "：词典 App 链接带原始词", v.buttons[0].href, "dict://" + encodeURIComponent(original));
            var items = v.buttons[1].items.map(function (i) { return i.id; });
            check(target + " " + c.name + "：更多里三项", items, ["pick", "original", "settings"]);
            check(target + " " + c.name + "：日志字段", Object.keys(v.log).sort(),
                ["fallbackFailed", "reason", "rejected", "status", "target", "tried", "triedFirst", "word"]);
        });
    });
    var en = failureResults("en").cases;
    check("en 按钮文案", L.statusView(en[0].r, "xyzzy").buttons.map(function (b) { return b.label; }), ["Dictionary App", "More\u2026"]);
    check("zh-Hans 按钮文案", L.statusView(failureResults("zh-Hans").cases[0].r, "xyzzy").buttons.map(function (b) { return b.label; }), ["词典 App", "更多…"]);
    check("语言不符时「更多」可手动选词典", L.statusView(en[1].r, "colossal").buttons[1].items[0].dictionaries, [DICTS.NOAD.name]);
}

/* ---------------- 试用问题回归（OPENCLAW_TASK_TRIAL2） ---------------- */

// 词典桩：anthropologica 在插件顺序下被前缀命中譯典通（只有繁中释义）——复现原 bug；
// anthropological 在 NOAD 里有英文释义
var YDT = { name: "譯典通英漢雙向字典", latin: { explains: "zh-Hant", pair: ["en", "zh-Hant"] },
            contents: { anthropologica: "zh-Hant" } };
var NOAD2 = { name: DICTS.NOAD.name, latin: { explains: "en", pair: ["en"] },
              contents: { anthropological: "en", colossal: "en", university: "en" } };

function ioWithText(dicts, text) {
    var io = stubIO(dicts);
    var builds = 0;
    io.textIndex = function () { builds++; return Promise.resolve(text === null ? null : L.buildTextIndex(text)); };
    io.builds = function () { return builds; };
    return io;
}

var PAPER = "Anthropological fieldwork in the highlands.\f" +
    "The anthropological record shows that anthropological methods and anthropologists differ.\f" +
    "Archaeology and anthropology.";

function testCompletion() {
    console.log("\n== 划词补全（全文）");
    var dicts = [NOAD2, YDT];
    var run = function (word, text, extra, only) {
        L.clearMemo();
        var ds = only || dicts;
        var o = opts({ word: word, dictionaries: ds, systemLanguages: ["en-US"] });
        for (var k in extra || {}) o[k] = extra[k];
        var io = ioWithText(ds, text);
        return L.resolveWithCompletion(o, io).then(function (r) { r.__io = io; return r; });
    };
    return run("anthropologica", PAPER, { pageIndex: 1 }).then(function (r) {
        console.log("  anthropologica + 全文：" + rule(r) + " | " + L.completionNotice(r));
        check("anthropologica 补全成功且判英语", [r.status, r.entry && r.entry.dict, r.entry && r.entry.explains], ["ok", DICTS.NOAD.name, "en"]);
        check("补全结果与来源", [r.completion.original, r.completion.completed, r.completion.source], ["anthropologica", "anthropological", "fulltext"]);
        check("弹窗明说按原文补全", /Completed from the paper\u2019s text as \u201canthropological\u201d/.test(L.completionNotice(r)), true);
        return run("colossal", PAPER);
    }).then(function (r) {
        // 原文预检会读一次全文索引（插件里按条目缓存，每篇只读一次）；colossal 不在原文里、也没有前缀候选 → 不补全
        check("colossal 正常命中、不补全，全文索引至多读一次", [r.status, r.entry && r.entry.dict, !!r.completion, r.__io.builds() <= 1],
            ["ok", DICTS.NOAD.name, false, true]);
        return run("xyzzyq", PAPER);
    }).then(function (r) {
        check("全文无候选 → 不补全", [r.status, r.completion && r.completion.reason], ["none", "no-candidate"]);
        var msg = L.statusMessage(r, "xyzzyq", dicts);
        console.log("  无候选：" + msg);
        check("如实说明没找到", /No completion for it was found in the paper\u2019s text/.test(msg), true);
        return run("anthropologica", null);
    }).then(function (r) {
        check("没有全文 → 如实说明", [r.status, r.completion && r.completion.reason], ["none", "no-fulltext"]);
        check("没有全文的文案", /full text isn\u2019t available/.test(L.statusMessage(r, "anthropologica", dicts)), true);
        // 只有英英词典：补全为 anthropological 后只有英文释义，目标繁中 → 不匹配
        return run("anthropologica", PAPER, { systemLanguages: ["zh-Hant-HK"] }, [NOAD2]);
    }).then(function (r) {
        var msg = L.statusMessage(r, "anthropologica", dicts);
        console.log("  补全后仍不匹配目标（繁中）：" + msg);
        check("补全后仍不匹配：status 与补全记录", [r.status, r.reason, r.completion.completed, r.completion.matched],
            ["none", "wrong-language", "anthropological", false]);
        check("补全后仍不匹配的文案：先说补全了，再说没有繁中释义", /^依原文補全為「anthropological」.*這個英語詞「anthropological」.*繁體中文/.test(msg), true);
        check("词典 App 仍指向划词原文", L.statusView(r, "anthropologica", dicts).buttons[0].href, "dict://anthropologica");
        // 候选规则：编辑距离 ≤2、长度 ≤ 划词+4、必须在全文出现；同页优先
        var ix = L.buildTextIndex("universe universe universe\funiversity");
        check("同页优先于频次", L.completionCandidates("universi", ix, { pageIndex: 1 })[0].word, "university");
        check("无页信息时按频次", L.completionCandidates("universi", ix, {})[0].word, "universe");
        check("长度上限", L.completionCandidates("univ", L.buildTextIndex("universities"), {}).length, 0);
        check("编辑距离 ≤2 的 OCR 错字", L.completionCandidates("goverment", L.buildTextIndex("government"), {})[0].word, "government");
        check("汉字不猜", L.completionCandidates("政府", ix, {}).length, 0);
        // dictlookup 自己补的末字母也要明示
        L.clearMemo();
        var io = stubIO([NOAD2]);
        var inner = io.lookup;
        io.lookup = function (w, order, stop) {
            return inner("anthropological", order, stop).then(function (d) { d.completedFrom = w; d.word = "anthropological"; return d; });
        };
        // 原文里没有可补全的前缀候选 → 不预检；dictlookup 自己补了末字母，也要明示为「按词典补全」
        io.textIndex = function () { return Promise.resolve(L.buildTextIndex("A paper about something else entirely.")); };
        return L.resolveWithCompletion(opts({ word: "anthropologica", dictionaries: [NOAD2], systemLanguages: ["en-US"] }), io);
    }).then(function (r) {
        check("dictlookup 补全也明示", [r.completion.source, r.completion.inText], ["dictionary", 0]);
        check("原文里没有就说按词典补全", L.completionNotice(r), "Completed as \u201canthropological\u201d by the dictionary");
        // 原文预检：划词不在原文、原文有前缀候选 → 先按原文补，不让截断形命中别的语言的词典
        L.clearMemo();
        var ita = { name: "Oxford Paravia Il Dizionario inglese - italiano/italiano - inglese", latin: { explains: "it", pair: ["en", "it"] },
                    contents: { universi: "en" } };
        var ds = [NOAD2, ita];
        var io2 = ioWithText(ds, "University of Chicago.\fThe University press.");
        return L.resolveWithCompletion(opts({ word: "universi", dictionaries: ds, systemLanguages: ["en-US"], pageIndex: 0 }), io2);
    }).then(function (r) {
        console.log("  universi（原文有 University）：" + rule(r) + " | " + L.completionNotice(r));
        check("截断形不被意英词典抢先命中", [r.status, r.entry && r.entry.dict, r.completion && r.completion.completed, r.completion && r.completion.precheck],
            ["ok", DICTS.NOAD.name, "university", true]);
        // 划词本身在原文里出现过：不预检，按原词查
        L.clearMemo();
        var io3 = ioWithText([NOAD2], "the university and its universities");
        return L.resolveWithCompletion(opts({ word: "university", dictionaries: [NOAD2], systemLanguages: ["en-US"] }), io3);
    }).then(function (r) {
        check("原文里有这个词形就不补全", [r.status, !!r.completion], ["ok", false]);
    });
}

function testNumbering() {
    console.log("\n== 义项编号剥离");
    var arabic = "Caesar 1 Cae·sar | ˈsēzər | noun 1 a title used by Roman emperors • an autocrat. 2 Medicine British English informal a caesarean section. 3";
    var circled = "colossal | BrE kəˈlɒsl | adjective ① (large) 巨大的▸ he eats ② (large-scale) 大规模的 ③";
    var a = L.entrySenses(arabic), c = L.entrySenses(circled);
    console.log("  1/2 词条：" + JSON.stringify(a));
    console.log("  ①② 词条：" + JSON.stringify(c));
    var leading = /^\s*(?:\d|[\u2460-\u2473]|\(\d|（\d|[a-h][.)])/;
    check("1/2 词条无前导编号", a.some(function (x) { return leading.test(x); }), false);
    check("①② 词条无前导编号", c.some(function (x) { return leading.test(x); }), false);
    check("孤立数字被丢弃", a.concat(c).some(function (x) { return /^\d+$/.test(x); }), false);
    check("各形态统一剥离", L.cleanSenses(["1 a title", "2. two", "(3) three", "（4）four", "⑤ five", "a. six", "b) seven", "8", "", "a title stays"]),
        ["a title", "two", "three", "four", "five", "six", "seven", "a title stays"]);
    check("dictlookup 结构化义项（Caesar）逐条一致", L.cleanSenses(["a title used by Roman emperors", "an autocrat", "Medicine British English informal a caesarean section"]).length, 3);
    check("首选标签可见且跟随语言", ["en", "zh-Hans", "zh-Hant", "ja"].map(L.topBadge), ["best fit here", "按语境首选", "依語境首選", "文脈で最適"]);
}

/* ---------------- 试用问题回归（OPENCLAW_TASK_TRIAL3）：义项呈现 ---------------- */

function testSensePresentation() {
    console.log("\n== 义项呈现：标签、音标、截断");
    check("noun 开头", L.cleanSenses(["noun a person professionally involved in politics"]), ["a person professionally involved in politics"]);
    check("derogatory 开头", L.cleanSenses(["derogatory a person who acts in a devious way"]), ["a person who acts in a devious way"]);
    check("informal chiefly 连续标签", L.cleanSenses(["informal chiefly British a party"]), ["a party"]);
    check("领域 + 地区 + 语体连续", L.cleanSenses(["Medicine British English informal a caesarean section"]), ["a caesarean section"]);
    check("词性缩写与 transitive 等", L.cleanSenses(["v. transitive to order", "adj. large", "prep. near", "auxiliary verb used to form"]),
        ["to order", "large", "near", "used to form"]);
    check("剥完为空则丢弃", L.cleanSenses(["noun", "derogatory informal", "verb [with object]", "1 noun"]), []);
    check("首字母保持原样", L.cleanSenses(["informal a person", "derogatory Someone important"]), ["a person", "Someone important"]);
    check("正文开头的普通词不误删", L.cleanSenses(["especially in politics, the art of governing", "often a large building"]),
        ["especially in politics, the art of governing", "often a large building"]);
    // 音标与变位表、行内词性段（decree）
    check("变位表与行内 verb 段整块切掉", L.cleanSenses([
        "a judgment or decision of certain law courts. verb (decrees | dəˈkrēz, dēˈkrēz |) (, decreeing | dəˈkrēiNG |) [with object] order"]),
        ["a judgment or decision of certain law courts"]);
    check("义项里的 IPA 一律删", L.cleanSenses(["the land | baNGk | alongside a river /ˈrivər/"]), ["the land alongside a river"]);
    check("(as noun) 括注删除", L.cleanSenses(["US informal (as noun) a fool"]), ["a fool"]);
    // 截断：两行预算，落在词边界，不切断单词
    var long = "a person who acts in a manipulative and devious way, typically to gain advancement within an organization";
    var cut = L.cleanSenses(["derogatory " + long])[0];
    console.log("  截断：" + cut);
    check("超长加省略号", /…$/.test(cut), true);
    var lastWord = cut.replace(/…$/, "").split(" ").pop();
    check("截断落在词边界（最后一个词是原文里的完整词）", long.split(/[\s,]+/).indexOf(lastWord) >= 0, true);
    check("不超过两行预算", cut.length <= 96, true);
    check("短义项不截断", L.truncateSense("an autocrat"), "an autocrat");
    var zh = L.truncateSense(new Array(80).join("国"));
    check("汉字按双宽计、两行内", zh.length <= 48 && /…$/.test(zh), true);
    // politicians：NOAD 的两条义项（dictlookup 输出原文）改后的完整文本
    var pol = L.cleanSenses([
        "a person who is professionally involved in politics, especially as a holder of or a candidate for an elected office",
        "derogatory a person who acts in a manipulative and devious way, typically to gain advancement within an organization"]);
    console.log("  politicians：" + JSON.stringify(pol));
    check("politicians 两条都无前导标签", pol.every(function (x) { return /^a person/.test(x); }), true);
}

/* ---------------- 模型输出校验（OPENCLAW_TASK_TRIAL4） ---------------- */

function testValidation() {
    console.log("\n== 模型输出校验与重试");
    var raw = "colossal co·los·sal | kəˈläs(ə)l | adjective extremely large: a colossal amount of mail";
    var rules = function (senses) { return L.validateSenses(senses, { lang: "en", raw: raw }).map(function (v) { return v.rule; }); };
    check("带 noun 判不合格", rules(["noun extremely large"]), ["pos"]);
    check("带 | … | 音标判不合格", rules(["extremely large | kəˈläs(ə)l |"]), ["ipa"]);
    check("带 1 编号判不合格", rules(["1 extremely large"]), ["number"]);
    check("超 80 字符判不合格", rules([new Array(82).join("a")]), ["length"]);
    check("语体标签判不合格", rules(["informal extremely large"]), ["register"]);
    check("句号结尾判不合格", rules(["extremely large."]), ["period"]);
    check("首字母无故大写判不合格", rules(["Extremely large"]), ["capitalized"]);
    check("汉字超两行判不合格", L.validateSenses([new Array(60).join("大")], { lang: "zh-Hans" }).map(function (v) { return v.rule; }), ["twoLines"]);
    check("任一条不合格即整体不合格", rules(["extremely large", "noun huge"]), ["pos"]);
    check("合格输出无违规", rules(["extremely large", "(of a statue) at least twice life size"]), []);
    check("正文里的 verb 一词不误判", rules(["a verb phrase used in grammar"]), []);
    // 兼作形容词的语体词：只有后面跟冠词、to、另一个标签或括号时才算标签（真实模型输出 decree：formal command by ruler）
    check("formal 作形容词不误判", rules(["formal command by ruler"]), []);
    check("formal 作标签（后跟冠词）判不合格", rules(["formal a written command"]), ["register"]);
    check("显示层不误剥形容词 formal", L.cleanSenses(["formal command by ruler", "technical term in law"]), ["formal command by ruler", "technical term in law"]);
    check("显示层仍剥标签用法的 formal / literary", L.cleanSenses(["formal a written command", "literary used to describe the sea"]),
        ["a written command", "used to describe the sea"]);
    check("专名词头派生词的大写放行（Caesar → Caesarean）",
        L.validateSenses(["Caesarean section"], { lang: "en", raw: "Caesar … a caesarean section", word: "Caesar" }), []);

    var script = function (answers) {
        var calls = [];
        var fn = function (feedback, previous) {
            calls.push({ feedback: feedback, previous: previous });
            var a = answers[calls.length - 1];
            return Promise.resolve(a === undefined ? null : a === null ? null : { senses: a, raw: a.join("; ") });
        };
        fn.calls = calls;
        return fn;
    };
    var o = { lang: "en", raw: raw, word: "colossal", mode: "condense" };
    var ok = script([["extremely large"]]);
    return L.validatedGeneration(ok, o).then(function (r) {
        check("一次合格 → pass、只调一次", [r.status, r.attempts, ok.calls.length, r.senses], ["pass", 1, 1, ["extremely large"]]);
        var retry = script([["noun extremely large", "1 huge"], ["extremely large", "huge"]]);
        return L.validatedGeneration(retry, o).then(function (r2) {
            check("重试后合格则采用", [r2.status, r2.attempts, r2.senses], ["retry-pass", 2, ["extremely large", "huge"]]);
            check("重试时附上不合格原因", /part-of-speech label \(noun\).*numbering/.test(retry.calls[1].feedback), true);
            check("重试时附上上次输出", retry.calls[1].previous, "noun extremely large; 1 huge");
            check("日志记第一次被拦的规则", r2.log.firstRules, ["pos", "number"]);
        });
    }).then(function () {
        var bad = script([["noun extremely large"], ["extremely large | kəˈläs(ə)l |"]]);
        return L.validatedGeneration(bad, o).then(function (r3) {
            check("两次不合格 → fail、退回规则层（senses 为 null）", [r3.status, r3.attempts, r3.senses], ["fail", 2, null]);
            check("只重试一次", bad.calls.length, 2);
            check("日志写明两次被哪条规则拦下、原文是什么", [r3.log.firstRules, r3.log.secondRules, r3.log.rejected],
                [["pos"], ["ipa"], [{ attempt: 1, rule: "pos", sense: "noun extremely large" },
                                    { attempt: 2, rule: "ipa", sense: "extremely large | kəˈläs(ə)l |" }]]);
        });
    }).then(function () {
        var none = script([null]);
        return L.validatedGeneration(none, o).then(function (r4) {
            check("模型不可用 → unavailable、不重试", [r4.status, none.calls.length], ["unavailable", 1]);
        });
    }).then(function () {
        check("中文反馈", L.feedbackFor(L.validateSenses(["巨大的。"], { lang: "zh-Hans" }), "zh-Hans"), "问题：有一条像整句一样以句号结尾，请写成短语、去掉句号。");
        // 单一来源：dictlookup 切分用的词性词必须都在 SENSE_RULES 里
        var objc = require("fs").readFileSync(require("path").join(__dirname, "../native/dictlookup.m"), "utf8");
        var m = objc.match(/NSArray \*posWords = @\[([\s\S]*?)\];/);
        var objcPos = (m ? m[1].match(/@"([^"]+)"/g) : []).map(function (x) { return x.slice(2, -1); });
        var known = L.SENSE_RULES.pos.concat(["modal verb", "auxiliary verb"]);
        check("dictlookup 的词性词是 SENSE_RULES 的子集", objcPos.filter(function (w) { return known.indexOf(w) < 0; }), []);
        check("dictlookup 词性词表非空", objcPos.length > 5, true);
        // 显示层清理与校验同源：清理后的输出必须通过校验
        var cleaned = L.cleanSenses(["noun extremely large", "informal chiefly British a party", "1 a title", "the land | baNGk | by a river"]);
        check("清理后的义项全部通过校验", L.validateSenses(cleaned, { lang: "en" }), []);
    });
}

testRules();
testSensePresentation();
testSpanish().then(testValidation).then(testCompletion).then(testNumbering).then(testColossal).then(function () { testMessages(); testButtons(); }).then(runMatrix).then(testFailures).then(function () {
    console.log("\n" + passed + " 通过，" + failures + " 失败");
    process.exit(failures ? 1 : 0);
});
