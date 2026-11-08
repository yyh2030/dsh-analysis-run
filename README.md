# Analysis Run

Local CSV analysis for independent and repeated observations. A study definition supplies identity, paths and column mappings. Participants are nonempty strings; groups are separate columns. There are no personal data paths or task-specific defaults.

## Configuration

Use `studyPath` to select a JSON study. Relative paths in `plugins.analysis` resolve from that document. With no study file, the plugin uses an empty path-based study rooted in the configured project directory. Queries do not create directories. Set `pythonPath` to an interpreter with numpy, pandas, scipy and statsmodels, or provide `python` on PATH.

```json
{
  "schemaVersion": 1,
  "studyId": "sample-study",
  "name": "Sample study",
  "dataRoot": "./data",
  "plugins": {
    "analysis": {
      "dataPath": "./measurements.csv",
      "idColumn": "participantId",
      "outcome": "score",
      "layout": "wide",
      "groupColumns": ["condition"],
      "covariates": ["baseline"],
      "analyses": ["descriptives", "regression"],
      "gate": { "minSubjects": 30 }
    }
  }
}
```

The panel edits a study-local analysis plan. Saving requires the current study and plan revision. Exclusions require a reason and arbitrary study-valid participant ID. Every new run takes a snapshot; historical runs retain their original input and analysis set.

## Analysis wizard (panel)

The 分析方案 tab is a guided flow:

1. Pick one of nine task cards (descriptive, correlation, reliability, t test, ANOVA,
   regression/ANCOVA, mediation, paired, mixed model). The card sets `analyses`.
2. Pick variables from dropdowns/chips built from the dataset columns (`preview` action
   returns the column list without writing anything).
3. The preview box shows the implied formula, dataset rows/columns, eligible participants
   per module, and the expected tables/figures.
4. "保存并运行" saves the plan and starts a run; "高级编辑" opens the raw field form
   (still available for unusual plans).

The `preview` action accepts a draft plan (`{plan}`) and returns
`{columns, rows, modules: {<module>: {eligible, backends}}}`. It never writes run files.

## Custom scripts (`script` module)

For analyses the built-in modules do not cover, select the 自定义脚本 card in the wizard
(or set `plan.script`) and write Python against the prepared dataset:

```python
means = data.groupby('group', as_index=False)['outcome'].mean()
save('group_means', means)
```

- `data` is the prepared wide/long DataFrame (same rows the built-in modules use).
- `save(name, frame)` writes a CSV table; every saved table is added to the run's
  tables, the HTML/PDF report, and the Word/Excel export.
- `pd` (pandas) and `scipy`/`statsmodels` (when the vendored backend is present) are
  available; `out_dir` lets you write arbitrary files next to the tables.
- The script runs in a subprocess with the data CSV, a 180 s timeout, and the plugin's
  Python environment. Nonzero exit, timeout, or "no tables saved" fail the node with a
  readable reason; the previous tables are not mixed in.
- `plan.script.file` runs a `.py` file instead of inline `code`.

Scripts are the user's own code, executed with the user's permissions: keep them in the
project, review changes before running, and never point them at untrusted files.

## Asking the Agent instead (natural language)

Because the panel is a Harness plugin, you can skip the form entirely and ask in the
conversation, for example:

> 用当前分析数据跑 outcome 在 group × condition 上的 ANCOVA，控制 baseline，然后导出报告。

The Agent maps that to the plan, calls the same `run`/`export` actions and reports back.
Useful for one-off models, re-running after data updates, or producing a written summary.
The panel then just shows the resulting run and its artifacts.

## Supported modules

- `descriptives`: group-wise valid/missing observations, independent participants and summary statistics.
- `regression`: independent wide rows, categorical group main effects and numeric covariates using OLS; ANCOVA is the same model with groups and baseline covariates. Rank-deficient designs fail explicitly.
- `paired`: pooled, unadjusted paired changes; configured groups/covariates do not enter this test. Wide `pairedColumns: ["before", "after"]`, or long `within: {"column":"visit", "levels":["before","after"]}`. Uses complete pairs and a paired t test.
- `mixed`: long rows, declared within column/levels, categorical between groups and numeric covariates, ML random participant intercept. Nonconvergence fails explicitly. This module does not claim to implement arbitrary longitudinal designs or automatic interactions.

Every inferential module applies the configured minimum to its own complete eligible independent participants. Each node is `executed`, `not_run` with reason, or `failed`. P values remain full precision in model/CSV; reports format only for display. Missing numeric values are blank CSV cells; nonnumeric/infinite input fails validation.

## Run records

`<dataRoot>/analysis/runs/<runId>/` contains input, study, plan and exclusion snapshots, package/environment versions, full engine/Host/client/shared helper code copies and hashes, node models, successful tables and report. The run ID is unique; completed runs are not overwritten. `revisionOf` links a new analysis to a selected earlier run. Source and artifact hashes detect changes. A corrupt artifact hides results rather than presenting a mixed version. Failed runs retain a status and error for recovery by a new run.

## Local adapters

An explicit `adapterPath` can point to a local JSON manifest with `schemaVersion:1`, `pipelinePath`, dynamic `stages`, optional `tableLabels`, `gateEnvironment`, `exclusionsFile` and `exclusionColumns`. A bare `pipelinePath` is also supported with explicit `projectRoot`, `rawDir` and `labDir`. The Host passes those paths to the adapter's `--stage ... --json` CLI. No adapter is automatically discovered. Adapter-owned history and stage rules remain the adapter's responsibility; the panel uses dynamic labels and tables. Private manifests and code do not belong in this package.

## API

Same-origin `/api/analysis-run` requires `x-analysis-run:1`. GET: `schema`, `status`, `results`, `preview`. POST: `plan`, `run`, `exclude`, `studyConnect`, `studySave`. Mutations carry `studyId`, `studyRevision`, `selectionRevision`; plan/exclusion saves also carry the corresponding revision from status. `studySave` creates a new definition without overwriting an existing file, then connects all registered research plugins. Tools inject current context automatically and serialize writes through the same actions.

Research switching shares a process registry across the four research plugins. A running or saving plugin rejects the switch; prepare is read-only, commit replaces validated in-memory context, and rollback restores it on failure. Initial project-specific overrides are discarded when selecting another study.

## Verification

Run `acceptance/test_engine.py` with an explicit scientific Python interpreter and `PYTHONDONTWRITEBYTECODE=1`. Run `acceptance/generic-host.test.mjs` and `acceptance/timeout.test.mjs` with Node and `ANALYSIS_TEST_PYTHON` pointing to that interpreter. Fixtures are synthetic and output only to temporary directories. No installed plugin, personal project or external HTTP service is required.
