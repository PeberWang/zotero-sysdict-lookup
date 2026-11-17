// 「系统词典」设置面板：下拉与勾选由 preference 属性自动绑定，这里只负责只读的状态展示
/* global Zotero, document */

var SysDictPrefs = {
    init: function () {
        ["sysdict-target", "sysdict-same", "sysdict-fallback", "sysdict-order"].forEach(function (id) {
            var node = document.getElementById(id);
            if (node) {
                // synctopreference：控件写入偏好之后触发，此时重算才拿得到新值
                node.addEventListener("synctopreference", function () { SysDictPrefs.render(); });
            }
        });
        this.render();
    },

    refresh: function () {
        var info = document.getElementById("sysdict-probe-info");
        if (info) info.value = "检测中…";
        if (!Zotero.SysDict) return;
        Zotero.SysDict.refresh().then(function () { SysDictPrefs.render(); });
    },

    describe: function (preview, lang, kind) {
        var d = preview.decision;
        var head = "划" + kind + "：";
        if (d.status === "ready" && preview.dictionary) {
            return head + "用「" + preview.dictionary + "」，" + lang.label(d.target) + "解释";
        }
        if (d.status === "ready" && preview.fallback) {
            return head + "没有用" + lang.label(d.target) + "释义的词典，已开兜底：用顺序里第一本收录的词典，再由端侧模型转写";
        }
        if (d.status === "unsupported") {
            return head + "目标语言 " + lang.label(d.target) + " 目前无法可靠判断，会显示提示而不是释义";
        }
        if (d.status === "unknown") return head + "词典检测未完成";
        return head + "没有能用" + lang.label(d.target) + "解释的词典，会显示提示";
    },

    render: function () {
        var now = document.getElementById("sysdict-now");
        var system = document.getElementById("sysdict-system");
        var tbody = document.getElementById("sysdict-dicts-body");
        var info = document.getElementById("sysdict-probe-info");
        if (!now || !tbody) return;

        if (!Zotero.SysDict || !Zotero.SysDict.lang) {
            now.textContent = "插件未加载完成，稍后重新打开设置。";
            return;
        }
        var api = Zotero.SysDict;
        var lang = api.lang;
        var status = api.status();
        var opts = status.options;

        // 「我现在会用什么语言解释」
        now.textContent = "";
        if (!status.previews) {
            now.textContent = "词典检测尚未完成，点「重新检测」。";
        } else {
            var t = lang.resolveTarget({ targetPref: opts.targetPref, systemLanguages: opts.systemLanguages, word: "water" });
            var source = t.source === "user" ? "你的设置" : "系统首选语言第一项（" + (opts.systemLanguages[0] || "未知") + "）";
            var title = document.createElement("div");
            title.style.fontWeight = "600";
            title.textContent = "现在会用 " + lang.label(t.lang) + " 解释，来源：" + source +
                (opts.sameLanguageOnly ? "；已开启同语言内解释" : "");
            now.appendChild(title);
            [[status.previews.latin, "英文词"], [status.previews.han, "汉字词"]].forEach(function (pair) {
                var line = document.createElement("div");
                line.textContent = SysDictPrefs.describe(pair[0], lang, pair[1]);
                now.appendChild(line);
            });
            if (opts.scope.length) {
                var scope = document.createElement("div");
                scope.style.opacity = ".7";
                scope.textContent = "词典范围：只用勾选的 " + opts.scope.length + " 本";
                now.appendChild(scope);
            }
            var fb = document.createElement("div");
            fb.style.opacity = ".7";
            fb.textContent = opts.fallback ? "兜底：已开启（结果会标明「已理解为…」或「已转写」）" : "兜底：关闭（查不到或语言不对时显示「没有合适的词典」）";
            now.appendChild(fb);
            if (opts.userOrder.length) {
                var order = document.createElement("div");
                order.style.opacity = ".7";
                order.textContent = "已设置自定义词典顺序（order）：" + opts.userOrder.join(" → ");
                now.appendChild(order);
            }
        }

        if (system) {
            system.textContent = "系统首选语言：" + (opts.systemLanguages.join("、") || "未读到");
        }

        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
        var dicts = status.info ? status.info.dictionaries : [];
        var cell = function (group) {
            if (!group) return "—";
            var e = group.explains;
            if (!e || e === "other" || /\?$/.test(e)) return "无法判断（" + (e || "?") + "）";
            return lang.label(e);
        };
        var HTML = "http://www.w3.org/1999/xhtml";
        dicts.forEach(function (d) {
            var tr = document.createElementNS(HTML, "tr");
            var box = document.createElementNS(HTML, "input");
            box.type = "checkbox";
            box.checked = opts.scope.indexOf(d.name) >= 0;
            box.addEventListener("change", function () {
                var scope = Zotero.SysDict.status().options.scope.filter(function (n) { return n !== d.name; });
                if (box.checked) scope.push(d.name);
                Zotero.Prefs.set("extensions.zotero.sysdict.dictScope", scope.join("|"), true);
                SysDictPrefs.render();
            });
            var first = document.createElementNS(HTML, "td");
            first.appendChild(box);
            tr.appendChild(first);
            [d.name, cell(d.latin), cell(d.han)].forEach(function (text, i) {
                var td = document.createElementNS(HTML, "td");
                td.textContent = text;
                td.style.padding = i ? "2px 8px" : "2px 8px 2px 0";
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        if (info && status.info) {
            info.value = dicts.length + " 本 · " + (status.info.cached ? "来自缓存" : "刚检测，用时 " + status.info.probeMs + " ms");
        }
    }
};
