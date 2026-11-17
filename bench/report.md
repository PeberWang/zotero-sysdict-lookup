# 端侧义项选择基准报告（构造集第一批）

> **这是作者构造的 24 个案例，不是真实划词样本**，不代表真实阅读中的词与语境分布。下面所有数字只描述这 24 例上的表现；样本很小，置信区间很宽，凡是区间重叠的比较都**不足以判断**谁更好。

- 方案：A 候选法、B 原文两步、C 原文一步；每例每方案 3 次，共 216 次调用
- 案例：24 例，六个领域各 4 例；难例 10 例（42%）
- 模型：本机 Apple Foundation Models，`permissiveContentTransformations`，greedy 采样，单次 6 s 超时
- 词条：New Oxford American Dictionary，截前 2000 字（与插件一致）
- 置信区间：按案例重抽样的 bootstrap（2000 次，种子 20261116），先对每例 3 次取均值再抽样

## 1. 结论表

| 指标 | A 候选法 | B 原文两步 | C 原文一步 |
| --- | --- | --- | --- |
| 首选命中率（95% CI） | 83%（67%–96%） | 83%（67%–96%） | 62%（42%–79%） |
| 前三覆盖率（95% CI） | 92%（79%–100%） | 96%（88%–100%） | 71%（50%–88%） |
| 解析失败率 | 0% | 0% | 17% |
| 超时率 | 0% | 0% | 0% |
| 校验拦截率（占解析出的短语） | 26% | 0% | 23% |
| 编造率（短语与原文实词重合 < 0.5） | 6% | 0% | 23% |
| 延迟 p50 | 642 ms | 970 ms | 565 ms |
| 延迟 p95 | 823 ms | 1423 ms | 770 ms |
| prompt 字符数均值 | 1492（约 373 token） | 2690（约 672 token） | 2520（约 630 token） |
| 三次完全一致的案例比例 | 100% | 100% | 100% |

### 配对比较（同一批案例，首选命中率之差）

| 比较 | 差值 | 95% CI | 能否判断 |
| --- | --- | --- | --- |
| C 原文一步 − A 候选法 | -21 个百分点 | -46 到 +0 | 不足以判断（区间跨 0） |
| C 原文一步 − B 原文两步 | -21 个百分点 | -42 到 +4 | 不足以判断（区间跨 0） |
| B 原文两步 − A 候选法 | +0 个百分点 | -17 到 +17 | 不足以判断（区间跨 0） |

## 2. 难例 vs 易例

难例：本文语境里不止一个义项说得通，期刊或领域还会把人引向错的那个，只有靠标题、摘要或历史里的细节才能定。

| 方案 | 易例首选（n=14） | 难例首选（n=10） | 易例前三 | 难例前三 |
| --- | --- | --- | --- | --- |
| A 候选法 | 86%（64%–100%） | 80%（50%–100%） | 93% | 90% |
| B 原文两步 | 100%（100%–100%） | 60%（30%–90%） | 100% | 90% |
| C 原文一步 | 57%（29%–79%） | 70%（40%–90%） | 64% | 80% |

按领域的首选命中率（每格 4 例 × 3 次，只作描述）：

| 方案 | biology | computer science | economics | law | political science | statistics |
| --- | --- | --- | --- | --- | --- | --- |
| A 候选法 | 100% | 100% | 75% | 75% | 100% | 50% |
| B 原文两步 | 75% | 100% | 75% | 75% | 100% | 75% |
| C 原文一步 | 50% | 25% | 100% | 50% | 75% | 75% |

## 3. 现象记录（供写作参考，非结论）

### 3.1 三条义项之间的语义相似度

用系统自带的 `NLEmbedding.sentenceEmbedding(for: .english)` 计算最终义项两两的余弦相似度，再取均值。数值越高，表示三条越像在重复同一个意思。

| 方案 | 均值 | 四分位（25% / 50% / 75%） | 有效调用 |
| --- | --- | --- | --- |
| A 候选法 | 0.01 | -0.12 / 0.03 / 0.16 | 45 |
| B 原文两步 | -0.08 | -0.14 / -0.07 / -0.04 | 72 |
| C 原文一步 | -0.01 | -0.10 / -0.01 / 0.02 | 51 |

