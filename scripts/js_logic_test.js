// bootstrap.js 纯逻辑自测（历史清理、缓存键与 TTL、义项去重）：node scripts/js_logic_test.js
const vm = require("vm"), fs = require("fs");
const ctx = { Services: {}, Components: {}, Zotero: { Promise: { delay: () => new Promise(() => {}) } }, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require("path").join(__dirname, "../addon/bootstrap.js"), "utf8"), ctx);
const r = (c) => vm.runInContext(c, ctx);
const now = Date.now(), day = 864e5;
let list = [];
for (let i = 0; i < 60; i++) list.push({ w: "w" + i, ts: now - (59 - i) * 1000 });
list.unshift({ w: "old", ts: now - 31 * day });
ctx.L = list;
console.log("prune 61(含1个过期) ->", r("pruneHistory(L).length"), "首个:", r("pruneHistory(L)[0].w"));
console.log("rankKey:", r('rankKey("Interest", {itemID: 7, history: ["a","b","c","d","e","F"]})'));
r('writeRankCache("k", ["x"])'); console.log("rank cache hit:", r('readRankCache("k")'));
r('rankCache.get("k").ts -= 11*60*1000'); console.log("过期后:", r('readRankCache("k")'));
for (let i = 0; i < 250; i++) r(`writeRankCache("k${i}", [])`); console.log("cache size cap:", r("rankCache.size"));
console.log("similar:", r('similar("money paid for lent money", "financial return on borrowed money paid")'), r('similar("a legal right in property", "curiosity or enthusiasm")'));
console.log("contextHasSignal 空:", r('contextHasSignal({itemID:1,title:"",abstract:"",journal:"",history:[]})'), "有历史:", r('contextHasSignal({itemID:1,history:["x"]})'));
