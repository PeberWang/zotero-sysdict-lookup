#!/usr/bin/env python3
"""端侧义项选择基准：一条命令跑完三套方案并出报告。

    bash build.sh                  # 需要 build/dictlookup
    python3 -I bench/run.py        # 编译执行器 → 24 例 × 3 方案 × 3 次 → results.csv + report.md
    python3 -I bench/run.py --analyze-only   # 只用已有的 bench/results.jsonl 重出报告

全程离线：词条来自本机 DictionaryServices（New Oxford American Dictionary），模型是 Foundation Models。
只用 Python 标准库。
"""
import argparse
import csv
import json
import math
import os
import random
import re
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, "build", "bench")
METHODS = ["A", "B", "C"]
METHOD_NAMES = {"A": "A 候选法", "B": "B 原文两步", "C": "C 原文一步"}
REPS = 3
SEED = 20261116
BOOT = 2000
DICT = "New Oxford American Dictionary"


# ---------------- 案例 ----------------

def load_cases(paths):
    cases = []
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    cases.append(json.loads(line))
    return cases


def import_history(history_dir):
    """第二批：从 ~/Library/Application Support/Zotero/sysdict/history/<itemID>.json 导入真实划词。

    这次不实现。数据结构已对齐：history 文件每条是 {w, ts}，导入时
      - 每个词生成一行，source="history"、item_id=文件名、ts=划词时间、word=w、history=它之前的 4–6 个词；
      - title / abstract / journal / year / authors 需要另从 Zotero 数据库按 item_id 读出
        （插件只存词，不存元数据）；
      - gold_sense / gold_regex / rationale 必须人工标注，未标注的行 run.py 会跳过。
    """
    raise NotImplementedError("第二批真实样本的导入尚未实现，见 report.md「下一步」")


def fetch_entry(word):
    out = subprocess.run([os.path.join(ROOT, "build", "dictlookup"), word, "--order", DICT],
                         capture_output=True, text=True, check=True).stdout
    entries = json.loads(out)["entries"]
    if not entries:
        raise SystemExit(f"{DICT} 未收录 {word}")
    return entries[0]["text"][:2000]


def validate(cases, raws):
    for c in cases:
        if not re.search(c["gold_anchor"], raws[c["word"]]):
            raise SystemExit(f"{c['id']}：金标义项不在 {c['word']} 原文前 2000 字内，案例无效")


# ---------------- 执行 ----------------

def build_runner():
    os.makedirs(BUILD, exist_ok=True)
    lib = os.path.join(BUILD, "ds_lib.swift")
    with open(os.path.join(ROOT, "native", "dictsummary.swift"), encoding="utf-8") as f:
        src = f.read()
    src = re.sub(r"^@main$", "", src, flags=re.M).replace("struct Main {", "struct MainDisabled {")
    with open(lib, "w", encoding="utf-8") as f:
        f.write(src)
    exe = os.path.join(BUILD, "runner")
    subprocess.run(["swiftc", "-O", "-parse-as-library", "-target", "arm64-apple-macos26.0",
                    lib, os.path.join(HERE, "runner.swift"), "-o", exe], check=True)
    return exe


def make_jobs(cases, raws):
    rng = random.Random(SEED)
    jobs = []
    # 重复在外层、方案在内层并逐例打乱顺序，避免模型冷启动或机器负载只偏向某个方案
    for rep in range(1, REPS + 1):
        for c in cases:
            methods = METHODS[:]
            rng.shuffle(methods)
            for m in methods:
                jobs.append(dict(job=f"{c['id']}|{m}|{rep}", caseId=c["id"], method=m, rep=rep,
                                 word=c["word"], raw=raws[c["word"]], title=c["title"], abstract=c["abstract"],
                                 journal=c["journal"], year=str(c["year"]), authors="; ".join(c["authors"]),
                                 history=c["history"]))
    return jobs


def run_all(cases, raws):
    exe = build_runner()
    jobs_path = os.path.join(BUILD, "jobs.jsonl")
    with open(jobs_path, "w", encoding="utf-8") as f:
        for j in make_jobs(cases, raws):
            f.write(json.dumps(j, ensure_ascii=False) + "\n")
    out = os.path.join(HERE, "results.jsonl")
    subprocess.run([exe, jobs_path, out], check=True)
    return out


# ---------------- 判分 ----------------

def is_gold(text, case):
    t = text.lower()
    if not re.search(case["gold_regex"], t):
        return False
    return not (case.get("exclude_regex") and re.search(case["exclude_regex"], t))


