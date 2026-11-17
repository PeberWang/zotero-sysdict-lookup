"""中文目标语境排序的 10 个构造案例：python3 -I scripts/zh_rank_demo.py [build/dictsummary] [--rank-method onestep]
在仓库根目录运行；需要先 bash build.sh。全程离线。"""
import json, subprocess, re
C = [("interest","Bank Lending and the Transmission of Monetary Policy","We trace how changes in the policy rate pass through to loan rates.","collateral,lender,spread","利息|利率"),
 ("interest","Property Rights, Land Tenure, and Investment in Rural China","We examine how insecure use rights over farmland affect investment.","tenure,title,lease","权益|股份|利害|所有权|产权"),
 ("interest","Curiosity and Attention in Children's Reading","Children who report curiosity about a topic read longer passages.","attention,motivation,curiosity","兴趣"),
 ("capital","Capital Accumulation and Productivity Growth in Manufacturing Firms","We estimate how investment in machinery raises output per worker.","investment,depreciation,output","资本|资金"),
 ("capital","Primate Cities: Why National Capitals Grow Faster","Seats of national government attract migrants and public investment.","urbanization,migration,seat of government","首都|首府"),
 ("regime","Authoritarian Regime Durability and Elite Coalitions","","","政权"),
 ("bias","Auditing Hiring Algorithms for Discrimination Against Older Applicants","Applicants over 50 are less likely to advance, consistent with prejudice.","discrimination,audit,fairness","偏见|歧视"),
 ("bias","Selection Bias in Online Survey Estimates","Opt-in panels overstate turnout; we correct the estimator with weights.","estimator,weighting,variance","偏差"),
 ("culture","Open Data Practices and Laboratory Culture in Microbiology","Norms set by lab heads predict whether data are shared.","norm,survey,sharing","文化群体|文化方式"),
 ("culture","Antibiotic Resistance in Bacterial Cultures Under Low-Dose Exposure","E. coli cultures exposed to sub-lethal doses evolved resistance.","strain,colony,antibiotic","培养")]
import sys
args_ = sys.argv[1:]
binary = args_[0] if args_ and not args_[0].startswith("--") else "build/dictsummary"
extra = [a for a in args_ if a != binary]
hit = 0
for w, t, a, h, gold in C:
    raw = json.loads(subprocess.run(["build/dictlookup", w, "--order", "牛津英汉汉英词典"], capture_output=True, text=True).stdout)["entries"][0]["text"]
    args = [binary, "--word", w, "--raw", raw, "--target-lang", "zh-Hans", "--title", t] + (["--abstract", a] if a else []) + (["--history", h] if h else []) + extra
    d = json.loads(subprocess.run(args, capture_output=True, text=True).stdout)
    top = (d.get("senses") or [""])[0]; ok = bool(re.search(gold, top)); hit += ok
    print(f"{'✓' if ok else '✗'} {w:9} {t[:42]:42} → {d.get('senses')} {d.get('method')} {d.get('reason') or ''}")
print(f"{hit}/{len(C)}")
