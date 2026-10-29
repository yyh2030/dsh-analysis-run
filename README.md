# 分析直通（analysis-run）

DDT 原始 CSV → 逐试次长表 → 无差异点 / AUC / k → 三线表、图与报告。每次运行写下数据指纹、
排除名单与门禁结论，让「这是截止哪天、n = 多少」永远说得清。

## 数据契约

```
<labDir>/                      默认 D:/yyh-lab
  cache/                       派生缓存，删掉可重建
    manifest.json              每个原始文件的 mtime / size / session
    files/<sha12>-<原名>.csv    单文件解析结果
    trials.csv                 逐试次长表（全部被试全部时间点）
    indifference_points.csv    每格无差异点
    auc_k.csv                  每被试每时间点 AUC / k / ln(k)
    auc_wide.csv               每被试一行（T0/T1/T2 宽表 + 分组）
  runs/<runId>/                每次运行，runId = YYYYMMDD-HHMMSS
    dataset.csv                合并后的分析数据集（含 included / excluded 列）
    tables/table1..8*.csv      三线表（utf-8-sig，Excel 直接开）
    fig_auc_trajectory.png     各格 AUC 轨迹（M ± SE）
    fig_auc_by_cell.png        T2 各格分布
    model.json                 描述统计、主分析、敏感性、假设检查
    meta.json                  输入指纹、n、included/excluded、门禁、与上次的差异
    report.md                  报告（表、图、口径）
  exclusions.csv               排除名单：编号,原因,时间,操作
```

原始数据（`正式实验数据/DDT/*.csv`）与量表作答一律只读。`cache/` 与 `runs/` 都是缓存，
删掉会重算；`meta.json` 是唯一承诺保存的「哪版数据对哪版结果」记录。

## 五个阶段

| 阶段 | 做什么 | 缓存键 / 依赖 |
|---|---|---|
| 1 ingest | 解析 `正式实验数据/DDT/*.csv`，拼成逐试次长表 | 每个文件的 mtime + size（变了才重解析） |
| 2 derive | 每格第 6 次呈现 → 无差异点 → 归一化 AUC 与 k | 逐试次长表 |
| 3 merge | AUC 宽表 + `_lab/scores.csv` + `demographics.json` + 排除名单 | 各输入文件 |
| 4 model | 描述统计、质控、T2−T0 变化；门禁到了再跑 ANCOVA | 数据集 + 脚本哈希 |
| 5 report | 三线表、两张图、`report.md` | 模型输出 |

新被试进来时只有摄取阶段真的干活；其余阶段重算，n 不到 200 时整条管子在一两秒内跑完。

## 口径（改之前先想清楚）

- 无差异点：每格第 6 次呈现的即时金额（IP）。
- AUC：Myer et al. (2016) 归一化，`r = IP / 该档延迟金额`，`x = 延迟 / 1825 天`，
  锚点 `(0, 1)`，梯形积分，取值 0–1；两档平均。
- k：`V = A / (1 + kD)`，按档最小二乘拟合，`log10(k) ∈ [−7, 2]`；`ln(k)` 取两档平均。
- 分组：编号第 1 位 1=MS / 2=DP，第 2 位 1=EFT / 2=ERT。
- 排除：只执行 `_lab/exclusions.csv` 的名单，脚本从不自动排除。
- 版本：`ddt.py` + `pipeline.py` 的 sha256 写进 `meta.json`；改口径必须同时改 `VERSION`。

以上与 `03_延迟折扣任务与代码/Codes/` 里的 `ddt_extract_rt.py`、`ddt_preprocess.py`、
`ddt_primary_analysis.py` 一致：在 12 名历史被试上，IP 与 AUC/ln(k) 与旧输出逐位相同
（`tests/test_ddt.py` 里有这条对拍）。

## 门禁

- `n < 30`：只出预处理、描述统计与质控，不出推断结论。
- `30 ≤ n < 40`：描述统计 + T2−T0 的配对变化（描述性 95% CI），仍不出主分析。
- `n ≥ 40`：主分析 `AUC_T2 ~ 突显 × 干预 + AUC_T0`（Type III，Sum 编码），
  同时给简单效应、调整均值与 `ln(k)` 敏感性分析。

门禁阈值在插件配置 `gateExplore` / `gateMain`，环境变量 `DDT_GATE_EXPLORE` / `DDT_GATE_MAIN`
只用于测试，别在正式运行里设。

## 工具与面板

- `analysis_status()`：上次运行、n、截止日、门禁、新到文件、缓存与排除名单。
- `analysis_run(stage)`：`all` 或单阶段；单阶段并进最近一次运行（面板给的那次）。
- `analysis_results(runId?, table?)`：读某次运行的三线表与要点。
- `analysis_exclude(op, id, reason?)`：维护排除名单（`add` 必须给理由）。
- 面板「分析直通」：状态头、单跑阶段、三线表、报告、图、运行历史、排除名单。

## 安装与配置

```
目标目录：D:/dsh-plugins/analysis-run
安装：plugin_manager install_bundle  D:/dsh-plugins/analysis-run
```

`cordis.patch.yml` 的配置项：

| 键 | 默认 | 说明 |
|---|---|---|
| `projectRoot` | `C:/Users/16787/OneDrive/Desktop/yyh硕士论文` | 原始数据在它下面 |
| `labDir` | `D:/yyh-lab` | 缓存、运行记录、排除名单 |
| `rawDir` | `<projectRoot>/正式实验数据/DDT` | 原始 CSV 目录 |
| `pythonPath` | 项目里的 `.analysis_venv` | 需要 pandas / numpy / scipy / statsmodels（画图另需 matplotlib） |
| `gateExplore` / `gateMain` | 12 / 12（当前配置；设计稿预设 30 / 40） | 门禁。低于 40 时主分析照跑，但报告会标「只作探索性参考」 |

> 当前为了先看主分析，配置里把门禁降到了 12；报告与 `meta.json` 都会注明「样本低于预设门禁 40，
> 只作探索」。等 n 到 40 时把 `gateExplore`/`gateMain` 改回 30/40，这个提示会自动消失。

## 测试

```
<pythonPath> -m unittest discover -s tests -v
```

`tests/test_ddt.py` 覆盖：IP 取第 6 次呈现、AUC 与手算梯形积分一致、k 拟合还原已知 k、
宽表分组、与历史分析的逐位对拍（历史输出不存在时跳过）。

## 排错

- **Python 不可用**：面板顶部会写具体错误。确认 `pythonPath` 指向的解释器能
  `import pandas, statsmodels`；项目里那个 venv 是现成的。
- **同一 session 有两个文件**：摄取阶段保留 `expStart` 最晚的一份，其余记进
  `meta.json` 的 `dropped`，并在质控表的「重复试次」里露出。
- **单跑模型/报告说「先跑合并」**：那一次运行还没有 `dataset.csv`。点「跑全部」，
  或先跑合并阶段。
- **结果和上次不一样**：看 `meta.json` 的 `changedSinceLast`（新增/退出的被试、交互项 p 的变化）。