def score(rows, cases):
    by_id = {c["id"]: c for c in cases}
    for r in rows:
        c = by_id[r["caseId"]]
        senses = r["senses"]
        r["top1"] = bool(senses) and is_gold(senses[0], c)
        r["top3"] = any(is_gold(s, c) for s in senses[:3])
        r["gold_rank"] = next((i + 1 for i, s in enumerate(senses[:3]) if is_gold(s, c)), None)
        r["parse_fail"] = not r["ok"] and r.get("error") == "unparsable"
        r["timeout"] = r.get("error") == "timeout"
        r["n_phrases"] = len(r["phrases"])
        r["difficulty"] = c["difficulty"]
        r["domain"] = c["domain"]
    return rows


# ---------------- 统计 ----------------

def bootstrap_ci(values, rng):
    if not values:
        return (float("nan"), float("nan"))
    means = []
    n = len(values)
    for _ in range(BOOT):
        means.append(sum(values[rng.randrange(n)] for _ in range(n)) / n)
    means.sort()
    return (means[int(0.025 * BOOT)], means[int(0.975 * BOOT) - 1])


def pct(values, q):
    if not values:
        return float("nan")
    v = sorted(values)
    k = (len(v) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def per_case(rows, method, case_ids, key):
    """按案例聚合：每例三次的均值。返回与 case_ids 对齐的列表"""
    out = []
    for cid in case_ids:
        vals = [float(r[key]) for r in rows if r["method"] == method and r["caseId"] == cid]
        out.append(sum(vals) / len(vals) if vals else 0.0)
    return out


def ratio(rows, method, num, den):
    n = sum(r[num] for r in rows if r["method"] == method)
    d = sum(r[den] for r in rows if r["method"] == method)
    return n / d if d else float("nan")


def consistency(rows, method, case_ids):
    same = 0
    for cid in case_ids:
        outs = [tuple(r["senses"]) for r in rows if r["method"] == method and r["caseId"] == cid]
        same += len(outs) == REPS and len(set(outs)) == 1
    return same / len(case_ids)


def pearson(xs, ys):
    if len(xs) < 3:
        return float("nan")
    mx, my = statistics.mean(xs), statistics.mean(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy) if sx and sy else float("nan")


def f(x, nd=2):
    return "—" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{nd}f}"


def p(x):
    return "—" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:.0f}%"


# ---------------- 输出 ----------------

CSV_FIELDS = ["caseId", "domain", "difficulty", "method", "rep", "ok", "error", "latencyMs", "promptChars",
              "estTokens", "top1", "top3", "gold_rank", "n_phrases", "intercepted", "fabricated", "similarity",
              "senses", "rawOutput"]


