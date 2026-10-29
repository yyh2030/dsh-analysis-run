# -*- coding: utf-8 -*-
"""暂行数据分析方案（SAP 15.1 / 15.3 / 15.4 / 15.5）的落地。

这里只做「方案里写了、数据现在能支持」的那部分；跑不了的（比如 STAI-T 还没采集）
在结果里留一条明确的 not_run 说明，而不是悄悄跳过。
"""

from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

SAP_VERSION = "sap/1.0.0"

# 非系统折扣的判定口径（Johnson & Bickel, 2008 的 20% 规则 + 两端极端反应）
NONSYSTEMATIC_RULE = "任一延迟的 IP 比前一个延迟高出该档延迟金额的 20% 以上，或 10 个 IP 全等于延迟金额/全为 0"

VALUE_LABELS = {
    "AUC_T0": "AUC（T0）",
    "AUC_T1": "AUC（T1）",
    "AUC_T2": "AUC（T2）",
    "lnk_T0": "ln(k)（T0）",
    "lnk_T2": "ln(k)（T2）",
    "FTPS_T0": "FTPS（T0）",
    "FTPS_T1": "FTPS（T1）",
    "FTPS_T2": "FTPS（T2）",
    "STAI_S_T0": "STAI-S（T0）",
    "STAI_S_T2": "STAI-S（T2）",
    "age": "年龄",
    "eduYears": "受教育年限",
}


def _fmt(value, digits=3):
    if value is None:
        return ""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return value
    if np.isnan(value):
        return ""
    return round(value, digits)


def _p(value, digits=3):
    value = _fmt(value, digits)
    if value == "":
        return ""
    return "<0.001" if float(value) == 0 else value


def cronbach_alpha(frame: pd.DataFrame) -> float:
    """α = k/(k-1) · (1 − Σσ²ᵢ/σ²总)；缺失按可用项对删。"""
    items = frame.dropna(axis=1, how="any")
    if items.shape[1] < 2:
        items = frame
    k = items.shape[1]
    if k < 2 or len(items) < 2:
        return float("nan")
    variance = items.var(axis=0, ddof=1)
    total = items.sum(axis=1).var(ddof=1)
    if total == 0:
        return float("nan")
    return float(k / (k - 1) * (1 - variance.sum() / total))


def load_answers(lab_dir: str, scale: str, wave: str) -> pd.DataFrame | None:
    path = os.path.join(lab_dir, "scales", "answers", f"{scale}__{wave}.csv")
    if not os.path.exists(path):
        return None
    frame = pd.read_csv(path, encoding="utf-8-sig", dtype=str)
    rename = {frame.columns[0]: "subjectid"}
    frame = frame.rename(columns=rename)
    frame["subjectid"] = frame["subjectid"].astype(str).str.zfill(5)
    for column in frame.columns[1:]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame


def load_points(cache_dir: str) -> pd.DataFrame | None:
    path = os.path.join(cache_dir, "indifference_points.csv")
    if not os.path.exists(path):
        return None
    return pd.read_csv(path, encoding="utf-8-sig", dtype={"subjectid": str, "session": str})


# --------------------------------------------------------------------------- #
# 15.1 预备分析
# --------------------------------------------------------------------------- #


def missing_table(dataset: pd.DataFrame, trials: pd.DataFrame | None, lab_dir: str) -> pd.DataFrame:
    variables = [column for column in VALUE_LABELS if column in dataset.columns]
    rows = []
    for column in variables:
        series = dataset[column]
        rows.append({
            "变量": VALUE_LABELS[column],
            "应有人数": int(len(dataset)),
            "有效人数": int(series.notna().sum()),
            "缺失": int(series.isna().sum()),
            "缺失率%": round(100 * series.isna().mean(), 1),
        })
    # DDT 三次 session 完成情况
    if trials is not None and len(trials):
        sessions = trials.groupby("subjectid")["session"].nunique()
        full = int((sessions == 3).sum())
        rows.append({"变量": "DDT 三次 session 齐全", "应有人数": int(len(dataset)), "有效人数": full,
                     "缺失": int(len(dataset)) - full, "缺失率%": round(100 * (len(dataset) - full) / len(dataset), 1)})
        rows.append({"变量": "DDT 每 session 60 试次", "应有人数": int(len(dataset) * 3),
                     "有效人数": int(trials.groupby(["subjectid", "session"]).size().eq(60).sum()),
                     "缺失": int(len(dataset) * 3 - trials.groupby(["subjectid", "session"]).size().eq(60).sum()),
                     "缺失率%": ""})
    # 量表完成
    for scale, waves, label in (("FTPS", ["T0", "T1", "T2"], "FTPS"), ("STAI_S", ["T0", "T2"], "STAI-S")):
        for wave in waves:
            answers = load_answers(lab_dir, scale, wave)
            if answers is None:
                continue
            answered = answers.drop(columns=["subjectid"]).notna().sum(axis=1)
            rows.append({
                "变量": f"{label}（{wave}）作答完整",
                "应有人数": int(len(dataset)),
                "有效人数": int((answered >= answers.shape[1] - 1).sum()),
                "缺失": int((answered < answers.shape[1] - 1).sum()),
                "缺失率%": round(100 * (answered < answers.shape[1] - 1).mean(), 1),
            })
    return pd.DataFrame(rows)