### 3.2 延迟与 prompt 长度

| 方案 | prompt 字符与延迟的 Pearson r | 短 prompt（< 2000 字符）延迟中位 | 长 prompt（≥ 2000）延迟中位 |
| --- | --- | --- | --- |
| A 候选法 | 0.65 | 642 ms（n=72） | — ms（n=0） |
| B 原文两步 | 0.57 | 647 ms（n=12） | 1043 ms（n=60） |
| C 原文一步 | 0.17 | 550 ms（n=12） | 635 ms（n=48） |

输出长度也影响延迟（A 方案每条义项一行、B 方案输出两行），所以这里的相关性不能解读为 prompt 长度单独造成的。

### 3.3 失败的案例长什么样

三次都没把金标排第一的（案例, 方案）组合共 17 个。下面逐个列出第一次的输出：

| 案例 | 难度 | 方案 | 金标 | 模型给的三条 | 金标排位 |
| --- | --- | --- | --- | --- | --- |
| econ-04 `bond` | hard | A | a relationship between people or groups … | legal agreement for repayment ； government-issued promise to repay debt | 不在前三 |
| econ-04 `bond` | hard | B | a relationship between people or groups … | a connection between two surfaces joined by adhesive ； an agreement with legal force to repay money ； a relationship bas | 3 |
| pol-02 `party` | easy | C | a formally constituted political group, … | （unparsable） | 不在前三 |
| law-01 `interest` | hard | B | a legal concern, title, or right in prop… | a stake, share, or involvement in an undertaking ； money paid regularly for use of lent money ； the advantage or benefit | 不在前三 |
| law-01 `interest` | hard | C | a legal concern, title, or right in prop… | stake in property ； legal concern ； common concern | 2 |
| law-04 `brief` | easy | A | a summary of the facts and legal points … | concise in expression; using few words ； US English a written summary of the facts and legal points supporting one side… | 2 |
| law-04 `brief` | easy | C | a summary of the facts and legal points … | （unparsable） | 不在前三 |
| cs-01 `thread` | easy | C | a programming structure or process forme… | （unparsable） | 不在前三 |
| cs-02 `cache` | easy | C | an auxiliary memory from which high-spee… | （unparsable） | 不在前三 |
| cs-04 `memory` | hard | C | the faculty by which the mind stores and… | storing information reliably ； recalling past data ； computer data retention | 不在前三 |
| bio-01 `cell` | easy | C | the smallest structural and functional u… | Biology unit ； microscopic structure ； enclosed cavity | 不在前三 |
| bio-02 `culture` | hard | B | the attitudes and behavior characteristi… | the cultivation of bacteria in artificial medium ； the customs, arts, social institutions of a group ； a refined underst | 2 |
| bio-02 `culture` | hard | C | the attitudes and behavior characteristi… | （无输出） | 不在前三 |
| stat-02 `variance` | easy | A | a quantity equal to the square of the st… | （无输出） | 不在前三 |
| stat-02 `variance` | easy | C | a quantity equal to the square of the st… | discrepancy between statements ； variance as a statistical quantity | 2 |
| stat-04 `bias` | hard | A | prejudice in favor of or against one thi… | distort statistical results; introduce bias into sampling methods ； cause to feel or show inclination or prejudice for o | 2 |
| stat-04 `bias` | hard | B | prejudice in favor of or against one thi… | systematic distortion in statistical results ； prejudice in favor of one group ； concentration on a particular subject | 2 |

### 3.4 解析失败与疑似编造的原始输出（第 1 次重复）