def write_csv(rows):
    path = os.path.join(HERE, "results.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r["caseId"], r["method"], r["rep"])):
            row = {k: r.get(k) for k in CSV_FIELDS}
            row["estTokens"] = round(r["promptChars"] / 4)
            row["senses"] = " ; ".join(r["senses"])
            row["rawOutput"] = r["rawOutput"].replace("\n", " ⏎ ")
            w.writerow(row)
    return path


def report(rows, cases):
    rng = random.Random(SEED)
    ids = [c["id"] for c in cases]
    hard_ids = [c["id"] for c in cases if c["difficulty"] == "hard"]
    easy_ids = [c["id"] for c in cases if c["difficulty"] == "easy"]
    L = []
    add = L.append

    add("# 端侧义项选择基准报告（构造集第一批）")
    add("")
    add("> **这是作者构造的 24 个案例，不是真实划词样本**，不代表真实阅读中的词与语境分布。下面所有数字只描述这 24 例上的表现；"
        "样本很小，置信区间很宽，凡是区间重叠的比较都**不足以判断**谁更好。")
    add("")
    add(f"- 方案：{'、'.join(METHOD_NAMES[m] for m in METHODS)}；每例每方案 {REPS} 次，共 {len(rows)} 次调用")
    add(f"- 案例：{len(cases)} 例，六个领域各 4 例；难例 {len(hard_ids)} 例（{len(hard_ids) / len(cases):.0%}）")
    add("- 模型：本机 Apple Foundation Models，`permissiveContentTransformations`，greedy 采样，单次 6 s 超时")
    add("- 词条：New Oxford American Dictionary，截前 2000 字（与插件一致）")
    add(f"- 置信区间：按案例重抽样的 bootstrap（{BOOT} 次，种子 {SEED}），先对每例 3 次取均值再抽样")
    add("")

    add("## 1. 结论表")
    add("")
    add("| 指标 | " + " | ".join(METHOD_NAMES[m] for m in METHODS) + " |")
    add("| --- | " + " | ".join("---" for _ in METHODS) + " |")
    lines = {}
    for m in METHODS:
        mr = [r for r in rows if r["method"] == m]
        t1 = per_case(rows, m, ids, "top1")
        t3 = per_case(rows, m, ids, "top3")
        lo1, hi1 = bootstrap_ci(t1, rng)
        lo3, hi3 = bootstrap_ci(t3, rng)
        lat = [r["latencyMs"] for r in mr if r["ok"]]
        chars = [r["promptChars"] for r in mr]
        lines[m] = dict(
            top1=f"{p(statistics.mean(t1))}（{p(lo1)}–{p(hi1)}）",
            top3=f"{p(statistics.mean(t3))}（{p(lo3)}–{p(hi3)}）",
            parse=p(sum(r["parse_fail"] for r in mr) / len(mr)),
            timeout=p(sum(r["timeout"] for r in mr) / len(mr)),
            intercept=p(ratio(rows, m, "intercepted", "n_phrases")),
            fabricated=p(ratio(rows, m, "fabricated", "n_phrases")),
            p50=f"{pct(lat, 0.5):.0f} ms", p95=f"{pct(lat, 0.95):.0f} ms",
            chars=f"{statistics.mean(chars):.0f}（约 {statistics.mean(chars) / 4:.0f} token）",
            consistency=p(consistency(rows, m, ids)),
        )
    for key, label in [("top1", "首选命中率（95% CI）"), ("top3", "前三覆盖率（95% CI）"), ("parse", "解析失败率"),
                       ("timeout", "超时率"), ("intercept", "校验拦截率（占解析出的短语）"),
                       ("fabricated", "编造率（短语与原文实词重合 < 0.5）"), ("p50", "延迟 p50"), ("p95", "延迟 p95"),
                       ("chars", "prompt 字符数均值"), ("consistency", "三次完全一致的案例比例")]:
        add(f"| {label} | " + " | ".join(lines[m][key] for m in METHODS) + " |")
    add("")

    # 方案间配对差
    add("### 配对比较（同一批案例，首选命中率之差）")
    add("")
    add("| 比较 | 差值 | 95% CI | 能否判断 |")
    add("| --- | --- | --- | --- |")
    for a, b in [("C", "A"), ("C", "B"), ("B", "A")]:
        da = per_case(rows, a, ids, "top1")
        db = per_case(rows, b, ids, "top1")
        diff = [x - y for x, y in zip(da, db)]
        lo, hi = bootstrap_ci(diff, rng)
        verdict = "不足以判断（区间跨 0）" if lo <= 0 <= hi else ("在这 24 例上较好" if lo > 0 else "在这 24 例上较差")
        add(f"| {METHOD_NAMES[a]} − {METHOD_NAMES[b]} | {statistics.mean(diff) * 100:+.0f} 个百分点 | "
            f"{lo * 100:+.0f} 到 {hi * 100:+.0f} | {verdict} |")
    add("")

    add("## 2. 难例 vs 易例")
    add("")
    add("难例：本文语境里不止一个义项说得通，期刊或领域还会把人引向错的那个，只有靠标题、摘要或历史里的细节才能定。")
    add("")
    add("| 方案 | 易例首选（n=%d） | 难例首选（n=%d） | 易例前三 | 难例前三 |" % (len(easy_ids), len(hard_ids)))
    add("| --- | --- | --- | --- | --- |")
    for m in METHODS:
        e1, h1 = per_case(rows, m, easy_ids, "top1"), per_case(rows, m, hard_ids, "top1")
        e3, h3 = per_case(rows, m, easy_ids, "top3"), per_case(rows, m, hard_ids, "top3")
        el, eh = bootstrap_ci(e1, rng)
        hl, hh = bootstrap_ci(h1, rng)
        add(f"| {METHOD_NAMES[m]} | {p(statistics.mean(e1))}（{p(el)}–{p(eh)}） | {p(statistics.mean(h1))}（{p(hl)}–{p(hh)}） | "
            f"{p(statistics.mean(e3))} | {p(statistics.mean(h3))} |")
    add("")
    add("按领域的首选命中率（每格 4 例 × 3 次，只作描述）：")
    add("")
    domains = sorted({c["domain"] for c in cases})
    add("| 方案 | " + " | ".join(domains) + " |")
    add("| --- | " + " | ".join("---" for _ in domains) + " |")
    for m in METHODS:
        cells = []
        for d in domains:
            dids = [c["id"] for c in cases if c["domain"] == d]
            cells.append(p(statistics.mean(per_case(rows, m, dids, "top1"))))
        add(f"| {METHOD_NAMES[m]} | " + " | ".join(cells) + " |")
    add("")

    add("## 3. 现象记录（供写作参考，非结论）")
    add("")
    add("### 3.1 三条义项之间的语义相似度")
    add("")
    add("用系统自带的 `NLEmbedding.sentenceEmbedding(for: .english)` 计算最终义项两两的余弦相似度，再取均值。"
        "数值越高，表示三条越像在重复同一个意思。")
    add("")
    add("| 方案 | 均值 | 四分位（25% / 50% / 75%） | 有效调用 |")
    add("| --- | --- | --- | --- |")
    for m in METHODS:
        sims = [r["similarity"] for r in rows if r["method"] == m and r.get("similarity") is not None]
        if sims:
            add(f"| {METHOD_NAMES[m]} | {statistics.mean(sims):.2f} | {pct(sims, .25):.2f} / {pct(sims, .5):.2f} / {pct(sims, .75):.2f} | {len(sims)} |")
        else:
            add(f"| {METHOD_NAMES[m]} | — | — | 0 |")
    add("")
    add("### 3.2 延迟与 prompt 长度")
    add("")
    add("| 方案 | prompt 字符与延迟的 Pearson r | 短 prompt（< 2000 字符）延迟中位 | 长 prompt（≥ 2000）延迟中位 |")
    add("| --- | --- | --- | --- |")
    for m in METHODS:
        ok = [r for r in rows if r["method"] == m and r["ok"]]
        r_ = pearson([r["promptChars"] for r in ok], [r["latencyMs"] for r in ok])
        short = [r["latencyMs"] for r in ok if r["promptChars"] < 2000]
        long_ = [r["latencyMs"] for r in ok if r["promptChars"] >= 2000]
        add(f"| {METHOD_NAMES[m]} | {f(r_)} | {f(pct(short, .5), 0)} ms（n={len(short)}） | {f(pct(long_, .5), 0)} ms（n={len(long_)}） |")
    add("")
    add("输出长度也影响延迟（A 方案每条义项一行、B 方案输出两行），所以这里的相关性不能解读为 prompt 长度单独造成的。")
    add("")

    add("### 3.3 失败的案例长什么样")
    add("")
    by_id = {c["id"]: c for c in cases}
    fails = []
    for cid in ids:
        for m in METHODS:
            rs = [r for r in rows if r["caseId"] == cid and r["method"] == m]
            if rs and not any(r["top1"] for r in rs):
                fails.append((cid, m, rs[0]))
    add(f"三次都没把金标排第一的（案例, 方案）组合共 {len(fails)} 个。下面逐个列出第一次的输出：")
    add("")
    add("| 案例 | 难度 | 方案 | 金标 | 模型给的三条 | 金标排位 |")
    add("| --- | --- | --- | --- | --- | --- |")
    for cid, m, r in fails:
        c = by_id[cid]
        shown = " ； ".join(r["senses"]) if r["senses"] else f"（{r.get('error') or '无输出'}）"
        add(f"| {cid} `{c['word']}` | {c['difficulty']} | {m} | {c['gold_sense'][:40]}… | {shown[:120]} | {r['gold_rank'] or '不在前三'} |")
    add("")

    add("### 3.4 解析失败与疑似编造的原始输出（第 1 次重复）")
    add("")
    add("| 方案 | 案例 | 类型 | 原始输出 / 被计为编造的短语 |")
    add("| --- | --- | --- | --- |")
    for r in sorted(rows, key=lambda r: (r["method"], r["caseId"])):
        if r["rep"] != 1:
            continue
        if r["parse_fail"]:
            add(f"| {r['method']} | {r['caseId']} | 解析失败 | {r['rawOutput'][:150].replace(chr(10), ' ⏎ ').replace('|', '/')} |")
        elif r["fabricated"]:
            raw_words = r["phrases"][:3]
            add(f"| {r['method']} | {r['caseId']} | 编造 {r['fabricated']} 条 | {' ； '.join(raw_words)[:150].replace('|', '/')} |")
    add("")

    add("## 4. 逐例明细")
    add("")
    add("每格是三次的首选命中次数，括号里是三次中金标进入前三的次数。")
    add("")
    add("| 案例 | 领域 | 难度 | 词 | 金标 | " + " | ".join(METHOD_NAMES[m] for m in METHODS) + " |")
    add("| --- | --- | --- | --- | --- | " + " | ".join("---" for _ in METHODS) + " |")
    for c in cases:
        cells = []
        for m in METHODS:
            rs = [r for r in rows if r["caseId"] == c["id"] and r["method"] == m]
            cells.append(f"{sum(r['top1'] for r in rs)}/{len(rs)}（{sum(r['top3'] for r in rs)}）")
        add(f"| {c['id']} | {c['domain']} | {c['difficulty']} | {c['word']} | {c['gold_sense'][:36]}… | " + " | ".join(cells) + " |")
    add("")
    add("各案例的理由（为什么金标是对的）见 `bench/cases.jsonl` 的 `rationale` 字段；每次调用的原始输出见 `bench/results.csv`。")
    add("")

    add("## 5. 限制与已知偏差")
    add("")
    add("- **构造集**：案例、金标、难度标注都由同一作者（Claude）完成，且作者同时写了 B、C 两个方案的提示词。"
        "虽然案例在跑方案之前已定稿（`bench/build_cases.py`），仍可能无意中偏向作者熟悉的表达。")
    add("- **样本量**：24 例，每格最多 4 例。领域表只作描述，不能做领域间比较。")
    add("- **判分是正则**：`gold_regex` / `exclude_regex` 判定短语是否表达金标。审计发现部分近邻子义项"
        "（如 state 的「联邦州」、memory 的「记忆中的事物」）也会被算对，口径偏宽；改写得很远的正确短语可能被判错。")
    add("- **编造率是代理指标**：短语与原文实词重合度低于 0.5 就记为编造，没有人工核对；措辞完全改写但意思正确的短语也会被计入。")
    add("- **A 方案的落地校验最严**：它只能在候选里挑，拦截率的口径与 B、C 不同（包括标签错位的改正），不能直接横比。")
    add("- **greedy 采样**：与插件一致。三次重复主要反映系统层面的非确定性，不代表温度采样下的方差。")
    add("- **只测英文目标、只用 NOAD**：不覆盖中文输出，也不覆盖其他词典的版式。")
    add("- **每次调用新开会话**，不含插件里子进程启动的开销（约几十毫秒），也不含查词时间。")
    add("- 同一台机器、同一时段连续运行；机器负载与模型冷启动可能带来系统性的延迟偏差。重复放在外层并打乱方案顺序，只能部分缓解。")
    add("")

    add("## 6. 下一步")
    add("")
    add("- **第二批真实样本怎么采**：插件已把每篇文献的划词按时间存在 `~/Library/Application Support/Zotero/sysdict/history/<itemID>.json`。"
        "实现 `run.py` 里的 `import_history()`：按 itemID 从 Zotero 数据库补读元数据，每个词生成一行，用它之前的 4–6 个词作历史；"
        "金标由读者（铭培）事后标注：当时要的是哪个意思。标注要在看到任何方案的输出之前完成。")
    add("- **采多少才有意义**：粗算，首选命中率在 70% 附近时，n 个案例的 95% 区间半宽约为 1.96·√(0.21/n)："
        "n=24 时约 ±18 个百分点，n=100 时约 ±9，n=200 时约 ±6。要分辨 10 个百分点的方案差异，配对比较至少需要约 150–200 个已标注的真实划词，"
        "并且要来自不少于 20 篇文献，以免被少数文章主导。")
    add("- **最值得长期跟踪的指标**：首选命中率（直接对应用户感知），难例上的首选命中率（衡量语境到底有没有用），"
        "编造率（安全底线），以及延迟 p95（决定弹窗体验）。前三覆盖率与一致性可作为回归告警。")
    add("- **建议**：每次改提示词或换系统版本时重跑本基准，`results.csv` 按日期归档，比较时只看配对差及其区间。")
    add("")

    path = os.path.join(HERE, "report.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L))
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze-only", action="store_true")
    ap.add_argument("--cases", nargs="*", default=[os.path.join(HERE, "cases.jsonl")])
    args = ap.parse_args()

    cases = load_cases(args.cases)
    results = os.path.join(HERE, "results.jsonl")
    if not args.analyze_only:
        raws = {w: fetch_entry(w) for w in sorted({c["word"] for c in cases})}
        validate(cases, raws)
        print(f"{len(cases)} 例，{len(METHODS)} 方案 × {REPS} 次 = {len(cases) * len(METHODS) * REPS} 次调用")
        run_all(cases, raws)
    with open(results, encoding="utf-8") as fh:
        rows = [json.loads(l) for l in fh if l.strip()]
    rows = score(rows, cases)
    print("写出", write_csv(rows))
    print("写出", report(rows, cases))


if __name__ == "__main__":
    main()