def completion_table(trials: pd.DataFrame | None, dataset: pd.DataFrame) -> pd.DataFrame:
    """任务完成率与超时情况（按被试）。"""
    rows = []
    if trials is None or not len(trials):
        return pd.DataFrame([{"检查项": "逐试次数据", "值": "缺失"}])
    grouped = trials.groupby(["subjectid", "session"])
    per = pd.DataFrame({
        "n_trials": grouped.size(),
        "timeouts": grouped["n_timeouts"].sum(),
    }).reset_index()
    per["complete"] = per["n_trials"] == 60
    summary = per.groupby("subjectid").agg(
        sessions=("session", "nunique"),
        trials=("n_trials", "sum"),
        timeouts=("timeouts", "sum"),
        all_complete=("complete", "all"),
    ).reset_index()
    return pd.DataFrame([
        {"检查项": "完成 3 次 DDT 的被试", "值": int((summary["sessions"] == 3).sum()), "说明": f"共 {len(summary)} 人"},
        {"检查项": "三次 session 均 60 试次", "值": int(summary["all_complete"].sum()), "说明": "任一 session 不足 60 即算不完整"},
        {"检查项": "总试次", "值": int(summary["trials"].sum()), "说明": "应为 人数 × 180"},
        {"检查项": "超时重做总次数", "值": int(summary["timeouts"].sum()), "说明": "4 s 限时后才出现"},
        {"检查项": "超时被试数", "值": int((summary["timeouts"] > 0).sum()), "说明": "至少超时一次"},
        {"检查项": "进入分析人数", "值": int(dataset["included"].sum()), "说明": "T0+T2 都有且未排除"},
    ])


def distribution_table(dataset: pd.DataFrame) -> pd.DataFrame:
    from scipy import stats

    data = dataset[dataset["included"]]
    rows = []
    for column, label in VALUE_LABELS.items():
        if column not in data.columns or column in ("age", "eduYears"):
            continue
        series = data[column].dropna().astype(float)
        if len(series) < 3:
            continue
        stat, p_value = stats.shapiro(series)
        rows.append({
            "变量": label,
            "n": int(len(series)),
            "M": _fmt(series.mean()),
            "SD": _fmt(series.std(ddof=1)),
            "中位数": _fmt(series.median()),
            "偏度": _fmt(stats.skew(series, bias=False), 2),
            "峰度": _fmt(stats.kurtosis(series, bias=False), 2),
            "Shapiro W": _fmt(stat),
            "Shapiro p": _p(p_value),
            "最小": _fmt(series.min()),
            "最大": _fmt(series.max()),
        })
    return pd.DataFrame(rows)


