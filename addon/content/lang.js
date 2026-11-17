// 解释语言与词典选择：纯函数，无 Zotero / 文件依赖，bootstrap.js 与 scripts/js_logic_test.js 共用
//
// 规则（以 docs/languages.md 为准）：
//   1. 目标语言 = 用户显式设置；否则取系统首选语言列表第一项。勾了「只在同语言内解释」则目标语言 = 划词本身的语言
//   2. 在允许的词典（全部，或用户选定的子集）里按用户顺序逐本尝试，
//      选第一本「收录当前划的词」且「对这个词实际给出的释义是目标语言」的词典，命中即停
//   3. 一本都不满足：默认显示明确的「没有合适的词典」；用户开启兜底后才走 A（换词）/ B（转写），且结果带 fallback 字段
//
// 释义语言只认 dictlookup 对实际文本的判定（entry.explains）；探测签名只用来跳过根本查不了这类词的词典

"use strict";

var SysDictLang = (function () {
    var LABELS = {
        "en": "英语",
        "zh-Hans": "简体中文",
        "zh-Hant": "繁体中文",
        "ja": "日语",
        "ko": "韩语",
        "es": "西班牙语",
        "fr": "法语",
        "de": "德语",
        "it": "意大利语",
        "pt": "葡萄牙语",
        "ru": "俄语"
    };

    // 释义语言判定按词典的语言对做（见 docs/languages.md），拉丁字母的非英语目标也能判，不再设闸。
    // 仍保留 unsupported 状态，供探测给不出语言码（"xx?"）的目标使用
    var SUPPORTED = null;

    // 同一语言内的优先顺序：已知质量好的放前面，其余按名称。不按名字判断语言，只用来排序
    var PREFERRED = [
        "New Oxford American Dictionary",
        "Oxford Dictionary of English",
        "牛津英汉汉英词典",
        "譯典通英漢雙向字典",
        "现代汉语规范词典",
        "五南國語活用辭典",
        "商務新詞典（全新版）"
    ];

    var MAX_ORDER = 40;

    // 语言名。第二个参数是提示文案的语言（en / zh-Hans / zh-Hant / ja）；省略时用中文（设置面板沿用）
    function label(lang, msgLang) {
        var names = msgLang ? (LANG_NAMES[msgLang] || LANG_NAMES.en) : LABELS;
        if (!lang) return msgLang ? MESSAGES[messageLanguage(msgLang)].unknownLanguage : "未知";
        return names[lang] || lang;
    }

    /* ---------------- 查词提示的文案：跟随本次的目标语言 ----------------
     * 设置面板的界面语言与这里无关（面板目前只有中文界面，不随目标语言变）。
     * 只有这张表里的语言有完整文案，其余目标语言用英文。
     */
    var LANG_NAMES = {
        "en": { "en": "English", "zh-Hans": "Simplified Chinese", "zh-Hant": "Traditional Chinese", "zh": "Chinese",
                "ja": "Japanese", "ko": "Korean", "es": "Spanish", "fr": "French", "de": "German", "it": "Italian",
                "pt": "Portuguese", "ru": "Russian", "ca": "Catalan", "nl": "Dutch" },
        "zh-Hans": { "en": "英语", "zh-Hans": "简体中文", "zh-Hant": "繁体中文", "zh": "中文", "ja": "日语", "ko": "韩语",
                     "es": "西班牙语", "fr": "法语", "de": "德语", "it": "意大利语", "pt": "葡萄牙语", "ru": "俄语",
                     "ca": "加泰罗尼亚语", "nl": "荷兰语" },
        "zh-Hant": { "en": "英語", "zh-Hans": "簡體中文", "zh-Hant": "繁體中文", "zh": "中文", "ja": "日語", "ko": "韓語",
                     "es": "西班牙語", "fr": "法語", "de": "德語", "it": "義大利語", "pt": "葡萄牙語", "ru": "俄語",
                     "ca": "加泰隆尼亞語", "nl": "荷蘭語" },
        "ja": { "en": "英語", "zh-Hans": "簡体字中国語", "zh-Hant": "繁体字中国語", "zh": "中国語", "ja": "日本語",
                "ko": "韓国語", "es": "スペイン語", "fr": "フランス語", "de": "ドイツ語", "it": "イタリア語",
                "pt": "ポルトガル語", "ru": "ロシア語", "ca": "カタルーニャ語", "nl": "オランダ語" }
    };

    var MESSAGES = {
        "en": {
            completedFromText: function (c, n) { return "Completed from the paper\u2019s text as \u201c" + c + "\u201d" + (n ? " (appears " + n + "\u00d7)" : ""); },
            completedByDictionary: function (c) { return "Completed as \u201c" + c + "\u201d by the dictionary"; },
            completionNone: " No completion for it was found in the paper\u2019s text.",
            completionNoText: " The paper\u2019s full text isn\u2019t available, so it couldn\u2019t be completed.",
            topBadge: "best fit here",
            unknownLanguage: "unknown",
            word: function (w, lang) {
                if (!lang) return "\u201c" + w + "\u201d";
                return "\u201c" + w + "\u201d (" + (/^[AEIOU]/.test(lang) ? "an " : "a ") + lang + " word)";
            },
            notFound: function (w, t) { return "None of the allowed dictionaries has an entry for " + w + ", so it can\u2019t be explained in " + t + "."; },
            wrongLanguage: function (w, t, found, n) {
                return w + " is in " + found + ", but " + (n === 1 ? "it doesn\u2019t explain it" : "none of them explains it") + " in " + t + ".";
            },
            noDictionary: function (w, t) { return "No enabled dictionary can explain " + w + " in " + t + "."; },
            unsupported: function (w, t) { return "Can\u2019t tell which dictionary explains " + w + " in " + t + "."; },
            fallbackFailed: function (kind, why) { return " The fallback (" + kind + ") didn\u2019t work either: " + why + "."; },
            whyNoDictionary: "no dictionary is available",
            whyNotConverted: function (l) { return "the on-device model couldn\u2019t map it to a " + l + " word"; },
            whyConvertedMissing: function (w, d) { return "\u201c" + w + "\u201d isn\u2019t in " + d + " either"; },
            hint: "Enable dictionaries in Dictionary.app \u2192 Settings, or change the explanation language, dictionary scope or fallback in Zotero Settings \u2192 System Dictionary.",
            dictionaryCount: function (n) { return n === 1 ? "1 dictionary" : n + " dictionaries"; },
            noticeA: function (o, l, c, d) { return "Read \u201c" + o + "\u201d as the " + l + " word \u201c" + c + "\u201d from context (" + d + ")"; },
            noticeB: function (s, t, d) { return "Senses rewritten from " + s + " into " + t + " by the on-device model (original from " + d + ")"; },
            explainedIn: function (l) { return "(" + l + " explanation)"; },
            transcribeFailed: function (l) { return "(" + l + " explanation; rewriting failed)"; },
            noEntry: function (w) { return "No entry for \u201c" + w + "\u201d"; },
            buttons: { dictApp: "Dictionary App", more: "More\u2026", pick: "Look up in", original: "Show the original entry",
                       settings: "Plugin settings", noEntries: "No dictionary has this word", originalButton: "Original", lookupOriginal: "Original word" }
        },
        "zh-Hans": {
            completedFromText: function (c, n) { return "按原文补全为「" + c + "」" + (n ? "（原文出现 " + n + " 次）" : ""); },
            completedByDictionary: function (c) { return "按词典补全为「" + c + "」"; },
            completionNone: "在原文里没找到可补全的词。",
            completionNoText: "没有可用的全文，无法补全。",
            topBadge: "按语境首选",
            unknownLanguage: "未知",
            word: function (w, lang) { return lang ? "这个" + lang + "词「" + w + "」" : "「" + w + "」"; },
            notFound: function (w, t) { return "允许范围内没有词典收录" + w + "，无法用" + t + "解释。"; },
            wrongLanguage: function (w, t, found) { return found + "收录了" + w + "，但没有一本用" + t + "解释。"; },
            noDictionary: function (w, t) { return "没有已启用的词典能用" + t + "解释" + w + "。"; },
            unsupported: function (w, t) { return "无法判断哪本词典用" + t + "解释" + w + "。"; },
            fallbackFailed: function (kind, why) { return "兜底（" + kind + "）也没成功：" + why + "。"; },
            whyNoDictionary: "没有可用的词典",
            whyNotConverted: function (l) { return "端侧模型没能把它换成" + l + "的词"; },
            whyConvertedMissing: function (w, d) { return "「" + w + "」在" + d + "里也查不到"; },
            hint: "可在「词典」App → 设置 里勾选并下载词典，或在 Zotero 设置 → 系统词典 里改解释语言、词典范围或开启兜底。",
            dictionaryCount: function (n) { return n + " 本词典"; },
            noticeA: function (o, l, c, d) { return "已把「" + o + "」按语境理解为" + l + "的「" + c + "」（" + d + "）"; },
            noticeB: function (s, t, d) { return "释义已由端侧模型从" + s + "转写为" + t + "（原文来自 " + d + "）"; },
            explainedIn: function (l) { return "（" + l + "释义）"; },
            transcribeFailed: function (l) { return "（" + l + "释义，转写失败）"; },
            noEntry: function (w) { return "未收录「" + w + "」"; },
            buttons: { dictApp: "词典 App", more: "更多…", pick: "用这本词典查", original: "查看原文释义",
                       settings: "插件设置", noEntries: "没有词典收录这个词", originalButton: "原文", lookupOriginal: "查原词" }
        },
        "zh-Hant": {
            completedFromText: function (c, n) { return "依原文補全為「" + c + "」" + (n ? "（原文出現 " + n + " 次）" : ""); },
            completedByDictionary: function (c) { return "依辭典補全為「" + c + "」"; },
            completionNone: "在原文裡沒找到可補全的詞。",
            completionNoText: "沒有可用的全文，無法補全。",
            topBadge: "依語境首選",
            unknownLanguage: "未知",
            word: function (w, lang) { return lang ? "這個" + lang + "詞「" + w + "」" : "「" + w + "」"; },
            notFound: function (w, t) { return "允許範圍內沒有辭典收錄" + w + "，無法用" + t + "解釋。"; },
            wrongLanguage: function (w, t, found) { return found + "收錄了" + w + "，但沒有一本用" + t + "解釋。"; },
            noDictionary: function (w, t) { return "沒有已啟用的辭典能用" + t + "解釋" + w + "。"; },
            unsupported: function (w, t) { return "無法判斷哪本辭典用" + t + "解釋" + w + "。"; },
            fallbackFailed: function (kind, why) { return "備援（" + kind + "）也沒成功：" + why + "。"; },
            whyNoDictionary: "沒有可用的辭典",
            whyNotConverted: function (l) { return "裝置端模型沒能把它換成" + l + "的詞"; },
            whyConvertedMissing: function (w, d) { return "「" + w + "」在" + d + "裡也查不到"; },
            hint: "可在「辭典」App → 設定 裡勾選並下載辭典，或在 Zotero 設定 → 系統詞典 裡改解釋語言、辭典範圍或開啟備援。",
            dictionaryCount: function (n) { return n + " 本辭典"; },
            noticeA: function (o, l, c, d) { return "已把「" + o + "」依語境理解為" + l + "的「" + c + "」（" + d + "）"; },
            noticeB: function (s, t, d) { return "釋義已由裝置端模型從" + s + "轉寫為" + t + "（原文來自 " + d + "）"; },
            explainedIn: function (l) { return "（" + l + "釋義）"; },
            transcribeFailed: function (l) { return "（" + l + "釋義，轉寫失敗）"; },
            noEntry: function (w) { return "未收錄「" + w + "」"; },
            buttons: { dictApp: "辭典 App", more: "更多…", pick: "用這本辭典查", original: "查看原文釋義",
                       settings: "外掛設定", noEntries: "沒有辭典收錄這個詞", originalButton: "原文", lookupOriginal: "查原詞" }
        },
        "ja": {
            completedFromText: function (c, n) { return "本文から「" + c + "」に補完しました" + (n ? "（本文に " + n + " 回）" : ""); },
            completedByDictionary: function (c) { return "辞書で「" + c + "」に補完しました"; },
            completionNone: "本文に補完できる語が見つかりませんでした。",
            completionNoText: "本文のテキストがないため補完できません。",
            topBadge: "文脈で最適",
            unknownLanguage: "不明",
            word: function (w, lang) { return lang ? lang + "の語「" + w + "」" : "「" + w + "」"; },
            notFound: function (w, t) { return "許可された辞書に" + w + "の項目がないため、" + t + "で説明できません。"; },
            wrongLanguage: function (w, t, found) { return found + "に" + w + "はありますが、" + t + "で説明している辞書はありません。"; },
            noDictionary: function (w, t) { return w + "を" + t + "で説明できる辞書が有効になっていません。"; },
            unsupported: function (w, t) { return w + "をどの辞書が" + t + "で説明しているか判断できません。"; },
            fallbackFailed: function (kind, why) { return "代替手段（" + kind + "）も失敗しました：" + why + "。"; },
            whyNoDictionary: "使える辞書がありません",
            whyNotConverted: function (l) { return "オンデバイスモデルが" + l + "の語に置き換えられませんでした"; },
            whyConvertedMissing: function (w, d) { return "「" + w + "」は" + d + "にもありません"; },
            hint: "「辞書」App → 設定 で辞書を有効にするか、Zotero の設定 → 系統詞典 で説明言語・辞書の範囲・代替手段を変更してください。",
            dictionaryCount: function (n) { return n + " 冊の辞書"; },
            noticeA: function (o, l, c, d) { return "「" + o + "」を文脈から" + l + "の「" + c + "」と解釈しました（" + d + "）"; },
            noticeB: function (s, t, d) { return "語義はオンデバイスモデルが" + s + "から" + t + "に書き換えました（原文：" + d + "）"; },
            explainedIn: function (l) { return "（" + l + "の説明）"; },
            transcribeFailed: function (l) { return "（" + l + "の説明。書き換えに失敗）"; },
            noEntry: function (w) { return "「" + w + "」は見つかりません"; },
            buttons: { dictApp: "辞書 App", more: "その他…", pick: "この辞書で引く", original: "元の項目を見る",
                       settings: "プラグインの設定", noEntries: "この語を収録した辞書はありません", originalButton: "原文", lookupOriginal: "元の語" }
        }
    };

    // 提示文案用的语言：表里有就用，中文简繁按目标，其余用英文
    function messageLanguage(target) {
        if (MESSAGES[target]) return target;
        if (target === "zh") return "zh-Hans";
        return "en";
    }

    function texts(target) { return MESSAGES[messageLanguage(target)]; }

    // 划的词是什么语言：按词典证据推断，不说「拉丁字母」。
    //   汉字 / 假名 / 谚文 → 中文 / 日语 / 韩语
    //   拉丁字母：被英英单语词典收录 → 英语；只在双语 {en, X} 词典里、且释义是英语 → X；推不出就不说
    function wordLanguageFromEvidence(decision, entries, dictionaries) {
        var script = decision.wordScript;
        if (script === "han") return decision.wordLanguage || "zh";
        if (script === "kana") return "ja";
        if (script === "hangul") return "ko";
        var byName = {};
        (dictionaries || []).forEach(function (d) { byName[d.name] = d; });
        // 语言对：探测结果里的 pair；旧缓存没有 pair 时由「英文词用什么解释」推出
        var pairOf = function (d) {
            if (!d || !d.latin) return null;
            if (d.latin.pair) return d.latin.pair;
            var x = d.latin.explains;
            return x ? (x === "en" ? ["en"] : ["en", x]) : null;
        };
        var list = entries || [];
        for (var i = 0; i < list.length; i++) {
            var pair = pairOf(byName[list[i].dict]);
            if (pair && pair.length === 1 && pair[0] === "en") return "en";
        }
        for (var k = 0; k < list.length; k++) {
            var pk = pairOf(byName[list[k].dict]);
            if (pk && pk.length === 2 && /^[a-z]{2,3}(-[A-Z][a-z]{3})?$/.test(pk[1])) {
                if (list[k].explains === "en") return pk[1];
                if (list[k].explains === pk[1] || matchLevel(list[k].explains, pk[1]) > 0) return "en";
            }
        }
        return null;
    }


    // BCP 47 → 本模块的语言码
    function normalizeLang(tag) {
        var t = String(tag || "").replace(/_/g, "-");
        var lower = t.toLowerCase();
        if (!lower) return "";
        if (lower.indexOf("zh") === 0) {
            if (/-hant\b/.test(lower)) return "zh-Hant";
            if (/-hans\b/.test(lower)) return "zh-Hans";
            if (/-(tw|hk|mo)\b/.test(lower)) return "zh-Hant";
            return "zh-Hans";
        }
        if (lower === "yue" || lower.indexOf("yue-") === 0) return "zh-Hant";
        return lower.split("-")[0];
    }

    function wordScript(word) {
        var text = String(word || "");
        var han = (text.match(/[㐀-鿿]/g) || []).length;
        var kana = (text.match(/[぀-ヿ]/g) || []).length;
        var hangul = (text.match(/[가-힯]/g) || []).length;
        var latin = (text.match(/[A-Za-z]/g) || []).length;
        if (kana) return "kana";
        if (hangul) return "hangul";
        if (han && han >= latin) return "han";
        if (latin) return "latin";
        return "other";
    }

    // 划词本身的语言，只用于「同语言内解释」与提示文案
    function wordLanguage(word, systemLanguages) {
        var script = wordScript(word);
        if (script === "latin") return "en";      // 拉丁字母一律按英语处理；其他西文词判不准
        if (script === "kana") return "ja";
        if (script === "hangul") return "ko";
        if (script === "han") {
            // 汉字词的简繁跟随系统列表里第一个中文
            var list = systemLanguages || [];
            for (var i = 0; i < list.length; i++) {
                var lang = normalizeLang(list[i]);
                if (lang === "zh-Hans" || lang === "zh-Hant") return lang;
            }
            return "zh-Hans";
        }
        return "";
    }

    function resolveTarget(opts) {
        var pref = opts.targetPref || "auto";
        if (opts.sameLanguageOnly) {
            var own = wordLanguage(opts.word, opts.systemLanguages);
            if (own) return { lang: own, source: "same-language" };
        }
        if (pref !== "auto") return { lang: normalizeLang(pref), source: "user" };
        var first = (opts.systemLanguages || [])[0];
        return { lang: normalizeLang(first) || "en", source: "system" };
    }

    // 释义语言是否匹配目标：exact 为完全一致；中文简繁不一致或简繁未知时为 loose
    function matchLevel(explains, target) {
        if (!explains) return 0;
        if (explains === target) return 2;
        var zh = function (l) { return l === "zh" || l === "zh-Hans" || l === "zh-Hant"; };
        if (zh(explains) && zh(target)) return 1;
        return 0;
    }

    function headwordGroup(script) {
        return script === "han" || script === "kana" || script === "hangul" ? "han" : "latin";
    }

    // 允许的词典，按用户顺序：用户 order 里的在前（按其次序），其余按已知质量、再按名称。
    // scope 非空时只保留 scope 里的词典
    function allowedDictionaries(opts) {
        var all = opts.dictionaries || [];
        var scope = opts.scope && opts.scope.length ? opts.scope : null;
        var userOrder = opts.userOrder || [];
        var rank = function (name) {
            var u = userOrder.indexOf(name);
            if (u >= 0) return u;
            var p = PREFERRED.indexOf(name);
            return userOrder.length + (p < 0 ? PREFERRED.length : p);
        };
        return all
            .filter(function (d) { return !scope || scope.indexOf(d.name) >= 0; })
            .slice()
            .sort(function (a, b) {
                return rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
            });
    }

    // 查词顺序 = 允许的词典里能查这类词（拉丁 / 汉字）的那些，保持用户顺序。
    // 不按签名重排：签名只决定「能不能查这类词」，释义语言以实际文本为准
    var orderMemo = {};
    function buildOrder(opts) {
        var group = headwordGroup(wordScript(opts.word));
        var key = [group, opts.target, (opts.scope || []).join("|"), (opts.userOrder || []).join("|"),
                   opts.signature || (opts.dictionaries || []).length].join("#");
        if (orderMemo[key]) return orderMemo[key].slice();
        var order = allowedDictionaries(opts)
            .filter(function (d) { return d[group]; })
            .map(function (d) { return d.name; })
            .slice(0, MAX_ORDER);
        orderMemo[key] = order;
        return order.slice();
    }

    function clearMemo() { orderMemo = {}; }

    // entries 是 dictlookup 按 order 返回的结果（顺序一致），每条带 explains
    function pickEntry(entries, target) {
        var list = entries || [];
        for (var level = 2; level >= 1; level--) {
            for (var i = 0; i < list.length; i++) {
                if (matchLevel(list[i].explains, target) === level) {
                    return { entry: list[i], exact: level === 2 };
                }
            }
        }
        return null;
    }

    // 返回本次划词的决策（不查词）。dictionaries 为空（探测未完成或失败）时 status:"unknown"，调用方走旧逻辑
    function decide(opts) {
        var target = resolveTarget(opts);
        var base = {
            target: target.lang,
            targetSource: target.source,
            targetLabel: label(target.lang),
            wordLanguage: wordLanguage(opts.word, opts.systemLanguages),
            wordScript: wordScript(opts.word)
        };
        if (!opts.dictionaries || !opts.dictionaries.length) {
            base.status = "unknown";
            return base;
        }
        // 拉丁字母的非英语释义判不准；不开兜底时直接说明，开了兜底则交给 B 转写
        if (SUPPORTED && SUPPORTED.indexOf(target.lang) < 0 && !opts.fallback) {
            base.status = "unsupported";
            return base;
        }
        base.status = "ready";
        base.order = buildOrder({
            word: opts.word, target: target.lang, dictionaries: opts.dictionaries,
            userOrder: opts.userOrder, scope: opts.scope, signature: opts.signature
        });
        if (!base.order.length && !opts.fallback) {
            base.status = "none";
            base.reason = "no-dictionary";
        }
        return base;
    }

    // 兜底 A 换词用的语言 L：允许范围内排第一的词典「能查的词头语言」。
    // 单语词典即其释义语言；双语词典优先取「释义是目标语言」的那一侧，使查回来的释义尽量是目标语言
    function conversionLanguage(dict, target) {
        if (!dict) return null;
        var side = null;
        if (dict.latin && matchLevel(dict.latin.explains, target)) side = "latin";
        else if (dict.han && matchLevel(dict.han.explains, target)) side = "han";
        else side = dict.latin ? "latin" : dict.han ? "han" : null;
        if (side === "latin") return "en";
        if (side === "han") {
            var other = dict.latin && dict.latin.explains;
            if (other === "zh-Hant" || (dict.han.explains === "zh-Hant")) return "zh-Hant";
            return "zh-Hans";
        }
        return null;
    }

    // 编排：查词 → 选词典 →（开了兜底时）A / B。io 注入，便于单测打桩：
    //   io.lookup(word, order, stopAtLang) → Promise<dictlookup 结果>；stopAtLang 让 dictlookup 命中目标语言即停
    //   io.convert(word, lang) → Promise<string|null>（兜底 A，模型换词，超时 3 秒）
    // 返回 { status, entry, data, lang, transcribe, fallback, reason, decision }
    //   status: ok | none | unsupported | legacy
    //   lang: 交给模型压义项时用的输出语言；transcribe 为真表示要转写（兜底 B）
    function resolve(opts, io) {
        var decision = decide(opts);
        var out = function (extra) {
            var r = { decision: decision, fallback: null, transcribe: false };
            for (var k in extra) r[k] = extra[k];
            return r;
        };
        if (decision.status === "unknown") return Promise.resolve(out({ status: "legacy" }));
        if (decision.status !== "ready") return Promise.resolve(out({ status: decision.status, reason: decision.reason }));

        var target = decision.target;
        var lookup = decision.order.length ? io.lookup(opts.word, decision.order, target) : Promise.resolve({ entries: [] });
        return lookup.then(function (data) {
            var entries = (data && data.entries) || [];
            var picked = pickEntry(entries, target);
            if (picked) {
                return out({ status: "ok", entry: picked.entry, exact: picked.exact, data: data, lang: target });
            }
            if (!opts.fallback) {
                return out({ status: "none", data: data, reason: entries.length ? "wrong-language" : "not-found" });
            }

            // 兜底 B：有词典收录，但释义不是目标语言 → 取顺序里第一本收录的，转写
            if (entries.length) {
                var source = entries[0];
                return out({
                    status: "ok", entry: source, data: data, lang: target, transcribe: true,
                    fallback: { kind: "B", originalWord: opts.word, dictionary: source.dict,
                                sourceLanguage: source.explains, target: target }
                });
            }

            // 兜底 A：允许范围内没有任何词典收录 → 按语境换成首位词典的语言 L 再查
            var first = allowedDictionaries(opts)[0];
            var L = conversionLanguage(first, target);
            if (!first || !L) {
                return out({ status: "none", data: data, reason: "not-found", fallbackFailed: "A", failureCode: "no-dictionary" });
            }
            var trace = { kind: "A", originalWord: opts.word, convertedLanguage: L, dictionary: first.name, target: target };
            return io.convert(opts.word, L).then(function (converted) {
                if (!converted) {
                    return out({ status: "none", data: data, reason: "not-found", fallbackFailed: "A",
                                 failureCode: "not-converted", failureArgs: [L], fallback: trace });
                }
                trace.convertedWord = converted;
                return io.lookup(converted, [first.name]).then(function (data2) {
                    var entry = ((data2 && data2.entries) || [])[0];
                    if (!entry) {
                        return out({ status: "none", data: data, reason: "not-found", fallbackFailed: "A",
                                     failureCode: "converted-missing", failureArgs: [converted, first.name], fallback: trace });
                    }
                    // 换词后查到的释义若仍不是目标语言，同一次压义项调用里顺带转写（不额外加模型调用）
                    var ok = matchLevel(entry.explains, target) > 0;
                    return out({ status: "ok", entry: entry, data: data2, lang: target, transcribe: !ok,
                                 exact: matchLevel(entry.explains, target) === 2, fallback: trace });
                });
            });
        });
    }

    // 失败原因的文案（resolve 返回 failureCode + failureArgs，这里按目标语言渲染）
    function failureText(result, t, msgLang) {
        var a = result.failureArgs || [];
        if (result.failureCode === "no-dictionary") return t.whyNoDictionary;
        if (result.failureCode === "not-converted") return t.whyNotConverted(label(a[0], msgLang));
        if (result.failureCode === "converted-missing") return t.whyConvertedMissing(a[0], a[1]);
        return "";
    }

    // 「没有合适的词典」等状态的提示文案，跟随目标语言。
    // result 为 resolve() 或 decide() 的返回值；dictionaries 用来推断划词语言（可省略）
    function statusMessage(result, word, dictionaries) {
        var d = result.decision || result;
        var msgLang = messageLanguage(d.target);
        var t = MESSAGES[msgLang];
        var entries = (result.data && result.data.entries) || [];
        var wl = wordLanguageFromEvidence(d, entries, dictionaries);
        var shown = result.completion && result.completion.matched === false ? result.completion.completed : word;
        var w = t.word(shown, wl ? label(wl, msgLang) : null);
        var target = label(d.target, msgLang);
        var status = result.status || d.status;
        var reason = result.reason || d.reason;
        var body;
        if (status === "unsupported") body = t.unsupported(w, target);
        else if (reason === "not-found") body = t.notFound(w, target);
        else if (reason === "wrong-language") {
            var names = entries.map(function (e) { return e.dict; });
            var found = names.length === 1 ? names[0] : t.dictionaryCount(names.length);
            body = t.wrongLanguage(w, target, found, names.length);
        } else body = t.noDictionary(w, target);
        if (result.fallbackFailed) body += t.fallbackFailed(result.fallbackFailed, failureText(result, t, msgLang));
        // 补全如实说明：没找到候选或候选都不合适 / 没有全文
        var c = result.completion;
        if (c && c.completed && c.matched === false) body = t.completedFromText(c.completed, c.candidate && c.candidate.freq) +
            (msgLang === "en" ? ". " : "。") + body;
        if (c && (c.reason === "no-candidate" || c.reason === "no-match")) body += t.completionNone;
        else if (c && c.reason === "no-fulltext") body += t.completionNoText;
        return body + (msgLang === "en" ? " " : "") + t.hint;
    }

    // 兜底的界面说明：必须明示，不允许静默替换。跟随目标语言
    function fallbackNotice(result) {
        var f = result.fallback;
        if (!f) return "";
        var msgLang = messageLanguage(f.target);
        var t = MESSAGES[msgLang];
        if (f.kind === "A") return t.noticeA(f.originalWord, label(f.convertedLanguage, msgLang), f.convertedWord, f.dictionary);
        return t.noticeB(label(f.sourceLanguage, msgLang), label(f.target, msgLang), f.dictionary);
    }

    // 失败状态的视图模型：提示文案 + 按钮栏（至少「词典 App」与「更多」）+ 日志字段。
    // bootstrap.js 只负责把它画出来，便于单测
    function statusView(result, word, dictionaries) {
        var d = result.decision || result;
        var t = texts(d.target);
        var entries = (result.data && result.data.entries) || [];
        var original = result.fallback && result.fallback.originalWord ||
            result.completion && result.completion.original || word;
        return {
            message: statusMessage(result, word, dictionaries),
            buttons: [
                { id: "dictapp", label: t.buttons.dictApp, href: "dict://" + encodeURIComponent(original) },
                { id: "more", label: t.buttons.more, items: [
                    { id: "pick", label: t.buttons.pick, dictionaries: entries.map(function (e) { return e.dict; }),
                      emptyLabel: t.buttons.noEntries },
                    { id: "original", label: t.buttons.original, available: entries.length > 0 },
                    { id: "settings", label: t.buttons.settings }
                ] }
            ],
            log: {
                word: word,
                target: d.target,
                status: result.status || d.status,
                reason: result.reason || d.reason || null,
                fallbackFailed: result.fallbackFailed || null,
                tried: (d.order || []).length,
                triedFirst: (d.order || []).slice(0, 12),
                rejected: entries.map(function (e) { return { dict: e.dict, explains: e.explains, basis: e.explainsBasis || null }; })
            }
        };
    }

    function buttonLabels(target) { return texts(target).buttons; }

    // 补全的界面说明（成功时）：按原文 / 按词典
    function completionNotice(result) {
        var c = result.completion;
        if (!c || !c.completed) return "";
        var t = texts(result.lang || (result.decision && result.decision.target));
        if (c.source === "fulltext") return t.completedFromText(c.completed, c.candidate && c.candidate.freq);
        if (c.inText) return t.completedFromText(c.completed, c.inText);
        return t.completedByDictionary(c.completed);
    }

    function topBadge(target) { return texts(target).topBadge; }

    function explainedIn(lang, target) { return texts(target).explainedIn(label(lang, messageLanguage(target))); }
    function transcribeFailed(lang, target) { return texts(target).transcribeFailed(label(lang, messageLanguage(target))); }
    function noEntry(word, target) { return texts(target).noEntry(word); }

    // 面板用：在当前设置下，划英文词 / 汉字词分别会用哪本词典、什么语言解释（按签名预估，实际以划词时的文本为准）
    function preview(opts, word) {
        var d = decide({
            word: word,
            targetPref: opts.targetPref,
            sameLanguageOnly: opts.sameLanguageOnly,
            systemLanguages: opts.systemLanguages,
            dictionaries: opts.dictionaries,
            userOrder: opts.userOrder,
            scope: opts.scope,
            fallback: opts.fallback
        });
        var group = headwordGroup(d.wordScript);
        var first = null;
        if (d.status === "ready") {
            (opts.dictionaries || []).some(function (x) {
                if (x.name === d.order[0] && x[group] && matchLevel(x[group].explains, d.target)) { first = x.name; return true; }
                return false;
            });
            if (!first) {
                d.order.some(function (name) {
                    var x = (opts.dictionaries || []).filter(function (y) { return y.name === name; })[0];
                    if (x && x[group] && matchLevel(x[group].explains, d.target)) { first = name; return true; }
                    return false;
                });
            }
        }
        return { decision: d, dictionary: first, fallback: !first && !!opts.fallback };
    }

    /* ---------------- 义项清理：编号、词性、语体标签、音标、截断 ----------------
     * 词性已不在义项行出现（标题行另行处理）；语体、领域、地区标签同样剥掉，连续出现就连续剥。
     * 音标与变位表只允许在标题行，义项里任何位置的读音片段都删；句中出现的另一词性段整块切掉。
     * 剥完为空或只剩数字的条目丢弃；首字母保持原样。每条最多两行，按词边界截断 */
    // 标签表：唯一来源。显示层清理（stripSenseNumber）与模型输出校验（validateSenses）都从这里取，
    // dictlookup 切分用的词性词由 scripts/lang_test.js 校验为这里的子集
    var SENSE_RULES = {
        senseChars: 80,          // 单条义项的字符上限（模型输出校验）
        twoLineWidth: 96,        // 两行的显示预算：面板 320px、12.5px 字号，汉字按双宽
        pos: ["noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "determiner", "interjection",
              "exclamation", "transitive", "intransitive", "auxiliary", "modal"],
        posAbbrev: ["n.", "v.", "vt.", "vi.", "adj.", "adv.", "prep.", "conj.", "pron."],
        posPrefix: ["masculine", "feminine", "neuter", "plural", "countable", "uncountable", "mass", "count"],
        register: ["derogatory", "informal", "slang", "archaic", "dated", "humorous", "vulgar", "offensive", "ironic",
                   "euphemistic", "disapproving", "approving", "dialect", "colloquial", "baby talk"],
        // 兼作普通形容词的语体词（formal command、technical term）：后面紧跟冠词、to、另一个标签或括号时才算标签
        registerAmbiguous: ["formal", "technical", "rare", "historical", "literary", "poetic", "figurative", "old-fashioned"],
        labelFollowers: ["a", "an", "the", "to", "of", "used", "someone", "something", "any", "one", "or", "and"],
        region: ["British English", "North American English", "US English", "American English", "Australian English",
                 "Canadian English", "Irish English", "Scottish English", "South African English", "Indian English",
                 "British", "North American", "US", "Scottish", "Irish", "Australian", "Canadian"],
        domain: ["Medicine", "Law", "Architecture", "Sculpture", "Physics", "Chemistry", "Biology", "Botany", "Zoology", "Computing",
                 "Mathematics", "Statistics", "Music", "Grammar", "Linguistics", "Philosophy", "Theology", "Finance", "Economics",
                 "Military", "Nautical", "Logic", "Anatomy", "Geology", "Astronomy", "Electronics", "Engineering", "Printing",
                 "Photography", "Sport", "Baseball", "Football", "Cricket", "Golf", "Heraldry", "Phonetics", "Psychology",
                 "Psychiatry", "Physiology", "Biochemistry", "Genetics", "Ecology", "Mythology", "Prosody", "Rhetoric", "Theater",
                 "Cinema", "Horticulture", "Farming", "Hunting", "Fishing", "Mining", "Commerce", "Aeronautics", "Ornithology",
                 "Entomology", "Pharmacology", "Dentistry", "Surgery", "Pathology", "Immunology", "Microbiology", "Archaeology",
                 "Christian Church", "Roman Catholic Church", "Christian Theology"],
        modifiers: ["chiefly", "mainly", "esp.", "especially", "often", "usually", "also", "in"],
        ipaChars: "ˈˌːəɐɑɒɔɛɜɪʊʌʃʒθðŋɣɾʎɲχʁɥøœ"
    };

    var reEscape = function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
    var alt = function (list) { return list.map(reEscape).join("|"); };

    var NUMBER_RE = /^\s*(?:\(\d{1,2}\)|（\d{1,2}）|\d{1,2}[.)]?(?=\s|$)|[\u2460-\u2473]|[a-h][.)](?=\s|$))\s*/;
    var POS = alt(SENSE_RULES.pos) + "|" + alt(SENSE_RULES.posAbbrev);
    var POS_START_RE = new RegExp("^\\s*(?:(?:" + alt(SENSE_RULES.posPrefix) + ")\\s+)?(?:" + POS +
                                  ")(?:\\s+(?:verb|noun))?(?=[\\s,.;:]|$)[\\s,]*", "i");
    var REGISTER = alt(SENSE_RULES.register);
    var REGION = alt(SENSE_RULES.region);
    var DOMAIN = alt(SENSE_RULES.domain);
    var AMBIGUOUS = alt(SENSE_RULES.registerAmbiguous);
    // 歧义语体词：后面是冠词等虚词、另一个标签、修饰词、括号或逗号时才算标签
    var AMBIGUOUS_LABEL = "(?:" + AMBIGUOUS + ")(?=\\s*[,(\\[]|\\s+(?:" + alt(SENSE_RULES.labelFollowers) + "|" + REGISTER + "|" + AMBIGUOUS + "|" +
                          REGION + "|" + alt(SENSE_RULES.modifiers) + ")\\b)";
    var LABEL = "(?:" + REGISTER + "|" + REGION + "|" + AMBIGUOUS_LABEL + ")";
    var LABEL_START_RE = new RegExp("^\\s*(?:(?:" + alt(SENSE_RULES.modifiers) + ")\\s+)?" + LABEL + "(?=[\\s,.;:]|$)[\\s,]*", "i");
    var DOMAIN_START_RE = new RegExp("^\\s*(?:" + DOMAIN + ")(?=\\s+\\S)\\s+");     // 领域标签只认首字母大写的固定写法
    var IPA_CHARS = new RegExp("[" + SENSE_RULES.ipaChars + "]");
    var INLINE_POS_RE = new RegExp("[.;]\\s+(?:" + POS + ")\\b[\\s\\S]*$", "i");

    function stripSenseNumber(text) {
        var s = String(text || "");
        // 音标与变位表：「(decrees | dəˈkrēz |)」「| baNGk |」「/ˈkapədl/」以及带 IPA 字符的词，任何位置都删
        s = s.replace(/\([^()]*\|[^()]*\)/g, " ")
             .replace(/\|[^|]*\|/g, " ")
             .replace(/\|/g, " ")
             .replace(/\/[^\/\s]*[ˈˌəɑɛɪʊʌʃʒθðŋ][^\/]*\//g, " ")
             .split(/\s+/).filter(function (t) { return !IPA_CHARS.test(t); }).join(" ");
        // 方括号语法标签、「(as noun)」这类括注，任何位置都删
        s = s.replace(/\[[^\]]*\]/g, " ").replace(/［[^］]*］/g, " ")
             .replace(/\((?:as |also as |treated as )?(?:noun|verb|adjective|adverb)[^()]*\)/gi, " ");
        // 句中出现的另一词性段（「…law courts. verb …」）整块切掉。切点前要有一段正文（≥ 2 个词、10 个字符），
        // 免得把「v. transitive …」里缩写的句点当成句末
        var m = INLINE_POS_RE.exec(s);
        if (m && m.index >= 10 && /\S\s+\S/.test(s.slice(0, m.index))) s = s.slice(0, m.index);
        s = s.replace(/\s{2,}/g, " ");
        for (var i = 0; i < 8; i++) {
            var next = s.replace(/^\s*\((?:[^()]*\balso\b[^()]*|plural [^()]*)\)\s*/, "")
                .replace(NUMBER_RE, "")
                .replace(POS_START_RE, "")
                .replace(LABEL_START_RE, "")
                .replace(DOMAIN_START_RE, "");
            if (next === s) break;
            s = next;
        }
        return s.replace(/^[\s.,;:]+/, "").replace(/[\s.;:,]+$/, "").trim();
    }

    // 两行的字符预算：面板 320px、12.5px 字号，一行约 50 个拉丁字符或 25 个汉字；汉字按双宽计
    var SENSE_WIDTH = SENSE_RULES.twoLineWidth;

    function displayWidth(ch) { return /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 2 : 1; }

    function truncateSense(text, budget) {
        var s = String(text || "");
        budget = budget || SENSE_WIDTH;
        var width = 0, cut = -1;
        for (var i = 0; i < s.length; i++) {
            width += displayWidth(s[i]);
            if (width > budget - 1) { cut = i; break; }          // 留一格给省略号
        }
        if (cut < 0) return s;
        var head = s.slice(0, cut);
        // 拉丁字母：退到最后一个完整词；汉字可以在字间断
        if (/[A-Za-z\u00c0-\u024f]/.test(s[cut]) && /[A-Za-z\u00c0-\u024f]/.test(s[cut - 1])) {
            var space = head.search(/\s\S*$/);
            if (space > 0) head = head.slice(0, space);
        }
        return head.replace(/[\s,;:.(\-–—]+$/, "") + "…";
    }

    function cleanSenses(list) {
        var out = [];
        (list || []).forEach(function (raw) {
            var s = stripSenseNumber(raw);
            if (!s || /^\d+$/.test(s)) return;
            s = truncateSense(s);
            if (out.indexOf(s) < 0) out.push(s);
        });
        return out;
    }

    /* ---------------- 模型输出校验：与显示层清理同一套规则 ----------------
     * 模型有义务按这套标准产出；显示层清理只作安全网。任一条不合格即整体不合格 */
    var INLINE_POS_ANY_RE = new RegExp("(?:^|[.;,(]\\s*)(?:" + POS + ")(?=[\\s,.;:)]|$)", "i");
    var ABBREV_TOKEN_RE = new RegExp("(?:^|\\s)(?:" + alt(SENSE_RULES.posAbbrev) + ")(?=\\s|$)", "i");
    var LABEL_ANY_START_RE = new RegExp("^\\s*(?:(?:" + alt(SENSE_RULES.modifiers) + ")\\s+)?(?:" + LABEL + "|" + DOMAIN + ")(?=[\\s,.;:]|$)", "i");
    var LABEL_PAREN_RE = new RegExp("\\((?:" + REGISTER + "|" + AMBIGUOUS + "|" + REGION + ")[^()]*\\)", "i");

    function textWidth(t) {
        var w = 0;
        for (var i = 0; i < t.length; i++) w += displayWidth(t[i]);
        return w;
    }

    // 返回违规列表 [{ rule, sense, detail }]；opts.lang 为输出语言，opts.raw 为词条原文（判断大写是否「莫名」）
    function validateSenses(senses, opts) {
        opts = opts || {};
        var out = [];
        var raw = String(opts.raw || "");
        var english = !opts.lang || opts.lang === "en";
        (senses || []).forEach(function (sense) {
            var s = String(sense || "");
            var add = function (rule, detail) { out.push({ rule: rule, sense: s, detail: detail || null }); };
            var pos = s.match(INLINE_POS_ANY_RE) || s.match(ABBREV_TOKEN_RE);
            if (pos || POS_START_RE.test(s)) add("pos", (pos ? pos[0] : s.split(/\s/)[0]).replace(/^[\s.;,(]+/, ""));
            var label = s.match(LABEL_ANY_START_RE) || s.match(LABEL_PAREN_RE);
            if (label) add("register", label[0].trim());
            if (/\|[^|]*\|/.test(s) || /\([^()]*\|[^()]*\)/.test(s) || IPA_CHARS.test(s) ||
                /\/[^\/\s]{1,20}\//.test(s)) add("ipa");
            if (NUMBER_RE.test(s)) add("number", s.match(NUMBER_RE)[0].trim());
            if (s.length > SENSE_RULES.senseChars) add("length", String(s.length));
            if (textWidth(s) > SENSE_RULES.twoLineWidth) add("twoLines", String(textWidth(s)));
            if (english) {
                var first = (s.match(/^[A-Za-z][a-z'\-]*/) || [""])[0];
                var head = String(opts.word || "");
                // 首字母被改成大写：原文里有这个词的小写形式、却没有大写形式；以专名词头开头的（Caesar → Caesarean）放行
                var fromProperHead = /^[A-Z]/.test(head) && first.indexOf(head.replace(/^(.)(.*)$/, function (m, a, b) { return a + b; })) === 0;
                if (/^[A-Z][a-z]/.test(first) && raw && !fromProperHead && new RegExp("\\b" + first.toLowerCase() + "\\b").test(raw) &&
                    !new RegExp("\\b" + first + "\\b").test(raw)) add("capitalized", first);
            }
            if (/[.。]$/.test(s) && !/\b(?:etc|e\.g|i\.e)\.$/.test(s)) add("period");
        });
        return out;
    }

    var FEEDBACK = {
        en: { pos: "it contained a part-of-speech label (%s); remove it",
              register: "it contained a register or field label (%s); remove it",
              ipa: "it contained pronunciation or an inflection table; remove all phonetics",
              number: "it started a sense with a number (%s); remove numbering",
              length: "a sense was too long (%s characters); keep each sense under 80 characters",
              twoLines: "a sense would not fit on two short lines; shorten it",
              capitalized: "a sense was capitalized without reason (%s); keep the dictionary's lowercase",
              period: "a sense ended with a full stop like a sentence; write short phrases without the final period" },
        zh: { pos: "含词性标签（%s），请去掉", register: "含语体或领域标签（%s），请去掉", ipa: "含音标或变位，请全部去掉",
              number: "义项前有编号（%s），请去掉", length: "有一条太长（%s 字符），每条不超过 80 字符",
              twoLines: "有一条超过两行，请缩短", capitalized: "首字母被无故改成大写（%s）", period: "有一条像整句一样以句号结尾，请写成短语、去掉句号" }
    };

    function feedbackFor(violations, lang) {
        var table = lang && /^zh/.test(lang) ? FEEDBACK.zh : FEEDBACK.en;
        var seen = {}, parts = [];
        violations.forEach(function (v) {
            if (seen[v.rule]) return;
            seen[v.rule] = true;
            parts.push(table[v.rule].replace("%s", v.detail || ""));
        });
        return (table === FEEDBACK.zh ? "问题：" : "Problems: ") + parts.join(table === FEEDBACK.zh ? "；" : "; ") +
            (table === FEEDBACK.zh ? "。" : ".");
    }

    // 编排：调用 → 校验 → 不合格则带原因重试一次 → 仍不合格退回规则层。
    //   call(feedback, previous) → Promise<{ senses, raw }|null>（null = 模型不可用、超时等，直接退回规则层）
    // 返回 { senses|null, status: pass | retry-pass | fail | unavailable, attempts, violations, log }
    function validatedGeneration(call, opts) {
        opts = opts || {};
        var record = function (status, attempts, first, second, senses) {
            return {
                senses: senses, status: status, attempts: attempts,
                violations: (second || first || []).map(function (v) { return v.rule; }),
                log: {
                    mode: opts.mode || null, word: opts.word || null, lang: opts.lang || "en", result: status, attempts: attempts,
                    firstRules: first ? uniqueRules(first) : [], secondRules: second ? uniqueRules(second) : [],
                    // 两次被拦的原文都记下（各最多 3 条），注明第几次
                    rejected: (first || []).slice(0, 3).map(function (v) { return { attempt: 1, rule: v.rule, sense: v.sense }; })
                        .concat((second || []).slice(0, 3).map(function (v) { return { attempt: 2, rule: v.rule, sense: v.sense }; }))
                }
            };
        };
        return call(null, null).then(function (r1) {
            if (!r1 || !r1.senses || !r1.senses.length) return record("unavailable", 1, null, null, null);
            var v1 = validateSenses(r1.senses, opts);
            if (!v1.length) return record("pass", 1, null, null, r1.senses);
            return call(feedbackFor(v1, opts.lang), r1.raw || r1.senses.join("; ")).then(function (r2) {
                if (!r2 || !r2.senses || !r2.senses.length) return record("fail", 2, v1, null, null);
                var v2 = validateSenses(r2.senses, opts);
                if (!v2.length) return record("retry-pass", 2, v1, null, r2.senses);
                return record("fail", 2, v1, v2, null);
            });
        });
    }

    function uniqueRules(vs) {
        var out = [];
        vs.forEach(function (v) { if (out.indexOf(v.rule) < 0) out.push(v.rule); });
        return out;
    }

    // 从整段词条切义项（中文、双语等非 Oxford 英文格式，也用于兜底）：按 ①② / 数字编号 / • 切，
    // 去掉 ▸ 例句、方括号标签与词性，切不出来就截取整段
    function entrySenses(text) {
        var bars = String(text || "").split(" | ");
        var body = bars.length >= 3 ? bars.slice(2).join(" ") : bars[bars.length - 1];
        var pieces = body.split(/(?=[\u2460-\u2473])|(?:^|\s)(?=\d{1,2}(?:\s|$))|\s\u2022\s/);
        var hadMarker = pieces.length > 1;
        var senses = pieces.map(function (p) {
            return stripSenseNumber(p.split(/[\u25b8\u25b6]/)[0]
                .replace(/〔[^〕]*〕|［[^］]*］|\[[^\]]*\]/g, "")
                .replace(/^\s*(?:[A-Z]\.\s*)?(?:uncountable|countable|n\.|v\.|adj\.)\s*/i, ""))
                .replace(/^[名动動形副量代连連介助叹嘆拟擬数數]\s+/, "")
                .split(/[。；]/)[0]
                .trim();
        });
        // 第一个编号之前是词头、拼音、词性，不是义项
        if (hadMarker && !/^\s*(?:[\u2460-\u2473]|\d{1,2}\s)/.test(pieces[0])) senses.shift();
        senses = cleanSenses(senses);
        if (!senses.length) senses = [body.trim()];
        return senses.slice(0, 3).map(function (p) { return truncateSense(p); });
    }

    /* ---------------- 划词补全：用条目全文补 OCR 截断的末字母 ----------------
     * 只对拉丁字母词生效。候选必须是全文里真实出现过的词形：以划词为前缀，或与划词编辑距离 ≤ 2，
     * 长度不超过划词 + 4。排序：同页 > 出现频次 > 与划词的最长公共前缀 */
    var TOKEN_RE = /[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'\-]*[A-Za-z\u00c0-\u024f]|[A-Za-z]/g;

    // 全文 → 词形索引。页按 \f 切（Zotero 的 PDF 全文缓存若有分页符）；没有就整篇算一页
    function buildTextIndex(text) {
        var pages = String(text || "").split("\f");
        var freq = {}, forms = {}, pageSets = [];
        pages.forEach(function (page, pi) {
            var set = {};
            // 跨行连字符断词（anthro-\npological）先接回
            var joined = page.replace(/([A-Za-z])-\s*\n\s*([a-z])/g, "$1$2");
            (joined.match(TOKEN_RE) || []).forEach(function (tok) {
                var key = tok.toLowerCase();
                freq[key] = (freq[key] || 0) + 1;
                // 显示用的词形：全文里出现过小写就用小写（句首大写的 Anthropological 不算专名）
                if (!forms[key] || (forms[key] !== key && tok === key)) forms[key] = tok;
                set[key] = true;
            });
            pageSets.push(set);
        });
        return { freq: freq, forms: forms, pages: pageSets, pageCount: pages.length, tokens: Object.keys(freq).length };
    }

    function editDistanceWithin(a, b, max) {
        if (Math.abs(a.length - b.length) > max) return max + 1;
        var prev = [], cur = [];
        for (var j = 0; j <= b.length; j++) prev[j] = j;
        for (var i = 1; i <= a.length; i++) {
            cur = [i];
            var rowMin = i;
            for (var k = 1; k <= b.length; k++) {
                var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
                cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost);
                if (cur[k] < rowMin) rowMin = cur[k];
            }
            if (rowMin > max) return max + 1;
            prev = cur;
        }
        return prev[b.length];
    }

    function commonPrefix(a, b) {
        var n = 0;
        while (n < a.length && n < b.length && a[n] === b[n]) n++;
        return n;
    }

    // 返回排好序的候选 [{ word, freq, samePage, prefix, distance, lcp }]
    function completionCandidates(word, index, opts) {
        opts = opts || {};
        if (!index || !/^[A-Za-z][A-Za-z'\-]*$/.test(word) || word.length < 3) return [];
        var w = word.toLowerCase();
        var page = typeof opts.pageIndex === "number" && index.pageCount > 1 ? index.pages[opts.pageIndex] : null;
        var out = [];
        Object.keys(index.freq).forEach(function (tok) {
            if (tok === w || tok.length > w.length + 4 || tok.length < 3) return;
            var prefix = tok.indexOf(w) === 0;
            var distance = prefix ? tok.length - w.length : editDistanceWithin(w, tok, 2);
            if (!prefix && distance > 2) return;
            out.push({ word: index.forms[tok] || tok, key: tok, freq: index.freq[tok], samePage: !!(page && page[tok]),
                       prefix: prefix, distance: distance, lcp: commonPrefix(w, tok) });
        });
        out.sort(function (a, b) {
            return (b.samePage - a.samePage) || (b.freq - a.freq) || (b.lcp - a.lcp) || (a.distance - b.distance) ||
                (a.word < b.word ? -1 : 1);
        });
        return out.slice(0, opts.limit || 5);
    }

    // 编排：补全先于兜底（截断不是语言问题）。
    //   1. 关掉兜底按原词 resolve；成功即返回（若 dictlookup 自己补了末字母，标为「按词典补全」，并核对原文里有没有这个词）
    //   2. 失败、且是拉丁字母词、且有全文索引：按候选逐个重查（最多 3 个），第一个成功的即「按原文补全」
    //   3. 仍失败、且开了兜底：按原词走完整的 resolve（含兜底 A/B），并附上补全没成功的记录
    // io 同 resolve，另需 io.textIndex() → Promise<index|null>
    function resolveWithCompletion(opts, io) {
        var copy = function (extra) {
            var o = {};
            for (var k in opts) o[k] = opts[k];
            for (var e in extra) o[e] = extra[e];
            return o;
        };
        var getIndex = function () { return io.textIndex ? io.textIndex() : Promise.resolve(null); };
        var latin = wordScript(opts.word) === "latin";
        // 0. 原文预检：有全文、划词本身在原文里一次都没出现、而原文里有以它为前缀的词 → 判为截断，先按原文候选查。
        //    不预检时，截断形可能恰好是别的语言的词（universi 是意大利语 universo 的复数，被意英词典命中），
        //    或被 dictlookup 的末字母补全补成原文里没有的词（organiz → organize，原文是 organized）
        var precheck = !latin ? Promise.resolve(null) : getIndex().then(function (index) {
            if (!index || index.freq[opts.word.toLowerCase()]) return null;
            var cands = completionCandidates(opts.word, index, { pageIndex: opts.pageIndex })
                .filter(function (c) { return c.prefix; });
            var tried = [];
            var next = function (i) {
                if (i >= Math.min(3, cands.length)) return null;
                // 查词用小写键（词典不分大小写；原文里只有句首大写的 University 也能命中）
                return resolve(copy({ word: cands[i].key, fallback: false }), io).then(function (r) {
                    tried.push({ word: cands[i].word, status: r.status, reason: r.reason || null });
                    if (r.status !== "ok") return next(i + 1);
                    r.completion = { original: opts.word, completed: (r.data && r.data.word) || cands[i].key,
                                     source: "fulltext", candidate: cands[i], tried: tried, precheck: true };
                    return r;
                });
            };
            return next(0);
        });
        return precheck.then(function (pre) {
            if (pre) return pre;
            return resolve(copy({ fallback: false }), io);
        }).then(function (first) {
            if (first.completion) return first;
            if (first.status === "legacy") return first;
            if (first.status === "ok") {
                var from = first.data && first.data.completedFrom;
                if (!from) return first;
                return getIndex().then(function (index) {
                    var key = String(first.data.word || "").toLowerCase();
                    first.completion = { original: from, completed: first.data.word, source: "dictionary",
                                         inText: index ? index.freq[key] || 0 : null };
                    return first;
                });
            }
            var finish = function (completion) {
                if (!opts.fallback) { first.completion = completion; return first; }
                return resolve(opts, io).then(function (r) { r.completion = completion; return r; });
            };
            if (!latin) return finish(null);
            return getIndex().then(function (index) {
                if (!index) return finish({ original: opts.word, tried: [], reason: "no-fulltext" });
                var cands = completionCandidates(opts.word, index, { pageIndex: opts.pageIndex });
                var tried = [];
                var wrongLanguage = null;      // 补全出来了、词典也收录，但没有目标语言的释义
                var next = function (i) {
                    if (i >= Math.min(3, cands.length)) {
                        if (wrongLanguage && !opts.fallback) {
                            wrongLanguage.r.completion = { original: opts.word, completed: wrongLanguage.word, source: "fulltext",
                                                           candidate: wrongLanguage.candidate, tried: tried, matched: false };
                            return wrongLanguage.r;
                        }
                        return finish({ original: opts.word, tried: tried, reason: cands.length ? "no-match" : "no-candidate" });
                    }
                    return resolve(copy({ word: cands[i].key, fallback: false }), io).then(function (r) {
                        tried.push({ word: cands[i].word, status: r.status, reason: r.reason || null });
                        if (r.status !== "ok" && r.reason === "wrong-language" && !wrongLanguage) {
                            wrongLanguage = { r: r, word: (r.data && r.data.word) || cands[i].key, candidate: cands[i] };
                        }
                        if (r.status !== "ok") return next(i + 1);
                        r.completion = { original: opts.word, completed: (r.data && r.data.word) || cands[i].key,
                                         source: "fulltext", candidate: cands[i], tried: tried };
                        return r;
                    });
                };
                return next(0);
            });
        });
    }

    return {
        SUPPORTED: SUPPORTED,
        label: label,
        normalizeLang: normalizeLang,
        wordScript: wordScript,
        wordLanguage: wordLanguage,
        resolveTarget: resolveTarget,
        matchLevel: matchLevel,
        allowedDictionaries: allowedDictionaries,
        buildOrder: buildOrder,
        clearMemo: clearMemo,
        pickEntry: pickEntry,
        decide: decide,
        conversionLanguage: conversionLanguage,
        resolve: resolve,
        resolveWithCompletion: resolveWithCompletion,
        buildTextIndex: buildTextIndex,
        completionCandidates: completionCandidates,
        editDistanceWithin: editDistanceWithin,
        stripSenseNumber: stripSenseNumber,
        truncateSense: truncateSense,
        SENSE_RULES: SENSE_RULES,
        validateSenses: validateSenses,
        feedbackFor: feedbackFor,
        validatedGeneration: validatedGeneration,
        cleanSenses: cleanSenses,
        entrySenses: entrySenses,
        statusMessage: statusMessage,
        statusView: statusView,
        fallbackNotice: fallbackNotice,
        messageLanguage: messageLanguage,
        buttonLabels: buttonLabels,
        completionNotice: completionNotice,
        topBadge: topBadge,
        explainedIn: explainedIn,
        transcribeFailed: transcribeFailed,
        noEntry: noEntry,
        wordLanguageFromEvidence: wordLanguageFromEvidence,
        preview: preview
    };
})();

if (typeof module !== "undefined") module.exports = SysDictLang;