| 方案 | 案例 | 类型 | 原始输出 / 被计为编造的短语 |
| --- | --- | --- | --- |
| A | econ-01 | 编造 1 条 | money paid regularly for use of lent funds ； stake or share in a financial undertaking ； benefit from lending money over time |
| A | econ-04 | 编造 1 条 | legal agreement for repayment ； government-issued promise to repay debt ； social connection enabling lending |
| A | stat-02 | 编造 1 条 | a measure of spread in data |
| C | bio-02 | 编造 3 条 | norms and shared practices ； laboratory cultivation methods ； scientific community norms |
| C | bio-03 | 编造 2 条 | Gene activity ； rhythmic transcription ； daily oscillation |
| C | cs-01 | 解析失败 | thread: programming structure, concurrent elements, linked messages |
| C | cs-02 | 解析失败 | Cache: hidden storage; fast retrieval; data storage |
| C | cs-03 | 编造 1 条 | central part of operating system ； core of Linux kernel ； basic unit of scheduling |
| C | econ-04 | 编造 1 条 | relationship based on shared feelings ； substitute for collateral ； kinship ties |
| C | law-02 | 编造 1 条 | exchange for a promise ； legal trade-off element ； bargained-for consideration |
| C | law-03 | 编造 1 条 | right to ownership ； ownership documents ； land collateral |
| C | law-04 | 解析失败 | brief: legal summary, court document, task instruction |
| C | pol-01 | 编造 1 条 | authoritarian government ； system of power-sharing ； conditions of elite rule |
| C | pol-02 | 解析失败 | Sense 1: political group contesting elections   ⏎ Sense 2: group taking part in activity   ⏎ Sense 3: person forming side in dispute |
| C | pol-03 | 编造 2 条 | civil government function ； fiscal capacity measure ； bureaucratic reach |
| C | stat-01 | 编造 1 条 | statistical deviation from random ； false discovery control ； importance of results |
| C | stat-02 | 编造 1 条 | discrepancy between statements ； reduction of estimator variability ； variance as a statistical quantity |

## 4. 逐例明细

每格是三次的首选命中次数，括号里是三次中金标进入前三的次数。

| 案例 | 领域 | 难度 | 词 | 金标 | A 候选法 | B 原文两步 | C 原文一步 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| econ-01 | economics | easy | interest | money paid regularly at a particular… | 3/3（3） | 3/3（3） | 3/3（3） |
| econ-02 | economics | easy | capital | wealth in the form of money or other… | 3/3（3） | 3/3（3） | 3/3（3） |
| econ-03 | economics | hard | margin | a profit margin… | 3/3（3） | 3/3（3） | 3/3（3） |
| econ-04 | economics | hard | bond | a relationship between people or gro… | 0/3（0） | 0/3（3） | 3/3（3） |
| pol-01 | political science | easy | regime | a government, especially an authorit… | 3/3（3） | 3/3（3） | 3/3（3） |
| pol-02 | political science | easy | party | a formally constituted political gro… | 3/3（3） | 3/3（3） | 0/3（0） |
| pol-03 | political science | hard | state | a nation or territory considered as … | 3/3（3） | 3/3（3） | 3/3（3） |
| pol-04 | political science | hard | party | a person or people forming one side … | 3/3（3） | 3/3（3） | 3/3（3） |
| law-01 | law | hard | interest | a legal concern, title, or right in … | 3/3（3） | 0/3（0） | 0/3（3） |
| law-02 | law | hard | consideration | (in a contractual agreement) anythin… | 3/3（3） | 3/3（3） | 3/3（3） |
| law-03 | law | hard | title | a right or claim to the ownership of… | 3/3（3） | 3/3（3） | 3/3（3） |
| law-04 | law | easy | brief | a summary of the facts and legal poi… | 0/3（3） | 3/3（3） | 0/3（0） |
| cs-01 | computer science | easy | thread | a programming structure or process f… | 3/3（3） | 3/3（3） | 0/3（0） |
| cs-02 | computer science | easy | cache | an auxiliary memory from which high-… | 3/3（3） | 3/3（3） | 0/3（0） |
| cs-03 | computer science | easy | kernel | the most basic level or core of an o… | 3/3（3） | 3/3（3） | 3/3（3） |
| cs-04 | computer science | hard | memory | the faculty by which the mind stores… | 3/3（3） | 3/3（3） | 0/3（0） |
| bio-01 | biology | easy | cell | the smallest structural and function… | 3/3（3） | 3/3（3） | 0/3（0） |
| bio-02 | biology | hard | culture | the attitudes and behavior character… | 3/3（3） | 0/3（3） | 0/3（0） |
| bio-03 | biology | easy | expression | the appearance in a phenotype of a c… | 3/3（3） | 3/3（3） | 3/3（3） |
| bio-04 | biology | easy | host | an animal or plant on or in which a … | 3/3（3） | 3/3（3） | 3/3（3） |
| stat-01 | statistics | easy | significance | the extent to which a result deviate… | 3/3（3） | 3/3（3） | 3/3（3） |
| stat-02 | statistics | easy | variance | a quantity equal to the square of th… | 0/3（0） | 3/3（3） | 0/3（3） |
| stat-03 | statistics | easy | sample | a small part or quantity intended to… | 3/3（3） | 3/3（3） | 3/3（3） |
| stat-04 | statistics | hard | bias | prejudice in favor of or against one… | 0/3（3） | 0/3（3） | 3/3（3） |

