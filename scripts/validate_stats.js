// 统计 lookup.log 里的模型输出校验记录：node scripts/validate_stats.js <lookup.log>
// 每次模型调用插件都会写一行 "[validate] {...}"，这里按结果、模式、被拦的规则计数
"use strict";
var fs = require("fs");
var file = process.argv[2];
if (!file) { console.log("用法：node scripts/validate_stats.js <lookup.log>"); process.exit(2); }
var rows = fs.readFileSync(file, "utf8").split("\n")
    .map(function (l) { var i = l.indexOf("[validate] "); return i < 0 ? null : l.slice(i + 11); })
    .filter(Boolean).map(function (j) { try { return JSON.parse(j); } catch (e) { return null; } }).filter(Boolean);
var count = function (key) {
    var m = {};
    rows.forEach(function (r) { [].concat(r[key]).forEach(function (k) { m[k] = (m[k] || 0) + 1; }); });
    return m;
};
console.log("模型调用 " + rows.length + " 次");
console.log("结果：", count("result"));
console.log("模式：", count("mode"));
console.log("第一次被拦的规则：", count("firstRules"));
console.log("重试后仍被拦的规则：", count("secondRules"));
var needFix = rows.filter(function (r) { return r.result !== "pass" && r.result !== "unavailable"; }).length;
var valid = rows.filter(function (r) { return r.result !== "unavailable"; }).length;
if (valid) console.log("需要擦（重试或退回）的比例：" + (100 * needFix / valid).toFixed(1) + "%");