def load_scale_def(lab_dir: str, scale: str) -> dict:
    path = os.path.join(lab_dir, "scales", "defs", f"{scale}.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def score_items(items: pd.DataFrame, definition: dict) -> pd.DataFrame:
    """按定义反向计分（min + max − 原始分）；题目文本不入库，这里只看题号。"""
    minimum = float(definition.get("response", {}).get("min", 1))
    maximum = float(definition.get("response", {}).get("max", 7))
    scored = items.copy()
    for item in definition.get("items", []):
        if not item.get("reverse"):
            continue
        column = f"q{int(item['no']):02d}"
        if column in scored.columns:
            scored[column] = (minimum + maximum) - scored[column]
    return scored


def reliability_table(lab_dir: str) -> pd.DataFrame:
    definition = load_scale_def(lab_dir, "FTPS")
    rows = []
    for wave in ("T0", "T1", "T2"):
        answers = load_answers(lab_dir, "FTPS", wave)
        if answers is None:
            continue
        items = score_items(answers.drop(columns=["subjectid"]), definition)
        alpha = cronbach_alpha(items)
        total = items.mean(axis=1)
        item_total = items.corrwith(total)
        rows.append({
            "量表": "FTPS",
            "波次": wave,
            "人数": int(items.dropna(how="all").shape[0]),
            "题量": int(items.shape[1]),
            "Cronbach α": _fmt(alpha),
            "项总相关范围": f"{_fmt(item_total.min(), 2)}–{_fmt(item_total.max(), 2)}",
            "平均项间相关": _fmt(items.corr().values[np.triu_indices(items.shape[1], 1)].mean(), 2),
        })
    return pd.DataFrame(rows)


def balance_table(dataset: pd.DataFrame) -> pd.DataFrame:
    from scipy import stats

    data = dataset[dataset["included"]]
    variables = [("AUC_T0", "T0 AUC", "anova"), ("FTPS_T0", "FTPS（T0）", "anova"),
                 ("STAI_S_T0", "STAI-S（T0）", "anova"), ("age", "年龄", "anova"),
                 ("eduYears", "受教育年限", "anova")]
    rows = []
    for column, label, _kind in variables:
        if column not in data.columns:
            continue
        groups = [group[column].dropna().values for _cell, group in data.groupby("cell", sort=True)]
        groups = [group for group in groups if len(group) > 0]
        if len(groups) < 2:
            continue
        if all(len(group) > 1 for group in groups):
            f_stat, p_value = stats.f_oneway(*groups)
            test = f"F({len(groups) - 1}, {len(data) - len(groups)}) = {_fmt(f_stat)}"
            p_text = _p(p_value)
        else:
            h_stat, p_value = stats.kruskal(*groups)
            test = f"Kruskal H = {_fmt(h_stat)}"
            p_text = _p(p_value)
        row = {"变量": label}
        for cell in sorted(data["cell"].unique()):
            series = data.loc[data["cell"] == cell, column].dropna()
            row[cell] = f"{_fmt(series.mean())} ({_fmt(series.std(ddof=1))})"
        row["检验"] = test
        row["p"] = p_text
        rows.append(row)
    # 性别比例
    if "sex" in data.columns:
        row = {"变量": "女性比例"}
        for cell in sorted(data["cell"].unique()):
            series = data.loc[data["cell"] == cell, "sex"].dropna()
            row[cell] = f"{int((series == '女').sum())}/{len(series)}"
        table = pd.crosstab(data["cell"], data["sex"])
        if table.shape[1] > 1 and table.shape[0] > 1:
            chi2, p_value, _dof, _expected = stats.chi2_contingency(table)
            row["检验"] = f"χ²({int((table.shape[0] - 1) * (table.shape[1] - 1))}) = {_fmt(chi2)}"
            row["p"] = _p(p_value)
        rows.append(row)
    return pd.DataFrame(rows)


def nonsystematic_table(points: pd.DataFrame | None, dataset: pd.DataFrame) -> tuple[pd.DataFrame, list[str], dict]:
    """按 20% 规则逐被试×session 判定非系统折扣。

    分级：一次违规记「轻微」，两次及以上或两端极端反应记「明确」。
    per-protocol 只排除 T0 或 T2 出现「明确」的被试——一次小幅反转在 6 次调整的
    阶梯里很常见，按「有违规就排除」会筛掉一大半（本次 18 人里有 11 人）。
    """
    if points is None or not len(points):
        return pd.DataFrame(), [], {"rule": NONSYSTEMATIC_RULE, "flagged": 0}

    rows = []
    flagged_subjects = set()
    strict_subjects = set()
    minor_subjects = set()
    for (subject, session), group in points.groupby(["subjectid", "session"], sort=True):
        wave = {"001": "T0", "002": "T1", "003": "T2"}.get(str(session).zfill(3), session)
        violations = 0
        flat_high = flat_low = 0
        for amount_ll, tier in group.groupby("amountLL"):
            tier = tier.sort_values("delayLL").dropna(subset=["IP"])
            values = tier["IP"].astype(float).tolist()
            if len(values) < 2:
                continue
            for previous, current in zip(values, values[1:]):
                if current > previous + 0.2 * float(amount_ll):
                    violations += 1
            if all(abs(value - float(amount_ll)) < 0.01 for value in values):
                flat_high += 1
            if all(abs(value) < 0.01 for value in values):
                flat_low += 1
        extreme = flat_high == 2 or flat_low == 2
        severity = "明确" if (violations >= 2 or extreme) else ("轻微" if violations == 1 else "")
        if severity == "明确":
            flagged_subjects.add(subject)
            if wave in ("T0", "T2"):
                strict_subjects.add(subject)
        elif severity == "轻微":
            minor_subjects.add(subject)
        rows.append({
            "被试": subject,
            "时间点": wave,
            "单调性违规": violations,
            "两档全不折扣": flat_high,
            "两档全折扣": flat_low,
            "标记": severity,
        })
    table = pd.DataFrame(rows)
    meta = {
        "rule": NONSYSTEMATIC_RULE,
        "subjects": int(table["被试"].nunique()),
        "sessions_flagged": int((table["标记"] == "明确").sum()),
        "flagged": len(flagged_subjects),
        "flaggedIds": sorted(flagged_subjects),
        "flaggedStrict": len(strict_subjects),
        "flaggedStrictIds": sorted(strict_subjects),
        "minor": len(minor_subjects - flagged_subjects),
        "ppRule": "T0 或 T2 出现「明确」才排除（严格）；任一波次汇总的旧口径并列保留",
    }
    return table, sorted(flagged_subjects), meta


def dta_prepilot(project_root: str) -> tuple[pd.DataFrame, dict]:
    """外部预实验 DTA 材料验证：直接引用预实验输出（不参与主实验判定）。"""
    base = os.path.join(project_root, "04_预实验数据与分析", "analysis_output")
    tests_path = os.path.join(base, "table_dta_tests.csv")
    flow_path = os.path.join(base, "table_sample_flow.csv")
    if not os.path.exists(tests_path):
        return pd.DataFrame(), {"available": False}
    table = pd.read_csv(tests_path, encoding="utf-8-sig")
    rows = []
    for _index, row in table.iterrows():
        rows.append({
            "样本": row.get("样本", ""),
            "MS 均值": _fmt(row.get("MS_mean")),
            "牙痛 均值": _fmt(row.get("牙痛_mean")),
            "差值": _fmt(row.get("差值_MS−牙痛")),
            "Hedges g": _fmt(row.get("Hedges_g")),
            "g 的 95%CI": row.get("g_CI95", ""),
            "Welch p": _fmt(row.get("Welch_p")),
            "置换 p": _fmt(row.get("置换p_双侧")),
            "Mann-Whitney p": _fmt(row.get("MW_p_双侧")),
        })
    summary = {"available": True, "nMain": None, "g": None, "p": None}
    primary = table[table["样本"].astype(str).str.startswith("primary")]
    if len(primary):
        row = primary.iloc[0]
        summary.update({"g": _fmt(row.get("Hedges_g")), "p": _fmt(row.get("Welch_p")),
                        "delta": _fmt(row.get("差值_MS−牙痛"))})
    if os.path.exists(flow_path):
        flow = pd.read_csv(flow_path, encoding="utf-8-sig")
        summary["flow"] = flow.to_dict(orient="records")
    return pd.DataFrame(rows), summary


def stai_change(dataset: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    from scipy import stats

    data = dataset[dataset["included"]].dropna(subset=["STAI_S_T0", "STAI_S_T2"])
    if len(data) < 3:
        return pd.DataFrame(), {"available": False}
    diff = (data["STAI_S_T2"] - data["STAI_S_T0"]).astype(float)
    t_stat, p_value = stats.ttest_rel(data["STAI_S_T2"], data["STAI_S_T0"])
    dz = float(diff.mean() / diff.std(ddof=1)) if diff.std(ddof=1) else float("nan")
    ci = stats.t.interval(0.95, len(diff) - 1, loc=diff.mean(), scale=stats.sem(diff))
    delta_auc = (data["AUC_T2"] - data["AUC_T0"]).astype(float)
    rho, rho_p = stats.spearmanr(diff, delta_auc)
    table = pd.DataFrame([{
        "指标": "STAI-S T2 − T0",
        "n": int(len(diff)),
        "M 变化": _fmt(diff.mean()),
        "SD 变化": _fmt(diff.std(ddof=1)),
        "t(df)": f"{_fmt(t_stat)}（{len(diff) - 1}）",
        "p": _p(p_value),
        "Cohen dz": _fmt(dz, 2),
        "95%CI": f"[{_fmt(ci[0])}, {_fmt(ci[1])}]",
        "与 ΔAUC 的 ρ": _fmt(rho, 2),
        "ρ 的 p": _p(rho_p),
    }])
    return table, {"available": True, "dz": _fmt(dz, 2), "p": _fmt(p_value), "rho": _fmt(rho, 2)}


# --------------------------------------------------------------------------- #
# 15.3 未来时间洞察力与中介
# --------------------------------------------------------------------------- #


def ftps_lmm(dataset: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """FTPS 在 T0/T1/T2 的线性混合模型（随机截距）。"""
    data = dataset[dataset["included"]]
    long = data.melt(id_vars=["subjectid", "salience", "intervention"],
                     value_vars=["FTPS_T0", "FTPS_T1", "FTPS_T2"],
                     var_name="wave", value_name="FTPS").dropna(subset=["FTPS"])
    long["wave"] = long["wave"].str.replace("FTPS_", "", regex=False)
    long["time"] = pd.Categorical(long["wave"], categories=["T0", "T1", "T2"], ordered=True)
    if len(long) < 12:
        return pd.DataFrame(), {"available": False, "reason": "FTPS 数据不足"}
    import statsmodels.formula.api as smf
    from scipy import stats

    full_formula = "FTPS ~ C(time, Treatment('T0')) * C(intervention) + C(time, Treatment('T0')) * C(salience)"
    reduced_formula = "FTPS ~ C(time, Treatment('T0')) + C(intervention) + C(salience)"
    try:
        full = smf.mixedlm(full_formula, long, groups=long["subjectid"]).fit(reml=False)
        reduced = smf.mixedlm(reduced_formula, long, groups=long["subjectid"]).fit(reml=False)
    except Exception as error:  # noqa: BLE001
        return pd.DataFrame(), {"available": False, "reason": f"LMM 拟合失败：{error}"}

    lr = 2 * (full.llf - reduced.llf)
    df_diff = len(full.fe_params) - len(reduced.fe_params)
    p_value = float(stats.chi2.sf(lr, max(df_diff, 1)))
    labels = {
        "Intercept": "截距",
        "C(time, Treatment('T0'))[T.T1]": "T1（相对 T0）",
        "C(time, Treatment('T0'))[T.T2]": "T2（相对 T0）",
        "C(intervention)[T.ERT]": "干预：ERT（相对 EFT）",
        "C(salience)[T.MS]": "突显：MS（相对 DP）",
        "C(time, Treatment('T0'))[T.T1]:C(intervention)[T.ERT]": "T1 × 干预",
        "C(time, Treatment('T0'))[T.T2]:C(intervention)[T.ERT]": "T2 × 干预",
        "C(time, Treatment('T0'))[T.T1]:C(salience)[T.MS]": "T1 × 突显",
        "C(time, Treatment('T0'))[T.T2]:C(salience)[T.MS]": "T2 × 突显",
        "Group Var": "被试随机截距方差",
    }
    rows = []
    for name, value, se, p in zip(full.params.index, full.params.values, full.bse.values, full.pvalues.values):
        rows.append({"项": labels.get(name, name), "估计": _fmt(value), "SE": _fmt(se), "p": _p(p)})
    table = pd.DataFrame(rows)
    meta = {
        "available": True,
        "n": int(long["subjectid"].nunique()),
        "obs": int(len(long)),
        "lrtTimeInteraction": {"chi2": _fmt(lr), "df": int(df_diff), "p": _fmt(p_value)},
        "meanByWave": long.groupby(["wave", "intervention"])["FTPS"].mean().round(3).unstack().to_dict(),
    }
    return table, meta


def mediation(dataset: pd.DataFrame, n_boot: int = 5000, seed: int = 20261029) -> tuple[pd.DataFrame, dict]:
    """EEP/ERT → ΔFTPS(T1→T2) → AUC_T2（控制 T0 AUC）的探索性 bootstrap 中介。"""
    import statsmodels.formula.api as smf

    data = dataset[dataset["included"]].dropna(subset=["AUC_T0", "AUC_T2", "FTPS_T1", "FTPS_T2"])
    if len(data) < 8 or data["intervention"].nunique() < 2:
        return pd.DataFrame(), {"available": False, "reason": "样本或分组不足"}
    data = data.copy()
    data["delta"] = data["FTPS_T2"] - data["FTPS_T1"]

    def design(frame):
        x = (frame["intervention"] == "EFT").astype(float).to_numpy()
        delta = frame["delta"].to_numpy(dtype=float)
        auc0 = frame["AUC_T0"].to_numpy(dtype=float)
        auc2 = frame["AUC_T2"].to_numpy(dtype=float)
        ones = np.ones(len(frame))
        return x, delta, auc0, auc2, ones

    def fast_paths(frame):
        x, delta, auc0, auc2, ones = design(frame)
        a = np.linalg.lstsq(np.column_stack([ones, x]), delta, rcond=None)[0][1]
        b = np.linalg.lstsq(np.column_stack([ones, delta, x, auc0]), auc2, rcond=None)[0][1]
        total = np.linalg.lstsq(np.column_stack([ones, x, auc0]), auc2, rcond=None)[0][1]
        return float(a), float(b), float(a * b), float(total)

    a, b, indirect, total = fast_paths(data)
    b_model = smf.ols("AUC_T2 ~ delta + C(intervention, Treatment('ERT')) + AUC_T0", data=data).fit()
    a_model = smf.ols("delta ~ C(intervention, Treatment('ERT'))", data=data).fit()
    b_ci = b_model.conf_int().loc["delta"].tolist() if "delta" in b_model.params else [np.nan, np.nan]

    rng = np.random.RandomState(seed)
    boot = []
    for _ in range(n_boot):
        index = rng.randint(0, len(data), len(data))
        sample = data.iloc[index]
        if sample["intervention"].nunique() < 2:
            continue
        boot_a, boot_b, _boot_ind, _boot_total = fast_paths(sample)
        boot.append(boot_a * boot_b)
    boot = np.array(boot)
    ci_low, ci_high = (np.percentile(boot, [2.5, 97.5]) if len(boot) > 100 else (np.nan, np.nan))

    table = pd.DataFrame([
        {"路径": "a：干预 → ΔFTPS（T1→T2）", "估计": _fmt(a),
         "p": _p(a_model.pvalues.get("C(intervention, Treatment('ERT'))[T.EFT]")), "95%CI": ""},
        {"路径": "b：ΔFTPS → AUC_T2（控制 T0 AUC 与干预）", "估计": _fmt(b),
         "p": _p(b_model.pvalues.get("delta")), "95%CI": f"[{_fmt(b_ci[0])}, {_fmt(b_ci[1])}]"},
        {"路径": "间接效应 a×b", "估计": _fmt(indirect), "p": "",
         "95%CI": f"[{_fmt(ci_low)}, {_fmt(ci_high)}]"},
        {"路径": "总效应 c：干预 → AUC_T2", "估计": _fmt(total), "p": "", "95%CI": ""},
        {"路径": "中介比例（|a×b/c|）", "估计": _fmt(abs(indirect / total) if total else np.nan, 2), "p": "", "95%CI": ""},
    ])
    meta = {
        "available": True,
        "n": int(len(data)),
        "boot": int(len(boot)),
        "a": _fmt(a),
        "b": _fmt(b),
        "indirect": _fmt(indirect),
        "total": _fmt(total),
        "indirectCI": [_fmt(ci_low), _fmt(ci_high)],
        "note": "EFT/ERT 为被试间操纵，ΔFTPS 不是独立操纵的变量，不能当作因果中介解读",
    }
    return table, meta


# --------------------------------------------------------------------------- #
# 15.4 特质焦虑
# --------------------------------------------------------------------------- #


def trait_anxiety(dataset: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """STAI-T 还没采集：留 not_run，同时给出 STAI-S 的探索性替代分析。"""
    import statsmodels.formula.api as smf

    data = dataset[dataset["included"]].dropna(subset=["STAI_S_T0"])
    rows = [{
        "分析": "预注册：STAI-T 调节未来时间洞察力变化（T0→T1）与干预效应",
        "状态": "未执行",
        "说明": "数据里没有 STAI-T（特质焦虑）量表；STAI-S 是状态焦虑，不能代替。等采集后再跑。",
    }]
    meta = {"preregistered": {"available": False, "reason": "没有 STAI-T 数据"}}
    if len(data) < 8:
        return pd.DataFrame(rows), meta

    data = data.copy()
    data["delta_ftps_01"] = data["FTPS_T1"] - data["FTPS_T0"]
    try:
        a_model = smf.ols("delta_ftps_01 ~ STAI_S_T0 + FTPS_T0", data=data).fit()
        rows.append({
            "分析": "替代（探索）：STAI-S(T0) → FTPS 变化（T0→T1）",
            "状态": "已跑",
            "说明": f"β = {_fmt(a_model.params.get('STAI_S_T0'))}，p = {_p(a_model.pvalues.get('STAI_S_T0'))}，n = {int(a_model.nobs)}",
        })
        b_model = smf.ols("AUC_T2 ~ AUC_T0 + C(intervention) + STAI_S_T0 + C(intervention):STAI_S_T0", data=data).fit()
        term = "C(intervention)[T.ERT]:STAI_S_T0"
        estimate = b_model.params.get(term, np.nan)
        rows.append({
            "分析": "替代（探索）：STAI-S(T0) 调节干预对 AUC_T2 的效应",
            "状态": "已跑",
            "说明": f"交互 β = {_fmt(estimate)}，p = {_p(b_model.pvalues.get(term))}，n = {int(b_model.nobs)}；"
                    f"这个模型只有 {int(b_model.df_resid)} 个残差自由度，只能当管道演示",
        })
        meta["substitute"] = {
            "available": True,
            "deltaFtpsBeta": _fmt(a_model.params.get("STAI_S_T0")),
            "deltaFtpsP": _p(a_model.pvalues.get("STAI_S_T0")),
            "moderationBeta": _fmt(estimate),
            "moderationP": _p(b_model.pvalues.get(term)),
            "dfResid": int(b_model.df_resid),
        }
    except Exception as error:  # noqa: BLE001
        meta["substitute"] = {"available": False, "reason": str(error)}
    return pd.DataFrame(rows), meta


# --------------------------------------------------------------------------- #
# 15.5 缺失数据与敏感性
# --------------------------------------------------------------------------- #


def pp_sensitivity(dataset: pd.DataFrame, flagged: list[str]) -> tuple[pd.DataFrame, dict]:
    import statsmodels.formula.api as smf
    from statsmodels.stats.anova import anova_lm

    def fit(frame):
        model = smf.ols("AUC_T2 ~ C(salience, Sum) * C(intervention, Sum) + AUC_T0", data=frame).fit()
        table = anova_lm(model, typ=3)
        term = "C(salience, Sum):C(intervention, Sum)"
        return {
            "n": int(model.nobs),
            "df_resid": int(model.df_resid),
            "F": _fmt(table.loc[term, "F"]),
            "p": _fmt(table.loc[term, "PR(>F)"]),
            "r2": _fmt(model.rsquared),
        }, model

    data = dataset[dataset["included"]].dropna(subset=["AUC_T0", "AUC_T2"])
    rows = []
    main, _model = fit(data)
    rows.append({"分析集": "ITT（全部进入分析的人）", **main})
    per_protocol = data[~data["subjectid"].isin(flagged)]
    if len(per_protocol) >= 8:
        pp, _pp_model = fit(per_protocol)
        rows.append({"分析集": f"PP（排除非系统折扣 {len(flagged)} 人）", **pp})
    else:
        rows.append({"分析集": "PP（排除非系统折扣）", "n": int(len(per_protocol)), "df_resid": "",
                     "F": "", "p": "", "r2": "", "note": "剩余人数不足，无法拟合"})
    return pd.DataFrame(rows), {"flagged": flagged, "rule": NONSYSTEMATIC_RULE}


def make_figures(run_dir: str, dataset: pd.DataFrame, sap_result: dict) -> list[str]:
    """SAP 用图：FTPS 轨迹、ΔFTPS–AUC 散点、中介示意图。"""
    paths = []
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        matplotlib.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
        matplotlib.rcParams["axes.unicode_minus"] = False
    except Exception:  # noqa: BLE001
        return paths

    data = dataset[dataset["included"]]
    colors = {"MS": "#C0504D", "DP": "#4F81BD"}
    styles = {"EFT": "-", "ERT": "--"}
    try:
        figure, axis = plt.subplots(figsize=(5.6, 3.8))
        for cell, group in data.groupby("cell", sort=True):
            means, errors = [], []
            for wave in ("FTPS_T0", "FTPS_T1", "FTPS_T2"):
                series = group[wave].dropna()
                means.append(series.mean() if len(series) else np.nan)
                errors.append(series.std(ddof=1) / np.sqrt(len(series)) if len(series) > 1 else 0)
            salience, intervention = cell.split("×")
            axis.errorbar(["T0", "T1", "T2"], means, yerr=errors, marker="o", lw=2, ms=6, capsize=3,
                          color=colors.get(salience, "#888"), linestyle=styles.get(intervention, "-"),
                          label=f"{cell} (n={len(group)})")
        axis.set_ylabel("FTPS (mean ± SE)")
        axis.set_xlabel("Time point")
        axis.legend(frameon=False, fontsize=8)
        axis.spines[["top", "right"]].set_visible(False)
        figure.tight_layout()
        path = os.path.join(run_dir, "fig_ftps_trajectory.png")
        figure.savefig(path, dpi=200)
        plt.close(figure)
        paths.append(path)
    except Exception:  # noqa: BLE001
        pass

    try:
        scatter = data.dropna(subset=["FTPS_T1", "FTPS_T2", "AUC_T2"])
        if len(scatter) >= 5:
            figure, axis = plt.subplots(figsize=(5.2, 3.8))
            delta = scatter["FTPS_T2"] - scatter["FTPS_T1"]
            for intervention, group in scatter.groupby("intervention"):
                index = group.index
                axis.scatter(delta.loc[index], group["AUC_T2"], s=34, alpha=0.85,
                             color="#4F81BD" if intervention == "EFT" else "#C0504D", label=intervention)
            coefficients = np.polyfit(delta, scatter["AUC_T2"], 1)
            grid = np.linspace(delta.min(), delta.max(), 20)
            axis.plot(grid, np.polyval(coefficients, grid), color="#333", lw=1.2, ls=":")
            axis.set_xlabel("ΔFTPS (T1 → T2)")
            axis.set_ylabel("AUC at T2")
            axis.legend(frameon=False, fontsize=8, title="Intervention")
            axis.spines[["top", "right"]].set_visible(False)
            figure.tight_layout()
            path = os.path.join(run_dir, "fig_delta_ftps_auc.png")
            figure.savefig(path, dpi=200)
            plt.close(figure)
            paths.append(path)
    except Exception:  # noqa: BLE001
        pass

    try:
        mediation = (sap_result.get("secondary") or {}).get("mediation") or {}
        if mediation.get("available"):
            figure, axis = plt.subplots(figsize=(5.8, 2.6))
            axis.set_axis_off()
            boxes = {"X": (0.06, 0.55), "M": (0.42, 0.78), "Y": (0.78, 0.55)}
            labels = {"X": "干预\n(EFT vs ERT)", "M": "ΔFTPS\n(T1→T2)", "Y": "AUC_T2"}
            for key, (x, y) in boxes.items():
                axis.add_patch(plt.Rectangle((x, y), 0.16, 0.2, fill=False, ec="#333", lw=1.2))
                axis.text(x + 0.08, y + 0.1, labels[key], ha="center", va="center", fontsize=9)
            axis.annotate("", xy=(0.42, 0.75), xytext=(0.22, 0.65), arrowprops={"arrowstyle": "->", "color": "#333"})
            axis.text(0.30, 0.74, f"a = {mediation.get('a', '—')}", fontsize=9)
            axis.annotate("", xy=(0.78, 0.65), xytext=(0.58, 0.78), arrowprops={"arrowstyle": "->", "color": "#333"})
            axis.text(0.66, 0.79, f"b = {mediation.get('b', '—')}", fontsize=9)
            axis.annotate("", xy=(0.78, 0.60), xytext=(0.22, 0.60), arrowprops={"arrowstyle": "->", "color": "#888", "ls": ":"})
            axis.text(0.46, 0.50, f"总效应 c = {mediation.get('total', '—')}", fontsize=8, color="#666")
            axis.text(0.46, 0.24, f"间接 a×b = {mediation.get('indirect', '—')} "
                                  f"[{', '.join(str(v) for v in mediation.get('indirectCI', []))}]",
                      fontsize=9, ha="center")
            axis.set_xlim(0, 1)
            axis.set_ylim(0.1, 1.05)
            figure.tight_layout()
            path = os.path.join(run_dir, "fig_mediation.png")
            figure.savefig(path, dpi=200)
            plt.close(figure)
            paths.append(path)
    except Exception:  # noqa: BLE001
        pass

    return paths


# --------------------------------------------------------------------------- #
# 编排
# --------------------------------------------------------------------------- #


def run_sap(ctx: dict, dataset: pd.DataFrame, trials: pd.DataFrame | None) -> dict:
    """跑 15.1 / 15.3 / 15.4 / 15.5，把表与 JSON 一起交回去。

    每张表算完就落盘；某一步失败只记 warning，不拖垮其它步骤。
    """
    lab_dir = ctx["labDir"]
    cache_dir = ctx["cacheDir"]
    points = load_points(cache_dir)
    tables_dir = os.path.join(ctx["runDir"], "tables")
    os.makedirs(tables_dir, exist_ok=True)

    result = {"version": SAP_VERSION, "tables": {}, "notes": [], "warnings": []}

    def put(key: str, frame: pd.DataFrame | None):
        if frame is None or not len(frame):
            return
        result["tables"][key] = frame.to_dict(orient="records")
        frame.to_csv(os.path.join(tables_dir, f"{key}.csv"), index=False, encoding="utf-8-sig")

    def step_table(label: str, fn):
        try:
            frame = fn()
            return frame if frame is not None else pd.DataFrame()
        except Exception as error:  # noqa: BLE001 - 单个分析失败不该中断整份报告
            result["warnings"].append(f"{label}失败：{error}")
            return pd.DataFrame()

    def step_pair(label: str, fn):
        try:
            return fn()
        except Exception as error:  # noqa: BLE001
            result["warnings"].append(f"{label}失败：{error}")
            return (pd.DataFrame(), {"available": False, "reason": str(error)})

    missing = step_table("缺失表", lambda: missing_table(dataset, trials, lab_dir))
    put("table9_missing", missing)

    completion = step_table("完成率表", lambda: completion_table(trials, dataset))
    put("table10_completion", completion)

    distribution = step_table("分布表", lambda: distribution_table(dataset))
    put("table11_distribution", distribution)

    reliability = step_table("信度表", lambda: reliability_table(lab_dir))
    put("table12_reliability", reliability)

    balance = step_table("基线平衡表", lambda: balance_table(dataset))
    put("table13_balance", balance)

    flagged: list[str] = []
    nonsystematic_meta = {"rule": NONSYSTEMATIC_RULE, "flagged": 0}
    try:
        nonsystematic, flagged, nonsystematic_meta = nonsystematic_table(points, dataset)
        put("table14_nonsystematic", nonsystematic)
    except Exception as error:  # noqa: BLE001
        result["warnings"].append(f"非系统折扣检查失败：{error}")

    dta_table, dta_meta = step_pair("预实验 DTA 表", lambda: dta_prepilot(ctx["projectRoot"]))
    put("table15_prepilot", dta_table)

    stai_table, stai_meta = step_pair("STAI 变化表", lambda: stai_change(dataset))
    put("table16_stai_change", stai_table)

    result["preliminary"] = {
        "missing": missing.to_dict(orient="records"),
        "completion": completion.to_dict(orient="records"),
        "distribution": distribution.to_dict(orient="records"),
        "reliability": reliability.to_dict(orient="records"),
        "balance": balance.to_dict(orient="records"),
        "nonsystematic": nonsystematic_meta,
        "prepilot": dta_meta,
        "stai": stai_meta,
    }

    lmm_table, lmm_meta = step_pair("FTPS 混合模型", lambda: ftps_lmm(dataset))
    put("table17_ftps_lmm", lmm_table)

    mediation_table, mediation_meta = step_pair("中介分析", lambda: mediation(dataset))
    put("table18_mediation", mediation_table)

    trait_table, trait_meta = step_pair("特质焦虑", lambda: trait_anxiety(dataset))
    put("table19_trait_anxiety", trait_table)

    pp_table, pp_meta = step_pair("敏感性分析", lambda: pp_sensitivity(
        dataset, nonsystematic_meta.get("flaggedStrictIds") or flagged))
    put("table20_sensitivity", pp_table)

    result["secondary"] = {
        "ftpsLmm": lmm_meta,
        "mediation": mediation_meta,
        "traitAnxiety": trait_meta,
        "sensitivity": pp_meta,
    }

    # 阶段分析、效应估计与敏感性（讨论后新增，见 phase.py）
    try:
        import phase

        result["phase"] = phase.run_phase(ctx, dataset, points, flagged,
                                          nonsystematic_meta.get("flaggedStrictIds") or [])
    except Exception as error:  # noqa: BLE001 - 阶段分析失败不该丢掉前面的结果
        result["warnings"].append(f"阶段分析失败：{error}")
        result["phase"] = None

    return result