各案例的理由（为什么金标是对的）见 `bench/cases.jsonl` 的 `rationale` 字段；每次调用的原始输出见 `bench/results.csv`。

## 5. 限制与已知偏差

- **构造集**：案例、金标、难度标注都由同一作者（Claude）完成，且作者同时写了 B、C 两个方案的提示词。虽然案例在跑方案之前已定稿（`bench/build_cases.py`），仍可能无意中偏向作者熟悉的表达。
- **样本量**：24 例，每格最多 4 例。领域表只作描述，不能做领域间比较。
- **判分是正则**：`gold_regex` / `exclude_regex` 判定短语是否表达金标。审计发现部分近邻子义项（如 state 的「联邦州」、memory 的「记忆中的事物」）也会被算对，口径偏宽；改写得很远的正确短语可能被判错。
- **编造率是代理指标**：短语与原文实词重合度低于 0.5 就记为编造，没有人工核对；措辞完全改写但意思正确的短语也会被计入。
- **A 方案的落地校验最严**：它只能在候选里挑，拦截率的口径与 B、C 不同（包括标签错位的改正），不能直接横比。
- **greedy 采样**：与插件一致。三次重复主要反映系统层面的非确定性，不代表温度采样下的方差。
- **只测英文目标、只用 NOAD**：不覆盖中文输出，也不覆盖其他词典的版式。
- **每次调用新开会话**，不含插件里子进程启动的开销（约几十毫秒），也不含查词时间。
- 同一台机器、同一时段连续运行；机器负载与模型冷启动可能带来系统性的延迟偏差。重复放在外层并打乱方案顺序，只能部分缓解。

## 6. 下一步

- **第二批真实样本怎么采**：插件已把每篇文献的划词按时间存在 `~/Library/Application Support/Zotero/sysdict/history/<itemID>.json`。实现 `run.py` 里的 `import_history()`：按 itemID 从 Zotero 数据库补读元数据，每个词生成一行，用它之前的 4–6 个词作历史；金标由读者（铭培）事后标注：当时要的是哪个意思。标注要在看到任何方案的输出之前完成。
- **采多少才有意义**：粗算，首选命中率在 70% 附近时，n 个案例的 95% 区间半宽约为 1.96·√(0.21/n)：n=24 时约 ±18 个百分点，n=100 时约 ±9，n=200 时约 ±6。要分辨 10 个百分点的方案差异，配对比较至少需要约 150–200 个已标注的真实划词，并且要来自不少于 20 篇文献，以免被少数文章主导。
- **最值得长期跟踪的指标**：首选命中率（直接对应用户感知），难例上的首选命中率（衡量语境到底有没有用），编造率（安全底线），以及延迟 p95（决定弹窗体验）。前三覆盖率与一致性可作为回归告警。
- **建议**：每次改提示词或换系统版本时重跑本基准，`results.csv` 按日期归档，比较时只看配对差及其区间。
