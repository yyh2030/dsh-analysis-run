# -*- coding: utf-8 -*-
"""阶段分析、效应估计与敏感性（对 2026-10-29 讨论新增的分析做独立实现）。

原则：
- 主模型保持 proposal §15.2 的 `AUC_T2 ~ 突显 × 干预 + AUC_T0`，所有组间对比都从
  同一个模型里取（共用基线斜率与残差方差），而不是在子组里各拟一个模型。
- 组间对比统一 EFT−ERT，交互统一 (EFT−ERT)MS − (EFT−ERT)DP；AUC 上为正才符合
  「MS 后 EFT 优势更大」。
- T1 是诱发后、干预前的测量：控制 T1 的模型回答「干预阶段新增了什么」，不能替代
  原方案控制 T0 的主检验。

本模块只读 `dataset` 与 `_lab`，不写原始数据。
"""

from __future__ import annotations

import os

import numpy as np
import pandas as pd

VERSION = "phase/1.0.0"

FAC = "C(salience, Treatment('DP')) * C(intervention, Treatment('ERT'))"
TIME = ["T0", "T1", "T2"]

IMAGERY_PROCESS = {
    "q01": "脑海的画面很生动",
    "q04": "整体情绪很积极",
    "q06": "想象/回忆过程很投入",
    "q08": "这些事件在主观上离你很远",
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


def _scalar(value):
    """t_test 的结果可能是 0 维或 (1,) 数组，统一取第一个数。"""
    return float(np.ravel(np.asarray(value))[0])


def _interval(result):
    bounds = np.ravel(np.asarray(result.conf_int()))
    return float(bounds[0]), float(bounds[1])


def bh(p_values):
    """Benjamini–Hochberg，返回与输入同序的调整后 p。"""
    values = np.asarray([1.0 if p is None or (isinstance(p, float) and np.isnan(p)) else float(p) for p in p_values])
    order = np.argsort(values)
    adjusted = np.empty_like(values)
    m = len(values)
    running = 1.0
    for rank, index in enumerate(order[::-1], start=1):
        position = m - rank + 1
        running = min(running, values[index] * m / position)
        adjusted[index] = running
    return adjusted


def holm(p_values):
    values = np.asarray([1.0 if p is None or (isinstance(p, float) and np.isnan(p)) else float(p) for p in p_values])
    order = np.argsort(values)
    adjusted = np.empty_like(values)
    m = len(values)
    running = 0.0
    for rank, index in enumerate(order, start=1):
        running = max(running, min(1.0, (m - rank + 1) * values[index]))
        adjusted[index] = running
    return adjusted


PARAM = {
    "ms": "C(salience, Treatment('DP'))[T.MS]",
    "eft": "C(intervention, Treatment('ERT'))[T.EFT]",
    "interaction": "C(salience, Treatment('DP'))[T.MS]:C(intervention, Treatment('ERT'))[T.EFT]",
}


def fit_contrasts(name, formula, data, effects, method="OLS"):
    """拟一个模型，按效应定义取线性组合（含 CI 与 p）。"""
    import statsmodels.formula.api as smf

    model = smf.ols(formula, data=data).fit()
    index = {key: position for position, key in enumerate(model.params.index)}
    vectors = {
        "interaction": {PARAM["interaction"]: 1.0},
        "EFT-ERT_DP": {PARAM["eft"]: 1.0},
        "EFT-ERT_MS": {PARAM["eft"]: 1.0, PARAM["interaction"]: 1.0},
        "EFT-ERT_equal": {PARAM["eft"]: 1.0, PARAM["interaction"]: 0.5},
        "MS-DP_equal": {PARAM["ms"]: 1.0, PARAM["interaction"]: 0.5},
    }
    rows = []
    for effect in effects:
        weights = np.zeros(len(model.params))
        for key, weight in vectors[effect].items():
            weights[index[key]] = weight
        result = model.t_test(weights)
        rows.append({
            "模型": name,
            "效应": effect,
            "估计": _fmt(_scalar(result.effect)),
            "SE": _fmt(_scalar(result.sd)),
            "95%CI 下限": _fmt(_interval(result)[0]),
            "95%CI 上限": _fmt(_interval(result)[1]),
            "t": _fmt(_scalar(result.tvalue)),
            "p": _p(_scalar(result.pvalue)),
            "n": int(model.nobs),
            "df_resid": int(model.df_resid),
            "区间方法": method,
        })
    return model, rows


def phase_descriptives(dataset):
    data = dataset[dataset["included"]]
    rows = []
    for cell, group in data.groupby("cell", sort=True):
        row = {"组别": cell, "n": int(len(group))}
        for value, label in (("AUC", "AUC"), ("FTPS", "FTPS")):
            for wave in TIME:
                column = f"{value}_{wave}"
                row[f"{label} {wave}"] = _fmt(group[column].mean())
            for left, right in (("T0", "T1"), ("T1", "T2"), ("T0", "T2")):
                column = f"{value}_{left}"
                other = f"{value}_{right}"
                row[f"{label} {left}→{right}"] = _fmt((group[other] - group[column]).mean())
        rows.append(row)
    return pd.DataFrame(rows)


def overall_changes(dataset):
    from scipy import stats

    data = dataset[dataset["included"]]
    rows = []
    for value, label in (("AUC", "AUC"), ("FTPS", "FTPS")):
        for left, right in (("T0", "T1"), ("T1", "T2"), ("T0", "T2")):
            delta = (data[f"{value}_{right}"] - data[f"{value}_{left}"]).dropna()
            if len(delta) < 3:
                continue
            t_stat, p_value = stats.ttest_rel(data[f"{value}_{right}"], data[f"{value}_{left}"], nan_policy="omit")
            half = stats.t.ppf(0.975, len(delta) - 1) * delta.std(ddof=1) / np.sqrt(len(delta))
            rows.append({
                "指标": f"{label} {left}→{right}",
                "n": int(len(delta)),
                "平均变化": _fmt(delta.mean()),
                "95%CI": f"[{_fmt(delta.mean() - half)}, {_fmt(delta.mean() + half)}]",
                "配对 t": _fmt(t_stat),
                "p": _p(p_value),
            })
    return pd.DataFrame(rows)


def primary_contrasts(dataset):
    data = dataset[dataset["included"]]
    rows = []
    _m, block = fit_contrasts("AUC_primary", f"AUC_T2 ~ {FAC} + AUC_T0", data,
                              ["interaction", "EFT-ERT_DP", "EFT-ERT_MS", "EFT-ERT_equal", "MS-DP_equal"])
    rows += block
    _m2, block = fit_contrasts("lnk_primary", f"lnk_T2 ~ {FAC} + lnk_T0", data,
                               ["interaction", "EFT-ERT_DP", "EFT-ERT_MS", "EFT-ERT_equal"])
    rows += block
    return pd.DataFrame(rows)


def stage_models(dataset):
    data = dataset[dataset["included"]]
    rows = []

    def induction(formula, label):
        import statsmodels.formula.api as smf

        model = smf.ols(formula, data=data).fit()
        result = model.t_test("C(salience, Treatment('DP'))[T.MS] = 0")
        rows.append({
            "模型": label, "效应": "MS−DP",
            "估计": _fmt(_scalar(result.effect)), "SE": _fmt(_scalar(result.sd)),
            "95%CI 下限": _fmt(_interval(result)[0]), "95%CI 上限": _fmt(_interval(result)[1]),
            "t": _fmt(_scalar(result.tvalue)), "p": _p(_scalar(result.pvalue)),
            "n": int(model.nobs), "df_resid": int(model.df_resid), "区间方法": "OLS",
        })

    induction("AUC_T1 ~ C(salience, Treatment('DP')) + AUC_T0", "诱发：AUC_T1，控制 T0")
    induction("FTPS_T1 ~ C(salience, Treatment('DP')) + FTPS_T0", "诱发：FTPS_T1，控制 T0")

    for name, formula, method in (
        ("干预：AUC_T2，控制 T1", f"AUC_T2 ~ {FAC} + AUC_T1", "OLS"),
        ("干预：AUC_T2，控制 T0+T1", f"AUC_T2 ~ {FAC} + AUC_T0 + AUC_T1", "OLS"),
        ("干预：FTPS_T2，控制 T1", f"FTPS_T2 ~ {FAC} + FTPS_T1", "OLS"),
        ("干预：FTPS_T2，控制 T0+T1", f"FTPS_T2 ~ {FAC} + FTPS_T0 + FTPS_T1", "OLS"),
    ):
        _model, block = fit_contrasts(name, formula, data, ["interaction", "EFT-ERT_DP", "EFT-ERT_MS"], method)
        rows += block
    return pd.DataFrame(rows)


def lmm_three_way(dataset):
    import statsmodels.formula.api as smf
    from scipy import stats

    data = dataset[dataset["included"]]
    rows = []
    for value, label in (("AUC", "AUC"), ("FTPS", "FTPS")):
        long = data.melt(id_vars=["subjectid", "salience", "intervention"],
                         value_vars=[f"{value}_{wave}" for wave in TIME],
                         var_name="wave", value_name="value").dropna(subset=["value"])
        long["time"] = pd.Categorical(long["wave"].str.replace(f"{value}_", "", regex=False),
                                      categories=TIME, ordered=True)
        full = f"value ~ C(time) * C(salience) * C(intervention)"
        reduced = ("value ~ C(time) + C(salience) + C(intervention) + C(time):C(salience)"
                   " + C(time):C(intervention) + C(salience):C(intervention)")
        try:
            m_full = smf.mixedlm(full, long, groups=long["subjectid"]).fit(reml=False)
            m_reduced = smf.mixedlm(reduced, long, groups=long["subjectid"]).fit(reml=False)
        except Exception as error:  # noqa: BLE001
            rows.append({"结局": label, "检验": "时间×突显×干预", "χ²": "", "df": "", "p": "", "说明": str(error)})
            continue
        lr = 2 * (m_full.llf - m_reduced.llf)
        df_diff = len(m_full.fe_params) - len(m_reduced.fe_params)
        rows.append({
            "结局": label,
            "检验": "时间×突显×干预（LR）",
            "χ²": _fmt(lr), "df": int(df_diff), "p": _p(stats.chi2.sf(lr, max(df_diff, 1))),
            "随机截距方差": _fmt(float(m_full.cov_re.values[0][0])),
            "残差方差": _fmt(float(m_full.scale)),
            "n": int(long["subjectid"].nunique()),
            "说明": "ML LRT，渐近近似",
        })
    return pd.DataFrame(rows)


def load_imagery(lab_dir):
    path = os.path.join(lab_dir, "scales", "answers", "IMAGERY_APPRAISAL__imagery.csv")
    if not os.path.exists(path):
        return None
    frame = pd.read_csv(path, encoding="utf-8-sig", dtype=str).rename(columns={"编号": "subjectid"})
    frame["subjectid"] = frame["subjectid"].astype(str).str.zfill(5)
    for column in frame.columns[1:]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame


def imagery_contrasts(dataset, lab_dir):
    imagery = load_imagery(lab_dir)
    if imagery is None:
        return pd.DataFrame(), pd.DataFrame()
    data = dataset[dataset["included"]][["subjectid", "salience", "intervention", "cell"]].merge(
        imagery, on="subjectid", how="inner")
    rows = []
    for item in [f"q{index:02d}" for index in range(1, 11)]:
        if item not in data.columns:
            continue
        label = IMAGERY_ITEM_LABELS.get(item, item)
        frame = data.dropna(subset=[item])
        import statsmodels.formula.api as smf

        model = smf.ols(f"{item} ~ {FAC}", data=frame).fit()
        index = {key: position for position, key in enumerate(model.params.index)}
        vector = np.zeros(len(model.params))
        vector[index[PARAM["eft"]]] = 1.0
        vector[index[PARAM["interaction"]]] = 0.5
        result = model.t_test(vector)
        rows.append({
            "过程条目": label,
            "EFT−ERT": _fmt(_scalar(result.effect)),
            "95%CI 下限": _fmt(_interval(result)[0]),
            "95%CI 上限": _fmt(_interval(result)[1]),
            "原始 p": _p(_scalar(result.pvalue)),
            "n": int(model.nobs),
        })
    table = pd.DataFrame(rows)
    if len(table):
        table["BH p（10 题）"] = [_p(value) for value in bh([_num(value) for value in table["原始 p"]])]
    return table, data


IMAGERY_ITEM_LABELS = {
    "q01": "脑海的画面很生动",
    "q02": "脑海中的事件很具体",
    "q03": "感受到的情绪很强烈",
    "q04": "整体情绪很积极",
    "q05": "这些事件对你很重要",
    "q06": "想象/回忆过程很投入",
    "q07": "想象/回忆这些事件很简单",
    "q08": "这些事件在主观上离你很远",
    "q09": "想象/回忆这些事件对你很有帮助",
    "q10": "你很期待想象/回忆这些事件会改善你的状态或选择",
}


def _num(value):
    if isinstance(value, str) and value.strip().startswith("<"):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return np.nan


def imagery_associations(dataset, imagery_data):
    if imagery_data is None or not len(imagery_data):
        return pd.DataFrame()
    data = dataset[dataset["included"]].merge(
        imagery_data[["subjectid"] + list(IMAGERY_PROCESS)], on="subjectid", how="inner")
    rows = []
    import statsmodels.formula.api as smf

    for item, label in IMAGERY_PROCESS.items():
        for outcome, covar in (("AUC", "AUC_T1"), ("FTPS", "FTPS_T1")):
            frame = data.dropna(subset=[item, f"{outcome}_T2", covar]).copy()
            formula = f"{outcome}_T2 ~ {FAC} + {covar} + {item}"
            model = smf.ols(formula, data=frame).fit()
            rows.append({
                "过程": label,
                "结局": outcome,
                "条件关联斜率": _fmt(model.params.get(item)),
                "95%CI 下限": _fmt(model.conf_int().loc[item][0]),
                "95%CI 上限": _fmt(model.conf_int().loc[item][1]),
                "原始 p": _p(model.pvalues.get(item)),
                "n": int(model.nobs),
            })
    table = pd.DataFrame(rows)
    if len(table):
        table["BH p（8 项）"] = [_p(value) for value in bh([_num(value) for value in table["原始 p"]])]
    return table


def sensitivity(dataset, flagged_original, flagged_strict):
    data = dataset[dataset["included"]]
    rows = []
    _model, block = fit_contrasts("原主模型", f"AUC_T2 ~ {FAC} + AUC_T0", data, ["interaction"])
    rows += block
    import statsmodels.formula.api as smf

    robust = smf.ols(f"AUC_T2 ~ {FAC} + AUC_T0", data=data).fit(cov_type="HC3")
    index = {key: position for position, key in enumerate(robust.params.index)}
    vector = np.zeros(len(robust.params))
    vector[index[PARAM["interaction"]]] = 1.0
    result = robust.t_test(vector)
    t_value = _scalar(result.tvalue)
    df_resid = int(robust.df_resid)
    from scipy import stats as scipy_stats

    half = scipy_stats.t.ppf(0.975, df_resid) * _scalar(result.sd)
    estimate = _scalar(result.effect)
    rows.append({"模型": "HC3 稳健标准误", "效应": "interaction",
                 "估计": _fmt(estimate), "SE": _fmt(_scalar(result.sd)),
                 "95%CI 下限": _fmt(estimate - half), "95%CI 上限": _fmt(estimate + half),
                 "t": _fmt(t_value), "p": _p(2 * scipy_stats.t.sf(abs(t_value), df_resid)),
                 "n": int(robust.nobs), "df_resid": df_resid, "区间方法": "HC3（t 分布）"})

    _m, block = fit_contrasts("增加 T0 STAI-S", f"AUC_T2 ~ {FAC} + AUC_T0 + STAI_S_T0", data, ["interaction"])
    rows += block
    for label, ids in (("排除原五人", flagged_original), ("排除严格 T0/T2 四人", flagged_strict)):
        subset = data[~data["subjectid"].isin(ids)]
        if len(subset) >= 8:
            _m, block = fit_contrasts(label, f"AUC_T2 ~ {FAC} + AUC_T0", subset, ["interaction"])
            rows += block
        else:
            rows.append({"模型": label, "效应": "interaction", "估计": "", "SE": "", "95%CI 下限": "",
                         "95%CI 上限": "", "t": "", "p": "", "n": int(len(subset)), "df_resid": "",
                         "区间方法": "样本不足"})
    return pd.DataFrame(rows)


def leave_one_out(dataset):
    data = dataset[dataset["included"]]
    import statsmodels.formula.api as smf

    rows = []
    for subject in sorted(data["subjectid"]):
        subset = data[data["subjectid"] != subject]
        model = smf.ols(f"AUC_T2 ~ {FAC} + AUC_T0", data=subset).fit()
        index = {key: position for position, key in enumerate(model.params.index)}
        vector = np.zeros(len(model.params))
        vector[index[PARAM["interaction"]]] = 1.0
        result = model.t_test(vector)
        rows.append({"剔除被试": subject, "交互估计": _fmt(_scalar(result.effect)),
                     "p": _p(_scalar(result.pvalue))})
    table = pd.DataFrame(rows)
    full = smf.ols(f"AUC_T2 ~ {FAC} + AUC_T0", data=data).fit()
    cook = pd.Series(full.get_influence().cooks_distance[0], index=data.index)
    by_subject = {subject: cook.loc[data.index[data["subjectid"] == subject][0]]
                  for subject in data["subjectid"]}
    table["CookD（全模型）"] = [_fmt(by_subject.get(subject)) for subject in table["剔除被试"]]
    return table


def delay_ratios(points):
    """每个延迟点的比例：两档 IP/延迟金额的平均。"""
    if points is None or not len(points):
        return None
    frame = points.copy()
    frame["session"] = frame["session"].astype(str).str.zfill(3)
    frame["wave"] = frame["session"].map({"001": "T0", "002": "T1", "003": "T2"})
    frame["ratio"] = frame["IP"].astype(float) / frame["amountLL"].astype(float)
    return frame.groupby(["subjectid", "wave", "delayLL"])["ratio"].mean().reset_index()


def delay_analysis(dataset, ratios):
    if ratios is None or not len(ratios):
        return pd.DataFrame(), pd.DataFrame()
    import statsmodels.formula.api as smf

    data = dataset[dataset["included"]][["subjectid", "salience", "intervention", "cell"]]
    wide = ratios.pivot_table(index=["subjectid", "delayLL"], columns="wave", values="ratio").reset_index()
    wide.columns.name = None
    merged = wide.merge(data, on="subjectid", how="inner")
    rows = []
    for delay, group in merged.groupby("delayLL", sort=True):
        # T1 是干预前测量，T2 是结局；T0 保留给敏感性分析
        frame = group.dropna(subset=["T1", "T2"])
        model = smf.ols(f"T2 ~ {FAC} + T1", data=frame).fit()
        index = {key: position for position, key in enumerate(model.params.index)}
        vector = np.zeros(len(model.params))
        vector[index[PARAM["interaction"]]] = 1.0
        result = model.t_test(vector)
        rows.append({"延迟（天）": _fmt(delay, 0), "交互估计": _fmt(_scalar(result.effect)),
                     "95%CI 下限": _fmt(_interval(result)[0]),
                     "95%CI 上限": _fmt(_interval(result)[1]),
                     "原始 p": _p(_scalar(result.pvalue)), "n": int(model.nobs)})
    table = pd.DataFrame(rows)
    if len(table):
        table["Holm p（5 延迟）"] = [_p(value) for value in holm([_num(value) for value in table["原始 p"]])]
    return table, merged


def delay_sensitivity(merged):
    """5 年延迟点的规格敏感性（T0 校正、双校正、HC3、两套排除）。"""
    if merged is None or not len(merged):
        return pd.DataFrame()
    import statsmodels.formula.api as smf

    group = merged[merged["delayLL"] == 1825.0].dropna(subset=["T0", "T1", "T2"])
    frame = group
    rows = []

    def run(label, subset, formula, cov_type=None):
        model = smf.ols(formula, data=subset).fit(cov_type=cov_type) if cov_type else smf.ols(formula, data=subset).fit()
        index = {key: position for position, key in enumerate(model.params.index)}
        vector = np.zeros(len(model.params))
        vector[index[PARAM["interaction"]]] = 1.0
        result = model.t_test(vector)
        estimate, se, t_value = _scalar(result.effect), _scalar(result.sd), _scalar(result.tvalue)
        df_resid = int(model.df_resid)
        if cov_type:
            from scipy import stats as scipy_stats

            half = scipy_stats.t.ppf(0.975, df_resid) * se
            low, high, p_value = estimate - half, estimate + half, 2 * scipy_stats.t.sf(abs(t_value), df_resid)
        else:
            low, high = _interval(result)
            p_value = _scalar(result.pvalue)
        rows.append({"规格": label, "交互估计": _fmt(estimate),
                     "95%CI 下限": _fmt(low), "95%CI 上限": _fmt(high),
                     "原始 p": _p(p_value), "n": int(model.nobs)})

    run("控制 T0", frame, f"T2 ~ {FAC} + T0")
    run("控制 T0+T1", frame, f"T2 ~ {FAC} + T0 + T1")
    run("HC3（控制 T1）", frame, f"T2 ~ {FAC} + T1", "HC3")
    return pd.DataFrame(rows)


def tier_analysis(dataset):
    data = dataset[dataset["included"]]
    rows = []
    for tag, label in (("s", "小金额档"), ("l", "大金额档")):
        _m, block = fit_contrasts(label, f"AUC_{tag}_T2 ~ {FAC} + AUC_{tag}_T0", data, ["interaction"])
        rows += block
    frame = data.copy()
    frame["tier_diff2"] = frame["AUC_l_T2"] - frame["AUC_s_T2"]
    _m, block = fit_contrasts("两档差值", f"tier_diff2 ~ {FAC} + AUC_l_T0 + AUC_s_T0", frame, ["interaction"])
    rows += block
    return pd.DataFrame(rows)


def logdelay_auc(dataset, points):
    if points is None or not len(points):
        return pd.DataFrame()
    frame = points.copy()
    frame["session"] = frame["session"].astype(str).str.zfill(3)
    frame["wave"] = frame["session"].map({"001": "T0", "002": "T1", "003": "T2"})
    frame["ratio"] = frame["IP"].astype(float) / frame["amountLL"].astype(float)
    rows = []
    for (subject, wave), group in frame.groupby(["subjectid", "wave"], sort=True):
        group = group.groupby("delayLL")["ratio"].mean().reset_index().sort_values("delayLL")
        x = np.r_[0.0, np.log1p(group["delayLL"].to_numpy(dtype=float)) / np.log1p(1825.0)]
        y = np.r_[1.0, group["ratio"].to_numpy(dtype=float)]
        rows.append({"subjectid": subject, "wave": wave,
                     "value": float(np.sum(np.diff(x) * (y[:-1] + y[1:]) / 2))})
    wide = pd.DataFrame(rows).pivot(index="subjectid", columns="wave", values="value").add_prefix("logauc_").reset_index()
    data = dataset[dataset["included"]][["subjectid", "salience", "intervention", "cell"]].merge(wide, on="subjectid")
    _m, block = fit_contrasts("log-delay AUC（T0 校正）", f"logauc_T2 ~ {FAC} + logauc_T0", data, ["interaction"])
    return pd.DataFrame(block)


def emotion_analysis(dataset):
    data = dataset[dataset["included"]]
    rows = []
    for value, label in (("STAI_S", "STAI-S"), ("PANAS_NA_NOW", "PANAS-NA")):
        for cell, group in data.groupby("cell", sort=True):
            delta = (group[f"{value}_T2"] - group[f"{value}_T0"]).dropna()
            if not len(delta):
                continue
            from scipy import stats as scipy_stats

            half = scipy_stats.t.ppf(0.975, len(delta) - 1) * delta.std(ddof=1) / np.sqrt(len(delta))
            rows.append({"结局": label, "组别": cell, "n": int(len(delta)),
                         "平均变化": _fmt(delta.mean()),
                         "95%CI": f"[{_fmt(delta.mean() - half)}, {_fmt(delta.mean() + half)}]"})
    table = pd.DataFrame(rows)
    model_rows = []
    import statsmodels.formula.api as smf

    for value, label in (("STAI_S", "STAI-S"), ("PANAS_NA_NOW", "PANAS-NA")):
        frame = data.dropna(subset=[f"{value}_T0", f"{value}_T2"])
        model = smf.ols(f"{value}_T2 ~ {FAC} + {value}_T0", data=frame).fit()
        index = {key: position for position, key in enumerate(model.params.index)}
        vector = np.zeros(len(model.params))
        vector[index[PARAM["interaction"]]] = 1.0
        result = model.t_test(vector)
        model_rows.append({"结局": label, "检验": "T2 交互，控制 T0",
                           "估计": _fmt(_scalar(result.effect)),
                           "95%CI": f"[{_fmt(_interval(result)[0])}, {_fmt(_interval(result)[1])}]",
                           "p": _p(_scalar(result.pvalue)), "n": int(model.nobs)})
    return table, pd.DataFrame(model_rows)


def run_phase(ctx: dict, dataset: pd.DataFrame, points: pd.DataFrame | None, flagged_original, flagged_strict):
    """跑阶段分析与效应估计，返回 {tables, notes, warnings}。"""
    tables_dir = os.path.join(ctx["runDir"], "tables")
    os.makedirs(tables_dir, exist_ok=True)
    result = {"version": VERSION, "tables": {}, "warnings": []}

    def put(key, frame):
        if frame is None or not len(frame):
            return
        result["tables"][key] = frame.to_dict(orient="records")
        frame.to_csv(os.path.join(tables_dir, f"{key}.csv"), index=False, encoding="utf-8-sig")

    def step(label, fn):
        try:
            return fn()
        except Exception as error:  # noqa: BLE001 - 单一分析失败不中断
            result["warnings"].append(f"{label}失败：{error}")
            return None

    put("table21_phase_descriptives", step("阶段描述", lambda: phase_descriptives(dataset)))
    put("table22_overall_changes", step("全体变化", lambda: overall_changes(dataset)))
    put("table23_primary_contrasts", step("主模型对比", lambda: primary_contrasts(dataset)))
    put("table24_stage_models", step("阶段模型", lambda: stage_models(dataset)))
    put("table25_lmm_three_way", step("三时点混合模型", lambda: lmm_three_way(dataset)))

    imagery_table, imagery_data = (pd.DataFrame(), None)
    try:
        imagery_table, imagery_data = imagery_contrasts(dataset, ctx["labDir"])
        put("table26_imagery_contrasts", imagery_table)
    except Exception as error:  # noqa: BLE001
        result["warnings"].append(f"想象评价失败：{error}")
    put("table27_imagery_associations", step("过程—结局关联", lambda: imagery_associations(dataset, imagery_data)))

    put("table28_primary_sensitivity", step("主模型敏感性", lambda: sensitivity(dataset, flagged_original, flagged_strict)))
    put("table29_leave_one_out", step("逐人剔除", lambda: leave_one_out(dataset)))

    ratios = step("延迟比例", lambda: delay_ratios(points))
    delay_table, merged = (pd.DataFrame(), None)
    try:
        delay_table, merged = delay_analysis(dataset, ratios)
        put("table30_delay_contrasts", delay_table)
    except Exception as error:  # noqa: BLE001
        result["warnings"].append(f"延迟分析失败：{error}")
    put("table31_delay_sensitivity", step("5 年延迟敏感性", lambda: delay_sensitivity(merged)))
    put("table32_tier_contrasts", step("金额档对比", lambda: tier_analysis(dataset)))
    put("table33_logdelay_auc", step("对数延迟 AUC", lambda: logdelay_auc(dataset, points)))

    emotion_table, emotion_models = (pd.DataFrame(), pd.DataFrame())
    try:
        emotion_table, emotion_models = emotion_analysis(dataset)
        put("table34_emotion_changes", emotion_table)
        put("table35_emotion_contrasts", emotion_models)
    except Exception as error:  # noqa: BLE001
        result["warnings"].append(f"情绪分析失败：{error}")

    return result
