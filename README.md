# @local/analysis-run

[English](README.en.md) · 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)写的研究插件:分析直通。选定数据文件、点几下完成方案、跑出一个带输入快照与环境锁的运行记录,再导出成 HTML/PDF 报告和三线表 Word/Excel。

版本 0.3.0 · 需要 DSH ≥ 0.2.2-rc.1 · MIT 许可 · 依赖 [`@local/research-core`](https://github.com/yyh2030/dsh-research-core)

## 为什么需要它

临时脚本能算出结果,但半年后通常无法回答三个问题:当时用的是哪份数据、跑的是哪个版本的环境、为什么排除了那几个人。第二次跑出不同的数字时,也没法判断是数据变了还是代码变了。

分析直通把每次运行做成不可变快照:输入 CSV、研究定义、方案、排除清单、环境版本、引擎与插件代码副本与 hash、节点模型、表格与报告一起保存。每次运行有独立目录和唯一 `runId`,已完成的运行不会被覆盖;新的分析可以用 `revisionOf` 指向某个较早的运行。来源与产物都有 hash,产物损坏时隐藏结果而不是显示一个混合版本。

## 能做什么

### 分析向导

「分析方案」页是一条引导流程:

1. **选类型**:十张卡片 —— 描述与样本、相关、信度、t 检验、方差分析、回归/ANCOVA、中介、配对变化、混合模型、自定义脚本。选卡片即确定要跑哪些模块。
2. **选变量**:下拉框与 chip 由数据集的实际列名生成,`preview` 只返回列清单,不写任何运行文件。
3. **看预览**:显示推算出的公式、数据集行列数、每个模块的合格人数与所需后端、预期产出的表格与图。
4. **保存并运行**:或切到「高级编辑」直接改字段(不常见的方案仍然可用)。

### 内置分析模块

| 模块 | 内容 |
|---|---|
| `descriptives` | 分组有效/缺失观测数、独立参与者数、描述统计(含标准误、95% CI、四分位数、频数表与百分比) |
| `sample` | 样本特征表(Table 1):数值变量给均值/SD/中位数/缺失,分类变量给各水平计数与百分比,按第一个分组列分层并给"整体" |
| `sensitivity` | 缺失处理敏感性:同一规则下比较"全部观测"与"完整病例"两个分析集的分组均值与差 |
| `correlation` | Pearson 或 Spearman、可选偏相关、可选 BH 校正 |
| `reliability` | 每个量表给组合信度,支持反向题与条目缺失 |
| `ttest` | 独立样本或单样本 t 检验 |
| `anova` | 一或两个因素的方差分析,平方和类型 I/II/III,可声明对比 |
| `regression` | OLS:分类组别主效应、数值协变量、组别之间的交互项;ANCOVA 就是同一模型加上基线协变量 |
| `mediation` | X → M → Y,自助法重抽样(默认 1000 次,可设随机种子) |
| `paired` | 配对变化:宽表 `pairedColumns` 或长表 `within`,用完整配对做配对 t 检验 |
| `mixed` | 长表:声明的 within 列与水平、分类组别、数值协变量,ML 随机参与者截距 |

每个推断模块各自按配置的最小人数筛自己的合格独立参与者(默认 30)。节点状态只有三种:`executed`、带原因的 `not_run`、`failed`。p 值在模型与 CSV 里保持全精度,报告只做显示格式化。缺失数值是空单元格;非数值或无穷值在输入校验阶段就失败。

### 自定义 Python 脚本

内置模块覆盖不到的设计,选「自定义脚本」卡片或直接写 `plan.script`:

```python
means = data.groupby('group', as_index=False)['outcome'].mean()
save('group_means', means)
```

- `data` 是准备好的宽表或长表,和内置模块用的是同一批行。
- `save(name, frame)` 写一张 CSV 表;每张保存的表都会进入本次运行的结果、HTML/PDF 报告与 Word/Excel 导出。
- 可以用 `pd`(pandas)、`out_dir`(在表格旁边写任意文件);装了自带后端时也可以用 `scipy` / `statsmodels`。
- 脚本在子进程里跑,180 秒超时;非零退出、超时或"没有保存任何表"都会让节点以可读原因失败,不会把上一份表混进来。
- `plan.script.file` 可以指向一个 `.py` 文件,代替内联 `code`(内联代码上限 50000 字符)。

脚本是你自己的代码,以你的权限执行:放在版本控制里、运行前看一眼改动、不要指向不可信的文件。

### 运行记录与导出

每次运行的目录在 `<dataRoot>/analysis/runs/<runId>/`,包含:

- `input.csv`(输入数据快照)、`plan.json`、`study.json`、`exclusions.json`;
- `environment.json` 与 `environment.lock.json`(解释器、包版本、BLAS 等环境锁);
- `code/`(引擎、Host、客户端与共享辅助代码的副本与 hash)、`meta.json`、`model.json`(各节点模型);
- `tables/`、`report.md`、`report.html`、`report.pdf`、`results.json`、`manifest.json`、`tables.docx`、`tables.xlsx`、`figures/*.svg|png`。

环境锁先于指纹缓存检查:环境漂移就失败,而不是悄悄用另一个 scipy 版本重算。`environmentPolicy: 'record'` 用于按当前环境重建锁。数据、方案、代码、环境四者都没变时,同一 fingerprint 会复用上次成功的运行(`reused: true`)。

导出全部本地渲染:HTML 自包含,CSP 禁止外部资源;PDF 由本机无头 Chrome/Edge 打印;Word/Excel 的三线表由本机 python-docx / openpyxl 生成。渲染失败会写进结果说明,不静默跳过。

### 排除清单

人工排除必须填理由并给一个研究内有效的编号;排除记在方案侧,新运行生效,历史快照不变,所以旧运行仍然保持它当时的分析集。

### Agent 工具

| 工具 | 用途 |
|---|---|
| `analysis_status` | 当前研究、分析方案、输入状态与运行历史 |
| `analysis_run` | 跑通用分析或显式配置的本地适配器,保存独立快照 |
| `analysis_results` | 读取某次运行的动态表格、节点状态与报告 |
| `analysis_export` | 把某次运行导出为自包含 HTML/PDF/三线表图片与产物清单 |
| `analysis_exclude` | 按编号维护人工排除,留理由 |

因为面板本身就是 Harness 插件,也可以直接在对话里描述需求,例如"用当前分析数据跑 outcome 在 group 上的 ANCOVA,控制 baseline,然后导出报告"。Agent 会映射成同一套 `run` / `export` 动作,面板随后显示这次运行。

### 本地适配器与刷新工具

`adapterPath` 可以指向一个本地 JSON manifest(`schemaVersion: 1`、`pipelinePath`、动态 `stages`、可选 `tableLabels`、`gateEnvironment`、`exclusionsFile`、`exclusionColumns`),Host 把路径传给适配器的 `--stage … --json` 命令行。适配器不会被自动发现,它自己的历史与阶段规则也由适配器维护。

`tools/refresh-dataset.mjs` 是一个可选的命令行工具:把最新数据合成为分析数据集、与当前冻结数据比较 sha256、有变化就冻结新数据集并重跑分析、导出报告,输出一行 JSON 摘要。研究路径全部由参数或环境变量提供,仓库里不写死任何本机研究。

## 安装

```powershell
git clone https://github.com/yyh2030/dsh-research-core.git
git clone https://github.com/yyh2030/dsh-analysis-run.git
dsh plugin --profile <profile> add link:<父目录>\dsh-analysis-run
```

或者用 git 形式:

```powershell
dsh plugin --profile <profile> add git+https://github.com/yyh2030/dsh-analysis-run.git
```

两种方式都要求 `research-core` 与本插件同级,插件用相对路径 `../research-core/host.mjs` 引用共享核心。仓库是私有的,安装前需要有访问权限。装完重启承载 `dsh web` 的进程。

### 统计后端

插件自带 vendor 里的统计后端,不依赖 DSH 运行时是否装过 scipy / statsmodels:

```powershell
node vendor/install.mjs           # 装到 vendor/site-packages
node vendor/install.mjs --check   # 只看当前解释器与已装版本
```

`vendor/wheels` 里是离线 wheel(scipy 1.18.1、statsmodels 0.15.0、patsy、formulaic、interface_meta、narwhals、wrapt、packaging,约 47 MB),安装后约 192 MB,可随时删除重建。运行时插件把 `vendor/site-packages` 前置到 `PYTHONPATH`,numpy 与 pandas 仍由 DSH 运行时提供,避免两份二进制包冲突。当前 wheel 是 `cp312` / `win_amd64`;换解释器时把对应 wheel 放进 `vendor/wheels` 再重跑脚本,ABI 不匹配会明确报错而不是装出半个环境。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `studyPath` | 空 | 研究定义 JSON;为空时用配置项目录下的空研究,查询不建目录 |
| `pythonPath` | 运行时 Python | 执行引擎的解释器;需要 numpy 与 pandas |
| `dataPath` | 研究的 `plugins.analysis.dataPath` | 分析数据 CSV |
| `adapterPath` / `pipelinePath` | 空 | 显式指定的本地适配器 manifest 或管道 |
| `labDir` / `rawDir` / `projectRoot` | 研究根 | 相对路径基准 |
| `autoRun` | `false` | 去抖自动运行;默认关闭 |
| `debounceMs` / `autoPollMs` | `3000` / `2000` | 自动运行的去抖与轮询间隔 |

研究定义里的分析段:

```json
{
  "plugins": {
    "analysis": {
      "dataPath": "./measurements.csv",
      "idColumn": "participantId",
      "outcome": "outcome",
      "layout": "wide",
      "groupColumns": ["group"],
      "covariates": ["baseline"],
      "analyses": ["descriptives", "regression"],
      "gate": { "minSubjects": 30 }
    }
  }
}
```

## 数据与隐私

- 不联网:分析、绘图、导出全部在本机完成,不调云端渲染。
- 不存姓名与联系方式:参与者是任意非空字符串编号,组别是独立列,报告里只出现编号。
- 未支持或有歧义的选项在运行前显式拒绝,不会偷偷拟合一个近似模型来凑结果。
- 运行目录里有输入数据快照,按研究数据的敏感级别对待;分享报告时优先给 HTML/PDF 而不是整个运行目录。

## 已知限制

- 只支持正态分布(`distribution` 为 gaussian);其他分布会报错而不是换近似模型。
- 随机斜率尚未实现(`randomSlopes` 会被拒绝),混合模型只有声明过的随机截距。
- 回归要求独立观测的宽表;重复测量要走 `mixed`。
- 方差分析最多两个因素;交互项只支持两个分类组别列之间。
- 配对检验是合并的未调整变化,配置的组别与协变量不进入这个检验。
- 中介用自助法,结果依赖重抽样次数与种子;换种子会有小数级差异。
- PDF 需要本机 Chrome/Edge(`DSH_CHROME` 可指定);没有时只有 HTML/SVG。
- Word/Excel 导出需要运行时提供 python-docx 与 openpyxl;缺失时导出记录失败原因。
- 自带后端 wheel 目前是 `cp312` / `win_amd64`,其他平台或解释器需要自己补 wheel。
- 仓库内没有 `acceptance/` 目录,也没有 `test` 脚本;历史 README 中引用的验收脚本不在当前仓库里。

## 许可

MIT，见仓库根目录 `LICENSE`（Copyright © 2026 Yuhui YANG）。许可只覆盖插件代码，不覆盖研究数据：被试信息、问卷作答、研究定义与由它们派生的数据仍归研究方所有，不随本许可授权。自带的 scipy / statsmodels / numpy / pandas 为 BSD 许可，随插件再分发时保留各 wheel 内的 LICENSE 即可。

## 支持矩阵与统计后端准备（09）

- 已验证：Windows x64 + DSH 运行时 CPython 3.12（wheel 标签 cp312 / win_amd64）。
- 未验证：macOS / Linux、Python 3.13、ARM。
- 显式准备（不随插件安装自动执行）：
  1. 
ode vendor/install.mjs
  2. 
ode vendor/install.mjs --check —— 0=生效；2/3/4/5=解释器/ABI/安装/自检失败
- wheel 装到插件私有 endor/site-packages；numpy/pandas 仍由 DSH 运行时提供。
- 换解释器或平台：放入对应 wheel 后重跑 install.mjs；没有 wheel 时显示环境待准备，不伪装支持。