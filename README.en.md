# @local/analysis-run

[中文](README.md) · English

A research plugin written for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): analysis straight-through. Pick a data file, complete a plan in a few clicks, run it into a run record with an input snapshot and an environment lock, then export it as an HTML/PDF report and three-line tables in Word/Excel.

Version 0.2.0 · Requires DSH ≥ 0.2.2-rc.1 · MIT license · Depends on [`@local/research-core`](https://github.com/yyh2030/dsh-research-core)

## Why it exists

A one-off script can compute a result, but six months later it usually cannot answer three questions: which data was used, which version of the environment it ran in, and why those few people were excluded. And when a second run produces different numbers, there is no way to tell whether the data changed or the code changed.

Analysis straight-through makes every run an immutable snapshot: the input CSV, study definition, plan, exclusion list, environment versions, copies and hashes of the engine, Host, client and shared helper code, node models, tables and reports are saved together. Each run has its own directory and a unique `runId`, and completed runs are never overwritten; a new analysis can point at an earlier run with `revisionOf`. Sources and artifacts both have hashes, and if an artifact is corrupted the results are hidden rather than shown as a mixed version.

## What it does

### Analysis wizard

The "Analysis plan" page is a guided flow:

1. **Choose a type**: ten cards — descriptives and sample, correlation, reliability, t test, ANOVA, regression/ANCOVA, mediation, paired change, mixed models, custom script. Choosing a card determines which modules will run.
2. **Choose variables**: dropdowns and chips are generated from the dataset's actual column names, and `preview` returns only the column list without writing any run files.
3. **Review the preview**: shows the derived formula, dataset row and column counts, the eligible participant count and required backend for each module, and the expected tables and figures.
4. **Save and run**: or switch to "Advanced editing" and change fields directly (unusual plans still work).

### Built-in analysis modules

| Module | Contents |
|---|---|
| `descriptives` | Valid/missing observation counts by group, distinct participant count, descriptive statistics (including standard error, 95% CI, quartiles, frequency table and percentages) |
| `sample` | Sample characteristics table (Table 1): mean/SD/median/missing for numeric variables, counts and percentages per level for categorical variables, stratified by the first group column with an "overall" column |
| `sensitivity` | Missing-data sensitivity: under the same rule, compare group means and differences between the "all observations" and "complete cases" analysis sets |
| `correlation` | Pearson or Spearman, optional partial correlation, optional BH correction |
| `reliability` | Composite reliability per scale, supporting reverse-scored items and item-level missingness |
| `ttest` | Independent-samples or one-sample t test |
| `anova` | One- or two-factor analysis of variance, sums of squares type I/II/III, with optional declared contrasts |
| `regression` | OLS: categorical group main effects, numeric covariates, interactions between groups; ANCOVA is the same model plus a baseline covariate |
| `mediation` | X → M → Y, bootstrap resampling (1000 by default, seed configurable) |
| `paired` | Paired change: wide format `pairedColumns` or long format `within`, using complete pairs for a paired t test |
| `mixed` | Long format: declared within columns and levels, categorical groups, numeric covariates, ML random participant intercept |

Each inferential module screens its own eligible distinct participants against its configured minimum (30 by default). Node states are only three: `executed`, `not_run` with a reason, and `failed`. P values keep full precision in models and CSV; the report only formats them for display. Missing numeric values are empty cells; non-numeric or infinite values fail during input validation.

### Custom Python scripts

For designs the built-in modules do not cover, choose the "Custom script" card or write `plan.script` directly:

```python
means = data.groupby('group', as_index=False)['outcome'].mean()
save('group_means', means)
```

- `data` is the prepared wide or long table, using the same rows as the built-in modules.
- `save(name, frame)` writes one CSV table; every saved table enters this run's results, the HTML/PDF report and the Word/Excel export.
- You can use `pd` (pandas) and `out_dir` (to write arbitrary files next to the tables); with the bundled backend installed you can also use `scipy` / `statsmodels`.
- The script runs in a subprocess with a 180-second timeout; a non-zero exit, a timeout, or "no table saved" makes the node fail with a readable reason, and never mixes in a previous run's table.
- `plan.script.file` can point at a `.py` file instead of inline `code` (inline code is capped at 50000 characters).

The script is your own code running with your permissions: keep it under version control, glance at the diff before running, and do not point it at untrusted files.

### Run records and export

Each run's directory is `<dataRoot>/analysis/runs/<runId>/` and contains:

- `input.csv` (input data snapshot), `plan.json`, `study.json`, `exclusions.json`;
- `environment.json` and `environment.lock.json` (interpreter, package versions, BLAS and other environment lock);
- `code/` (copies and hashes of the engine, Host, client and shared helper code), `meta.json`, `model.json` (per-node models);
- `tables/`, `report.md`, `report.html`, `report.pdf`, `results.json`, `manifest.json`, `tables.docx`, `tables.xlsx`, `figures/*.svg|png`.

The environment lock is checked before the fingerprint cache: environment drift fails the run instead of quietly recomputing with a different scipy version. `environmentPolicy: 'record'` rebuilds the lock for the current environment. When data, plan, code and environment are all unchanged, the same fingerprint reuses the last successful run (`reused: true`).

All exports are rendered locally: HTML is self-contained with a CSP that forbids external resources; PDF is printed by a local headless Chrome/Edge; the Word/Excel three-line tables are generated by local python-docx / openpyxl. A rendering failure is written into the result notes and is never skipped silently.

### Exclusion list

A manual exclusion must have a reason and an identifier valid within the study; exclusions are recorded on the plan side and apply to new runs while historical snapshots stay unchanged, so an old run keeps the analysis set it had at the time.

### Agent tools

| Tool | Purpose |
|---|---|
| `analysis_status` | Current study, analysis plan, input state and run history |
| `analysis_run` | Run a generic analysis or an explicitly configured local adapter, saving an independent snapshot |
| `analysis_results` | Read a run's dynamic tables, node states and report |
| `analysis_export` | Export a run as self-contained HTML/PDF/three-line table images and an artifact list |
| `analysis_exclude` | Maintain manual exclusions by identifier, with a reason |

Because the panel itself is a Harness plugin, you can also describe what you want in the conversation, for example "run an ANCOVA of outcome on group using the current analysis data, controlling for baseline, then export the report". The Agent maps it to the same `run` / `export` actions, and the panel then shows that run.

### Local adapters and the refresh tool

`adapterPath` can point at a local JSON manifest (`schemaVersion: 1`, `pipelinePath`, dynamic `stages`, optional `tableLabels`, `gateEnvironment`, `exclusionsFile`, `exclusionColumns`), and the Host passes the path to the adapter's `--stage … --json` command line. Adapters are not auto-discovered, and their own history and stage rules are maintained by the adapter.

`tools/refresh-dataset.mjs` is an optional command-line tool: it assembles the latest data into an analysis dataset, compares its sha256 with the currently frozen data, and on any change freezes a new dataset and re-runs the analysis and exports the report, printing a one-line JSON summary. All study paths come from arguments or environment variables; no local study is hard-coded in the repository.

## Installation

```powershell
git clone https://github.com/yyh2030/dsh-research-core.git
git clone https://github.com/yyh2030/dsh-analysis-run.git
dsh plugin --profile <profile> add link:<parent directory>\dsh-analysis-run
```

Or use the git form:

```powershell
dsh plugin --profile <profile> add git+https://github.com/yyh2030/dsh-analysis-run.git
```

Both ways require `research-core` to be a sibling of this plugin; the plugin references the shared core through the relative path `../research-core/host.mjs`. The repositories are private and require access before installation. After installing, restart the process hosting `dsh web`.

### Statistical backend

The plugin bundles its statistical backend under vendor and does not depend on whether the DSH runtime has scipy / statsmodels installed:

```powershell
node vendor/install.mjs           # install into vendor/site-packages
node vendor/install.mjs --check   # only report the current interpreter and installed versions
```

`vendor/wheels` holds the offline wheels (scipy 1.18.1, statsmodels 0.15.0, patsy, formulaic, interface_meta, narwhals, wrapt, packaging, about 47 MB), and the installation is about 192 MB and can be deleted and rebuilt at any time. At runtime the plugin puts `vendor/site-packages` at the front of `PYTHONPATH`, while numpy and pandas still come from the DSH runtime, avoiding a conflict between two binary copies. The current wheels are `cp312` / `win_amd64`; when changing interpreter, drop the matching wheels into `vendor/wheels` and re-run the script, and an ABI mismatch fails explicitly instead of installing half an environment.

## Configuration

| Key | Default | Description |
|---|---|---|
| `studyPath` | empty | Study definition JSON; when empty, an empty study under the configuration project directory is used and queries create no directories |
| `pythonPath` | runtime Python | Interpreter that runs the engine; needs numpy and pandas |
| `dataPath` | the study's `plugins.analysis.dataPath` | Analysis data CSV |
| `adapterPath` / `pipelinePath` | empty | An explicitly specified local adapter manifest or pipeline |
| `labDir` / `rawDir` / `projectRoot` | study root | Base for relative paths |
| `autoRun` | `false` | Debounced automatic runs; off by default |
| `debounceMs` / `autoPollMs` | `3000` / `2000` | Debounce and polling intervals for automatic runs |

The analysis section of the study definition:

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

## Data and privacy

- No network access: analysis, plotting and export are all done locally, with no cloud rendering.
- No names or contact details are stored: participants are arbitrary non-empty string identifiers, groups are a separate column, and reports only contain identifiers.
- Unsupported or ambiguous options are explicitly rejected before the run, rather than quietly fitting an approximate model to produce a result.
- The run directory contains an input data snapshot; treat it at the sensitivity level of research data, and prefer sharing an HTML/PDF report over the whole run directory.

## Known limitations

- Only the normal distribution is supported (`distribution` is gaussian); other distributions raise an error rather than switching to an approximate model.
- Random slopes are not implemented yet (`randomSlopes` is rejected), and mixed models only have the declared random intercepts.
- Regression requires a wide table of independent observations; repeated measures must go through `mixed`.
- ANOVA supports at most two factors; interaction terms are only supported between two categorical group columns.
- The paired test is a pooled unadjusted change; configured groups and covariates do not enter this test.
- Mediation uses bootstrap, so results depend on the number of resamples and the seed; a different seed produces decimal-level differences.
- PDF needs a local Chrome/Edge (`DSH_CHROME` can point at one); without it only HTML/SVG are available.
- Word/Excel export needs python-docx and openpyxl in the runtime; when missing, the failure reason is recorded in the export.
- The bundled backend wheels are currently `cp312` / `win_amd64`; other platforms or interpreters need their own wheels added.
- There is no `acceptance/` directory and no `test` script in the repository; the acceptance scripts referenced by earlier READMEs are not in the current repository.

## License

MIT, see `LICENSE` in the repository root (Copyright © 2026 Yuhui YANG). The license covers plugin code only, not research data: participant information, questionnaire responses, study definitions and data derived from them remain the property of the research party and are not licensed under it. The bundled scipy / statsmodels / numpy / pandas are BSD-licensed; redistributing them with the plugin only requires keeping the LICENSE inside each wheel.
