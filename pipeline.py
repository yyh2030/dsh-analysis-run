# -*- coding: utf-8 -*-
"""分析直通管线：ingest → derive → merge → model → report。

输出全部落在 `<labDir>/`：
    cache/               可重算的中间缓存（trials / ip / auc）
    runs/<runId>/        dataset、三线表、图、report.md、meta.json
原始数据只读。

用法：
    python pipeline.py --stage all --json
    python pipeline.py --stage status --json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import traceback
from datetime import date, datetime

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ddt  # noqa: E402

PIPELINE_VERSION = "analysis-run/1.0.0"
STAGES = ["ingest", "derive", "merge", "model", "report"]
STAGE_LABEL = {
    "ingest": "1 摄取（原始 CSV → 逐试次长表）",
    "derive": "2 推导（无差异点 → AUC / k）",
    "merge": "3 合并（AUC + 量表分 + 人口学 + 排除）",
    "model": "4 模型（描述统计 / 主分析 / 敏感性）",
    "report": "5 报告（三线表、图、md）",
}

# 门禁：n < 30 只出描述统计；30–39 可做探索；>= 40 开主分析
# （环境变量仅供测试口径，正式运行别设）
GATE_DESCRIBE = 1
GATE_EXPLORE = int(os.environ.get("DDT_GATE_EXPLORE", "30"))
GATE_MAIN = int(os.environ.get("DDT_GATE_MAIN", "40"))
GATE_MAIN_DESIGN = 40  # 设计稿预设：样本不到 40 的主分析只作探索

# 数据集里从 _lab/scores.csv 带进来的分数列（保持 _lab 的列名）
SCORE_KEEP_SUFFIX = ("_T0", "_T1", "_T2", "_week", "_post", "_meta", "_ts", "_imagery")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def fmt(value, digits: int = 3):
    """表里的小数：NaN 留空，整数原样。"""
    if value is None:
        return ""
    try:
        if isinstance(value, (float, np.floating)):
            if np.isnan(value):
                return ""
            return round(float(value), digits)
    except (TypeError, ValueError):
        pass
    return value


def write_csv(path: str, frame: pd.DataFrame) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    frame.to_csv(path, index=False, encoding="utf-8-sig")


def md_table(frame: pd.DataFrame) -> str:
    """三线表的 markdown 写法：表头一条线、表尾一条线，中间不画竖线。"""
    columns = [str(column) for column in frame.columns]
    lines = ["| " + " | ".join(columns) + " |", "|" + "|".join(["---"] * len(columns)) + "|"]
    for _, row in frame.iterrows():
        cells = []
        for value in row.tolist():
            if isinstance(value, float):
                cells.append("" if np.isnan(value) else f"{value:.3f}")
            else:
                cells.append(str(value))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# 输入
# --------------------------------------------------------------------------- #


def list_raw_files(raw_dir: str):
    if not os.path.isdir(raw_dir):
        return []
    names = []
    for name in sorted(os.listdir(raw_dir)):
        if not name.lower().endswith(".csv") or name.startswith("_"):
            continue
        names.append(os.path.join(raw_dir, name))
    return names


def load_manifest(cache_dir: str) -> dict:
    path = os.path.join(cache_dir, "manifest.json")
    if not os.path.exists(path):
        return {"files": {}}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {"files": {}}
    if "files" not in data:
        data["files"] = {}
    return data


def save_manifest(cache_dir: str, manifest: dict) -> None:
    os.makedirs(cache_dir, exist_ok=True)
    with open(os.path.join(cache_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# 阶段 1：摄取
# --------------------------------------------------------------------------- #


def stage_ingest(ctx: dict) -> dict:
    raw_dir = ctx["rawDir"]
    cache_dir = ctx["cacheDir"]
    files_dir = os.path.join(cache_dir, "files")
    os.makedirs(files_dir, exist_ok=True)

    manifest = load_manifest(cache_dir)
    cached = manifest["files"]
    fresh, parsed, reused, failures = {}, 0, 0, []

    for path in list_raw_files(raw_dir):
        name = os.path.basename(path)
        stat = os.stat(path)
        stamp = {"mtime": int(stat.st_mtime), "size": int(stat.st_size)}
        entry = cached.get(name)
        digest = ddt.sha256_file(path)
        cache_name = f"{digest[:12]}-{name}.csv"
        cache_path = os.path.join(files_dir, cache_name)
        if entry and entry.get("mtime") == stamp["mtime"] and entry.get("size") == stamp["size"] and os.path.exists(cache_path):
            reused += 1
            fresh[name] = dict(entry, cache=cache_name, sha256=digest)
            continue
        try:
            result = ddt.parse_file(path)
        except Exception as error:  # noqa: BLE001 - 单个文件坏掉不该中断整条管子
            failures.append({"file": name, "error": str(error)})
            continue
        write_csv(cache_path, result["trials"])
        parsed += 1
        fresh[name] = dict(stamp, cache=cache_name, sha256=digest, session=result["meta"]["session"],
                           subject=result["meta"]["subject"], expStart=result["meta"]["expStart"],
                           date=result["meta"]["date"], n_trials=result["meta"]["n_trials"])

    # 已删除的原始文件：连同缓存一起清掉
    removed = [name for name in cached if name not in fresh]
    for name in removed:
        old = cached.get(name, {}).get("cache")
        if old:
            try:
                os.remove(os.path.join(files_dir, old))
            except OSError:
                pass

    frames, dropped = [], []
    by_session = {}
    for name, entry in fresh.items():
        frame = pd.read_csv(os.path.join(files_dir, entry["cache"]), encoding="utf-8-sig", dtype={"subjectid": str, "session": str})
        by_session.setdefault((entry.get("subject"), entry.get("session")), []).append((name, entry, frame))

    for key, items in sorted(by_session.items(), key=lambda kv: str(kv[0])):
        if len(items) > 1:
            # 同一被试同一 session 有多个文件：保留 expStart 最晚的一份，其余记录在案
            items.sort(key=lambda item: (str(item[1].get("expStart") or ""), item[1].get("mtime", 0)))
            for name, _entry, _frame in items[:-1]:
                dropped.append({"file": name, "subject": key[0], "session": key[1], "reason": "同一 session 的较早文件"})
        frames.append(items[-1][2])

    if not frames:
        raise RuntimeError(f"{raw_dir} 里没有可解析的 DDT 原始 CSV")

    trials = pd.concat(frames, ignore_index=True)
    trials["subjectid"] = trials["subjectid"].astype(str).str.strip()
    trials["session"] = trials["session"].astype(str).str.zfill(3)
    trials["session_label"] = trials["session"].map(ddt.SESSION_LABEL)
    trials = trials.sort_values(["subjectid", "session", "trial"]).reset_index(drop=True)
    write_csv(os.path.join(cache_dir, "trials.csv"), trials)
    save_manifest(cache_dir, {"files": fresh, "updatedAt": now_iso()})

    return {
        "stage": "ingest",
        "rows": int(len(trials)),
        "subjects": int(trials["subjectid"].nunique()),
        "sessions": int(trials.groupby(["subjectid", "session"]).ngroups),
        "files": len(fresh),
        "parsed": parsed,
        "reused": reused,
        "removed": removed,
        "dropped": dropped,
        "failures": failures,
        "artifacts": [os.path.join(cache_dir, "trials.csv")],
    }


# --------------------------------------------------------------------------- #
# 阶段 2：推导
# --------------------------------------------------------------------------- #


def stage_derive(ctx: dict) -> dict:
    cache_dir = ctx["cacheDir"]
    trials_path = os.path.join(cache_dir, "trials.csv")
    if not os.path.exists(trials_path):
        raise RuntimeError("还没有逐试次长表：先跑摄取阶段")
    trials = pd.read_csv(trials_path, encoding="utf-8-sig", dtype={"subjectid": str, "session": str})

    points = ddt.indifference_points(trials)
    per_session = ddt.derive_auc_k(points)
    wide = ddt.wide_by_subject(per_session)
    qc = ddt.qc_summary(trials, points, per_session)

    write_csv(os.path.join(cache_dir, "indifference_points.csv"), points)
    write_csv(os.path.join(cache_dir, "auc_k.csv"), per_session)
    write_csv(os.path.join(cache_dir, "auc_wide.csv"), wide)

    return {
        "stage": "derive",
        "subjects": int(wide["subjectid"].nunique()),
        "points": int(len(points)),
        "sessions": int(len(per_session)),
        "qc": qc,
        "artifacts": [
            os.path.join(cache_dir, "indifference_points.csv"),
            os.path.join(cache_dir, "auc_k.csv"),
            os.path.join(cache_dir, "auc_wide.csv"),
        ],
    }


# --------------------------------------------------------------------------- #
# 阶段 3：合并
# --------------------------------------------------------------------------- #


def read_exclusions(lab_dir: str) -> pd.DataFrame:
    path = os.path.join(lab_dir, "exclusions.csv")
    if not os.path.exists(path):
        return pd.DataFrame(columns=["编号", "原因", "时间", "操作"])
    frame = pd.read_csv(path, encoding="utf-8-sig", dtype=str)
    if "编号" not in frame.columns:
        return pd.DataFrame(columns=["编号", "原因", "时间", "操作"])
    frame["编号"] = frame["编号"].astype(str).str.strip()
    return frame


def stage_merge(ctx: dict) -> dict:
    cache_dir = ctx["cacheDir"]
    lab_dir = ctx["labDir"]
    run_dir = ctx["runDir"]
    wide_path = os.path.join(cache_dir, "auc_wide.csv")
    if not os.path.exists(wide_path):
        raise RuntimeError("还没有 AUC 宽表：先跑推导阶段")
    wide = pd.read_csv(wide_path, encoding="utf-8-sig", dtype={"subjectid": str})
    wide["subjectid"] = wide["subjectid"].astype(str).str.zfill(5)
    warnings = []

    # 质控随数据走：单独跑合并阶段时也能出质控表
    qc = ctx.get("qc")
    trials_path = os.path.join(cache_dir, "trials.csv")
    points_path = os.path.join(cache_dir, "indifference_points.csv")
    per_session_path = os.path.join(cache_dir, "auc_k.csv")
    if qc is None and all(os.path.exists(path) for path in (trials_path, points_path, per_session_path)):
        trials = pd.read_csv(trials_path, encoding="utf-8-sig", dtype={"subjectid": str, "session": str})
        points = pd.read_csv(points_path, encoding="utf-8-sig", dtype={"subjectid": str})
        per_session = pd.read_csv(per_session_path, encoding="utf-8-sig", dtype={"subjectid": str})
        qc = ddt.qc_summary(trials, points, per_session)
    ctx["qc"] = qc

    # 分组来自编号前两位（1=MS/2=DP，1=EFT/2=ERT）；对不上的记一条
    suspect = wide[wide["salience"].isna() | wide["intervention"].isna()]["subjectid"].tolist()
    if suspect:
        warnings.append(f"编号前两位不是 1/2，分组无法判定：{', '.join(suspect)}")
    wide["salience"] = wide["salience"].fillna("?")
    wide["intervention"] = wide["intervention"].fillna("?")
    wide["cell"] = wide["salience"] + "×" + wide["intervention"]

    # 量表分
    scores_path = os.path.join(lab_dir, "scores.csv")
    scores_columns = []
    if os.path.exists(scores_path):
        scores = pd.read_csv(scores_path, encoding="utf-8-sig", dtype={"编号": str})
        scores["编号"] = scores["编号"].astype(str).str.zfill(5)
        keep = [column for column in scores.columns if not column.endswith("_缺失")]
        scores_columns = keep
        scores = scores[keep].rename(columns={"编号": "subjectid"})
        wide = wide.merge(scores, on="subjectid", how="left")
    else:
        warnings.append("没有 _lab/scores.csv：量表分列缺失，先跑量表计分")

    # 人口学
    demo_path = os.path.join(lab_dir, "demographics.json")
    demo_columns = []
    if os.path.exists(demo_path):
        try:
            with open(demo_path, encoding="utf-8") as fh:
                demo = json.load(fh)
            rows = demo.get("rows") or []
            if rows:
                frame = pd.DataFrame(rows).rename(columns={"id": "subjectid"})
                frame["subjectid"] = frame["subjectid"].astype(str).str.zfill(5)
                keys = [column["key"] for column in demo.get("columns", []) if column.get("key") in frame.columns]
                demo_columns = keys
                frame = frame[["subjectid"] + keys]
                wide = wide.merge(frame, on="subjectid", how="left")
        except (OSError, ValueError) as error:
            warnings.append(f"demographics.json 读不了：{error}")
    else:
        warnings.append("没有 _lab/demographics.json：人口学列缺失")

    # 排除名单（人定，脚本只执行）
    exclusions = read_exclusions(lab_dir)
    excluded_ids = set(exclusions["编号"].tolist())
    wide["excluded"] = wide["subjectid"].isin(excluded_ids)
    wide["exclude_reason"] = wide["subjectid"].map(
        dict(zip(exclusions["编号"], exclusions["原因"])) if len(exclusions) else {}
    )

    # 可用性
    wide["has_t0"] = wide["AUC_T0"].notna()
    wide["has_t1"] = wide["AUC_T1"].notna()
    wide["has_t2"] = wide["AUC_T2"].notna()
    wide["has_scores"] = wide["subjectid"].isin(
        pd.read_csv(scores_path, encoding="utf-8-sig", dtype={"编号": str})["编号"].astype(str).str.zfill(5)
        if os.path.exists(scores_path) else []
    )
    wide["included"] = wide["has_t0"] & wide["has_t2"] & ~wide["excluded"]
    wide["missing_reason"] = np.where(
        wide["excluded"],
        "已排除",
        np.where(~wide["has_t0"], "缺 T0", np.where(~wide["has_t2"], "缺 T2", "")),
    )

    columns = ["subjectid", "salience", "intervention", "cell",
               "AUC_T0", "AUC_T1", "AUC_T2", "AUC", "AUC_s_T0", "AUC_l_T0",
               "lnk_T0", "lnk_T1", "lnk_T2", "k_s_T0", "k_l_T0",
               "has_t0", "has_t1", "has_t2", "has_scores", "included", "excluded",
               "exclude_reason", "missing_reason"]
    ordered = [column for column in columns if column in wide.columns]
    ordered += [column for column in wide.columns if column not in ordered]
    dataset = wide[ordered].sort_values(["salience", "intervention", "subjectid"]).reset_index(drop=True)

    os.makedirs(run_dir, exist_ok=True)
    dataset_path = os.path.join(run_dir, "dataset.csv")
    write_csv(dataset_path, dataset)

    unavailable = dataset[~dataset["included"]][["subjectid", "missing_reason"]]
    return {
        "stage": "merge",
        "subjects": int(len(dataset)),
        "included": int(dataset["included"].sum()),
        "excluded": int(dataset["excluded"].sum()),
        "unavailable": unavailable.to_dict(orient="records"),
        "scores": [column for column in scores_columns if column != "编号"],
        "demographicsColumns": demo_columns,
        "qc": qc,
        "warnings": warnings,
        "artifacts": [dataset_path],
    }


# --------------------------------------------------------------------------- #
# 阶段 4：模型
# --------------------------------------------------------------------------- #


def gate_for(n: int) -> dict:
    if n < GATE_EXPLORE:
        return {"level": "describe", "n": n, "model": False, "explore": False,
                "text": f"n = {n} < {GATE_EXPLORE}：只出预处理、描述统计与质控，不出推断结论。"}
    if n < GATE_MAIN:
        return {"level": "explore", "n": n, "model": False, "explore": True,
                "text": f"n = {n}，在 {GATE_EXPLORE}–{GATE_MAIN - 1} 之间：描述统计 + 探索性比较（明确标探索性），不出主分析。"}
    forced = n < GATE_MAIN_DESIGN
    text = f"n = {n} ≥ {GATE_MAIN}：开主分析（ANCOVA）并给出敏感性分析。"
    if forced:
        text = (f"n = {n} ≥ {GATE_MAIN}：主分析已打开，但样本低于预设门禁 {GATE_MAIN_DESIGN}，"
                f"结论只作探索性参考，不写进论文定论。")
    return {"level": "main", "n": n, "model": True, "explore": True, "forced": forced,
            "text": text}


def descriptives(dataset: pd.DataFrame) -> pd.DataFrame:
    data = dataset[dataset["included"]].copy()
    rows = []
    for value, label in (("AUC", "AUC"), ("lnk", "ln(k)")):
        for cell, group in data.groupby("cell", sort=True):
            for timepoint in ("T0", "T1", "T2"):
                column = f"{value}_{timepoint}"
                if column not in group.columns:
                    continue
                series = group[column].dropna()
                rows.append({
                    "指标": label,
                    "组别": cell,
                    "时间点": timepoint,
                    "n": int(len(series)),
                    "M": fmt(series.mean()),
                    "SD": fmt(series.std(ddof=1)),
                    "中位数": fmt(series.median()),
                    "最小": fmt(series.min()),
                    "最大": fmt(series.max()),
                })
    return pd.DataFrame(rows)


def availability_table(dataset: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for cell, group in dataset.groupby("cell", sort=True):
        rows.append({
            "组别": cell,
            "总人数": int(len(group)),
            "全三时间点": int((group["has_t0"] & group["has_t1"] & group["has_t2"]).sum()),
            "T0+T2": int((group["has_t0"] & group["has_t2"]).sum()),
            "已排除": int(group["excluded"].sum()),
            "缺量表分": int((~group["has_scores"]).sum()),
        })
    total = pd.DataFrame([{
        "组别": "合计",
        "总人数": int(len(dataset)),
        "全三时间点": int((dataset["has_t0"] & dataset["has_t1"] & dataset["has_t2"]).sum()),
        "T0+T2": int((dataset["has_t0"] & dataset["has_t2"]).sum()),
        "已排除": int(dataset["excluded"].sum()),
        "缺量表分": int((~dataset["has_scores"]).sum()),
    }])
    return pd.concat([pd.DataFrame(rows), total], ignore_index=True)


def qc_table(dataset: pd.DataFrame, qc: dict) -> pd.DataFrame:
    rows = [
        {"检查项": "逐试次行数", "值": qc.get("n_trials"), "说明": "应为 人数 × 3 × 60"},
        {"检查项": "无差异点行数", "值": qc.get("n_points"), "说明": "应为 人数 × 3 × 10"},
        {"检查项": "每格不是 6 试次的格", "值": qc.get("bad_cells"), "说明": "0 为正常"},
        {"检查项": "缺失 IP", "值": qc.get("missing_ip"), "说明": "0 为正常"},
        {"检查项": "k 拟合在边界", "值": qc.get("k_at_bound"), "说明": "多说明该被试反应几乎全 SS/LL"},
        {"检查项": "RT 缺失", "值": qc.get("rt_missing"), "说明": ""},
        {"检查项": "RT 非正", "值": qc.get("rt_nonpositive"), "说明": ""},
        {"检查项": "超时试次", "值": qc.get("timeout_trials"), "说明": "4 s 限时后才有"},
        {"检查项": "重复试次", "值": qc.get("duplicated_trials"), "说明": "同一 session 多文件时会露出"},
        {"检查项": "进入分析人数", "值": int(dataset["included"].sum()), "说明": "T0+T2 都有且未排除"},
    ]
    return pd.DataFrame(rows)


def fit_ancova(data: pd.DataFrame, dv: str):
    import statsmodels.formula.api as smf

    formula = f"{dv} ~ C(salience, Sum) * C(intervention, Sum) + {dv.replace('_T2', '_T0')}"
    return smf.ols(formula, data=data).fit()


ANOVA_LABEL = {
    "Intercept": "截距",
    "C(salience, Sum)": "突显",
    "C(intervention, Sum)": "干预",
    "C(salience, Sum):C(intervention, Sum)": "突显 × 干预",
    "AUC_T0": "T0 基线（协变量）",
    "lnk_T0": "T0 基线（协变量）",
    "Residual": "残差",
}


def _rounded(value, digits: int = 4):
    """小到四舍五入会变成 0 的数写成 "<0.001"，不要假装它是零。"""
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return ""
    value = float(value)
    floor = 10 ** -digits
    if value != 0 and abs(value) < floor:
        return f"<{floor:g}"
    return round(value, digits)


def pretty_anova(table: pd.DataFrame) -> pd.DataFrame:
    """三线表版式：中文字段名、四舍五入、partial η² 补齐。"""
    frame = table.copy()
    ss_res = frame.loc["Residual", "sum_sq"]
    frame["partial_eta2"] = frame["sum_sq"] / (frame["sum_sq"] + ss_res)
    frame.loc["Residual", "partial_eta2"] = np.nan
    frame.index.name = "项"
    frame = frame.reset_index()
    frame["项"] = frame["项"].map(lambda term: ANOVA_LABEL.get(term, term))
    frame["sum_sq"] = frame["sum_sq"].map(lambda value: _rounded(value, 4))
    frame["F"] = frame["F"].map(lambda value: _rounded(value, 3))
    frame["PR(>F)"] = frame["PR(>F)"].map(lambda value: _rounded(value, 3))
    frame["partial_eta2"] = frame["partial_eta2"].map(lambda value: _rounded(value, 3))
    frame["df"] = frame["df"].astype("Int64")
    return frame.rename(columns={"sum_sq": "平方和", "df": "df", "F": "F", "PR(>F)": "p", "partial_eta2": "partial η²"})


def anova_row(model, term: str):
    from statsmodels.stats.anova import anova_lm

    table = anova_lm(model, typ=3)
    ss_res = table.loc["Residual", "sum_sq"]
    row = table.loc[term]
    return {
        "df": int(row["df"]),
        "F": float(row["F"]),
        "p": float(row["PR(>F)"]),
        "partial_eta2": float(row["sum_sq"] / (row["sum_sq"] + ss_res)),
    }, table


def ensure_dataset(ctx: dict) -> str:
    """单跑模型/报告阶段时，可能还没合并过：沿用最近一次运行的数据集。"""
    run_dir = ctx["runDir"]
    dataset_path = os.path.join(run_dir, "dataset.csv")
    if os.path.exists(dataset_path):
        return dataset_path
    for meta in iter_run_metas(ctx["runsDir"]):
        other = meta.get("runId")
        if not other or other == ctx["runId"]:
            continue
        candidate = os.path.join(ctx["runsDir"], other, "dataset.csv")
        if os.path.exists(candidate):
            os.makedirs(run_dir, exist_ok=True)
            shutil.copyfile(candidate, dataset_path)
            ctx["reusedDataset"] = other
            return dataset_path
    raise RuntimeError("还没有分析数据集：先跑合并阶段（或点「全部」）")


def stage_model(ctx: dict) -> dict:
    run_dir = ctx["runDir"]
    dataset_path = ensure_dataset(ctx)
    dataset = pd.read_csv(dataset_path, encoding="utf-8-sig", dtype={"subjectid": str, "session": str},
                          keep_default_na=True)
    for column in ("included", "excluded", "has_t0", "has_t1", "has_t2", "has_scores"):
        if column in dataset.columns:
            dataset[column] = dataset[column].fillna(False).astype(bool)

    n = int(dataset["included"].sum())
    gate = gate_for(n)
    gate_warnings = []
    if gate.get("forced"):
        gate_warnings.append(
            f"样本量 n = {n} 未到预设门禁 {GATE_MAIN_DESIGN}：主分析按当前设置提前打开，结果只作探索性参考。")
    tables_dir = os.path.join(run_dir, "tables")
    os.makedirs(tables_dir, exist_ok=True)

    desc = descriptives(dataset)
    avail = availability_table(dataset)
    qc = qc_table(dataset, ctx.get("qc") or {})
    write_csv(os.path.join(tables_dir, "table1_descriptives.csv"), desc)
    write_csv(os.path.join(tables_dir, "table2_availability.csv"), avail)
    write_csv(os.path.join(tables_dir, "table3_qc.csv"), qc)

    result = {
        "stage": "model",
        "gate": gate,
        "n": n,
        "descriptives": desc.to_dict(orient="records"),
        "availability": avail.to_dict(orient="records"),
        "qc": qc.to_dict(orient="records"),
        "main": None,
        "sensitivity": None,
        "exploratory": None,
        "warnings": gate_warnings,
        "artifacts": [os.path.join(tables_dir, name) for name in sorted(os.listdir(tables_dir))],
    }

    data = dataset[dataset["included"]].copy()
    if gate["explore"] and len(data) >= 4:
        # 探索性：T2−T0 的配对变化按格描述（不检验，避免 n 不足时的 p 值误导）
        rows = []
        for cell, group in data.groupby("cell", sort=True):
            delta = (group["AUC_T2"] - group["AUC_T0"]).dropna()
            if len(delta) == 0:
                continue
            rows.append({"组别": cell, "n": int(len(delta)), "ΔM": fmt(delta.mean()), "ΔSD": fmt(delta.std(ddof=1)),
                         "95%CI 下限": fmt(delta.mean() - 1.96 * delta.std(ddof=1) / np.sqrt(len(delta))),
                         "95%CI 上限": fmt(delta.mean() + 1.96 * delta.std(ddof=1) / np.sqrt(len(delta)))})
        if rows:
            delta_table = pd.DataFrame(rows)
            write_csv(os.path.join(tables_dir, "table4_change.csv"), delta_table)
            result["exploratory"] = delta_table.to_dict(orient="records")

    if gate["model"]:
        try:
            import statsmodels.formula.api as smf
            from scipy import stats
            from statsmodels.stats.anova import anova_lm

            model = fit_ancova(data, "AUC_T2")
            interaction, table = anova_row(model, "C(salience, Sum):C(intervention, Sum)")
            anova_out = pretty_anova(table)
            write_csv(os.path.join(tables_dir, "table5_ancova_auc.csv"), anova_out)

            simple = []
            for salience, group in data.groupby("salience"):
                if group["intervention"].nunique() < 2:
                    continue
                sub = smf.ols("AUC_T2 ~ C(intervention) + AUC_T0", data=group).fit()
                sub_table = anova_lm(sub, typ=2)
                simple.append({"效应": f"干预（{salience}）", "F": fmt(sub_table.loc["C(intervention)", "F"]),
                               "p": fmt(sub_table.loc["C(intervention)", "PR(>F)"]), "df_resid": int(sub.df_resid)})
            for intervention, group in data.groupby("intervention"):
                if group["salience"].nunique() < 2:
                    continue
                sub = smf.ols("AUC_T2 ~ C(salience) + AUC_T0", data=group).fit()
                sub_table = anova_lm(sub, typ=2)
                simple.append({"效应": f"突显（{intervention}）", "F": fmt(sub_table.loc["C(salience)", "F"]),
                               "p": fmt(sub_table.loc["C(salience)", "PR(>F)"]), "df_resid": int(sub.df_resid)})
            if simple:
                simple_table = pd.DataFrame(simple)
                write_csv(os.path.join(tables_dir, "table6_simple_effects.csv"), simple_table)

            grid = pd.DataFrame({
                "salience": ["MS", "MS", "DP", "DP"],
                "intervention": ["EFT", "ERT", "EFT", "ERT"],
                "AUC_T0": [round(float(data["AUC_T0"].mean()), 3)] * 4,
            })
            prediction = model.get_prediction(grid).summary_frame(alpha=0.05)
            grid["AUC_T2_adj"] = prediction["mean"].round(3)
            grid["SE"] = prediction["mean_se"].round(3)
            grid["CI_low"] = prediction["mean_ci_lower"].round(3)
            grid["CI_high"] = prediction["mean_ci_upper"].round(3)
            grid = grid.rename(columns={"salience": "突显", "intervention": "干预", "AUC_T0": "T0 基线（总均值）",
                                        "AUC_T2_adj": "调整均值", "CI_low": "95%CI 下限", "CI_high": "95%CI 上限"})
            write_csv(os.path.join(tables_dir, "table7_adjusted_means.csv"), grid)

            lnk_model = fit_ancova(data, "lnk_T2")
            lnk_interaction, lnk_table = anova_row(lnk_model, "C(salience, Sum):C(intervention, Sum)")
            write_csv(os.path.join(tables_dir, "table8_ancova_lnk.csv"), pretty_anova(lnk_table))

            residuals = model.resid
            shapiro_p = float(stats.shapiro(residuals)[1]) if len(residuals) >= 3 else float("nan")
            groups = [group["AUC_T2"].values for _cell, group in data.groupby("cell")]
            levene_p = float(stats.levene(*groups)[1]) if len(groups) >= 2 else float("nan")
            cook = float(model.get_influence().cooks_distance[0].max())

            result["main"] = {
                "model": "AUC_T2 ~ 突显 × 干预 + T0 AUC（Type III，Sum 编码）",
                "n": int(model.nobs),
                "r2": float(model.rsquared),
                "r2_adj": float(model.rsquared_adj),
                "interaction": interaction,
                "simple_effects": simple,
                "adjusted_means": grid.to_dict(orient="records"),
                "assumptions": {"shapiro_p": fmt(shapiro_p), "levene_p": fmt(levene_p), "max_cooks_d": fmt(cook)},
            }
            result["sensitivity"] = {
                "model": "lnk_T2 ~ salience * intervention + lnk_T0",
                "n": int(lnk_model.nobs),
                "interaction": lnk_interaction,
            }
        except Exception as error:  # noqa: BLE001 - 模型失败不该丢掉前面的描述统计
            result["warnings"].append(f"主分析失败：{error}")
            result["main"] = None

    # 报告阶段要读 model.json，所以在这里落盘，而不是等所有阶段结束
    write_json(os.path.join(run_dir, "model.json"), result)
    return result


# --------------------------------------------------------------------------- #
# 阶段 5：报告
# --------------------------------------------------------------------------- #


def make_figures(run_dir: str, dataset: pd.DataFrame) -> list:
    paths = []
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:  # noqa: BLE001
        return paths

    data = dataset[dataset["included"]]
    timepoints = ["T0", "T1", "T2"]
    colors = {"MS": "#C0504D", "DP": "#4F81BD"}
    styles = {"EFT": "-", "ERT": "--"}
    try:
        figure, axis = plt.subplots(figsize=(5.6, 3.8))
        for cell, group in data.groupby("cell", sort=True):
            means, errors = [], []
            for timepoint in timepoints:
                series = group[f"AUC_{timepoint}"].dropna()
                means.append(series.mean() if len(series) else np.nan)
                errors.append(series.std(ddof=1) / np.sqrt(len(series)) if len(series) > 1 else 0)
            salience, intervention = cell.split("×")
            axis.errorbar(timepoints, means, yerr=errors, marker="o", lw=2, ms=6, capsize=3,
                          color=colors.get(salience, "#888"), linestyle=styles.get(intervention, "-"),
                          label=f"{cell} (n={len(group)})")
        axis.set_ylabel("AUC (mean ± SE)")
        axis.set_xlabel("Time point")
        axis.set_ylim(0, 1)
        axis.legend(frameon=False, fontsize=8)
        axis.spines[["top", "right"]].set_visible(False)
        figure.tight_layout()
        path = os.path.join(run_dir, "fig_auc_trajectory.png")
        figure.savefig(path, dpi=200)
        plt.close(figure)
        paths.append(path)

        figure, axis = plt.subplots(figsize=(5.6, 3.8))
        cells = sorted(data["cell"].unique())
        values = [data.loc[data["cell"] == cell, "AUC_T2"].dropna().values for cell in cells]
        if any(len(value) for value in values):
            positions = list(range(1, len(cells) + 1))
            axis.boxplot(values, positions=positions, showfliers=False, widths=0.5,
                         medianprops={"color": "#333"}, boxprops={"color": "#888"}, whiskerprops={"color": "#888"},
                         capprops={"color": "#888"})
            axis.set_xticks(positions)
            axis.set_xticklabels(cells, fontsize=8)
            for index, (cell, value) in enumerate(zip(cells, values), start=1):
                jitter = (np.random.RandomState(7).rand(len(value)) - 0.5) * 0.18
                axis.scatter(np.full(len(value), index) + jitter, value, s=18, alpha=0.7,
                             color=colors.get(cell.split("×")[0], "#888"), zorder=3)
        axis.set_ylabel("AUC at T2")
        axis.set_ylim(0, 1)
        axis.set_xlabel("Cell")
        axis.spines[["top", "right"]].set_visible(False)
        figure.tight_layout()
        path = os.path.join(run_dir, "fig_auc_by_cell.png")
        figure.savefig(path, dpi=200)
        plt.close(figure)
        paths.append(path)
    except Exception:  # noqa: BLE001 - 画图失败不该让整条管子失败
        pass
    return paths


def stage_report(ctx: dict) -> dict:
    run_dir = ctx["runDir"]
    dataset_path = ensure_dataset(ctx)
    tables_dir = os.path.join(run_dir, "tables")
    model_json = os.path.join(run_dir, "model.json")
    if not os.path.exists(model_json) and not (os.path.isdir(tables_dir) and os.listdir(tables_dir)):
        raise RuntimeError("还没有模型结果：先跑模型阶段（或点「全部」）")
    dataset = pd.read_csv(dataset_path, encoding="utf-8-sig", dtype={"subjectid": str})
    for column in ("included", "excluded"):
        dataset[column] = dataset[column].fillna(False).astype(bool)

    tables_dir = os.path.join(run_dir, "tables")
    tables = {}
    if os.path.isdir(tables_dir):
        for name in sorted(os.listdir(tables_dir)):
            if name.endswith(".csv"):
                tables[name[:-4]] = pd.read_csv(os.path.join(tables_dir, name), encoding="utf-8-sig")
    model_path = os.path.join(run_dir, "model.json")
    model = {}
    if os.path.exists(model_path):
        with open(model_path, encoding="utf-8") as fh:
            model = json.load(fh)

    figures = make_figures(run_dir, dataset)
    n = int(dataset["included"].sum())
    gate = model.get("gate") or gate_for(n)

    lines = [
        f"# DDT 分析报告（{ctx['runId']}）",
        "",
        f"- 数据截止：{ctx['dataCutoff']}",
        f"- 进入分析：n = {n}（T0 与 T2 都有且未排除）",
        f"- 排除：{int(dataset['excluded'].sum())} 人" + (
            "（" + "、".join(f"{row['subjectid']} {row['exclude_reason']}" for _, row in dataset[dataset['excluded']].iterrows()) + "）"
            if int(dataset["excluded"].sum()) else ""),
        f"- 门禁：{gate['text']}",
        f"- 脚本：{PIPELINE_VERSION}（{ctx.get('scriptHash', '')[:12]}）",
        *([f"- 注意：样本量低于预设门禁 {GATE_MAIN_DESIGN}，主分析只作探索性参考，不写进论文定论。"]
          if gate.get("forced") else []),
        "",
    ]

    if "table1_descriptives" in tables:
        lines += ["## 表 1 描述统计（AUC / ln(k)）", "", md_table(tables["table1_descriptives"]), ""]
    if "table2_availability" in tables:
        lines += ["## 表 2 数据可用性", "", md_table(tables["table2_availability"]), ""]
    if "table3_qc" in tables:
        lines += ["## 表 3 质控", "", md_table(tables["table3_qc"]), ""]
    if "table4_change" in tables:
        lines += ["## 表 4 T2 − T0 变化（描述）", "", md_table(tables["table4_change"]), ""]
    if model.get("main"):
        main = model["main"]
        interaction = main["interaction"]
        lines += [
            "## 表 5 主分析：AUC_T2 ANCOVA",
            "",
            f"模型：{main['model']}；n = {main['n']}，R² = {main['r2']:.3f}（调整后 {main['r2_adj']:.3f}）。",
            f"关键检验（突显 × 干预）：F({interaction['df']}) = {interaction['F']:.3f}，"
            f"p = {interaction['p']:.3f}，partial η² = {interaction['partial_eta2']:.3f}。",
            "",
        ]
        if "table5_ancova_auc" in tables:
            lines += [md_table(tables["table5_ancova_auc"]), ""]
        if "table6_simple_effects" in tables:
            lines += ["## 表 6 简单效应（均控制 T0 AUC）", "", md_table(tables["table6_simple_effects"]), ""]
        if "table7_adjusted_means" in tables:
            lines += ["## 表 7 调整均值（T0 AUC 固定在总均值）", "", md_table(tables["table7_adjusted_means"]), ""]
        if model.get("sensitivity"):
            sensitivity = model["sensitivity"]["interaction"]
            lines += [
                "## 表 8 敏感性：ln(k)_T2 同一模型",
                "",
                f"F({sensitivity['df']}) = {sensitivity['F']:.3f}，p = {sensitivity['p']:.3f}，"
                f"partial η² = {sensitivity['partial_eta2']:.3f}。",
                "",
            ]
            if "table8_ancova_lnk" in tables:
                lines += [md_table(tables["table8_ancova_lnk"]), ""]
    else:
        lines += [
            "## 主分析",
            "",
            f"{gate['text']}主分析（ANCOVA）按预设门禁未开，报告只含预处理、描述统计与质控。",
            "",
        ]

    if figures:
        lines += ["## 图", ""] + [f"![{os.path.basename(path)}]({os.path.basename(path)})" for path in figures] + [""]

    lines += [
        "## 口径",
        "",
        "- 无差异点：每格第 6 次呈现的即时金额（IP）。",
        "- AUC：按 Myer et al. (2016) 归一化，r = IP / 延迟金额，x = 延迟 / 1825 天，"
        "锚点 (0, 1)，梯形积分，取值 0–1；两档平均。",
        "- k：V = A / (1 + kD)，按档最小二乘，log10(k) ∈ [−7, 2]；ln(k) 取两档平均。",
        "- 排除：只执行 `_lab/exclusions.csv` 里的名单，脚本不自动排除。",
        "",
    ]

    report_path = os.path.join(run_dir, "report.md")
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    three_line = {}
    for name, frame in tables.items():
        three_line[name] = os.path.join(tables_dir, f"{name}.csv")

    return {
        "stage": "report",
        "report": report_path,
        "figures": figures,
        "tables": three_line,
        "artifacts": [report_path] + figures,
    }


# --------------------------------------------------------------------------- #
# 运行与元数据
# --------------------------------------------------------------------------- #


def script_hash() -> str:
    import hashlib

    digest = hashlib.sha256()
    for name in ("ddt.py", "pipeline.py"):
        path = os.path.join(HERE, name)
        if os.path.exists(path):
            with open(path, "rb") as fh:
                digest.update(fh.read())
    return digest.hexdigest()


def next_run_id(runs_dir: str) -> str:
    base = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate, index = base, 1
    while os.path.exists(os.path.join(runs_dir, candidate)):
        index += 1
        candidate = f"{base}-{index}"
    return candidate


def iter_run_metas(runs_dir: str):
    """按目录名倒序（新→旧）读 runs/*/meta.json。"""
    if not os.path.isdir(runs_dir):
        return []
    metas = []
    for name in sorted(os.listdir(runs_dir), reverse=True):
        path = os.path.join(runs_dir, name, "meta.json")
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                metas.append(json.load(fh))
        except (OSError, ValueError):
            continue
    return metas


def previous_meta(runs_dir: str, current: str):
    for meta in iter_run_metas(runs_dir):
        if meta.get("runId") == current:
            continue
        if meta.get("status") == "ok":
            return meta
    return None


def changed_since(meta: dict, previous: dict | None) -> dict:
    if not previous:
        return {"firstRun": True}
    current_ids = set(meta.get("included") or [])
    previous_ids = set(previous.get("included") or [])
    delta = {"newSubjects": sorted(current_ids - previous_ids), "droppedSubjects": sorted(previous_ids - current_ids),
             "nDelta": len(current_ids) - len(previous_ids)}
    current_main = (meta.get("model") or {}).get("interaction")
    previous_main = (previous.get("model") or {}).get("interaction")
    if current_main and previous_main:
        delta["interactionP"] = {"now": current_main.get("p"), "before": previous_main.get("p")}
    return delta


def run_stage(stage: str, ctx: dict) -> dict:
    if stage == "ingest":
        return stage_ingest(ctx)
    if stage == "derive":
        return stage_derive(ctx)
    if stage == "merge":
        return stage_merge(ctx)
    if stage == "model":
        return stage_model(ctx)
    if stage == "report":
        return stage_report(ctx)
    raise ValueError(f"未知阶段：{stage}")


def status_payload(ctx: dict) -> dict:
    lab_dir, cache_dir, runs_dir = ctx["labDir"], ctx["cacheDir"], ctx["runsDir"]
    manifest = load_manifest(cache_dir)
    runs = []
    if os.path.isdir(runs_dir):
        for name in sorted(os.listdir(runs_dir), reverse=True):
            path = os.path.join(runs_dir, name, "meta.json")
            if not os.path.exists(path):
                continue
            try:
                with open(path, encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (OSError, ValueError):
                continue
            runs.append({
                "runId": meta.get("runId", name),
                "startedAt": meta.get("startedAt"),
                "finishedAt": meta.get("finishedAt"),
                "status": meta.get("status"),
                "stages": meta.get("stages"),
                "n": meta.get("n"),
                "dataCutoff": meta.get("dataCutoff"),
                "gate": (meta.get("model") or {}).get("gate", {}).get("level"),
                "changed": meta.get("changedSinceLast"),
            })
            if len(runs) >= 12:
                break
    last = runs[0] if runs else None
    raw_files = list_raw_files(ctx["rawDir"])
    known = set(manifest.get("files", {}).keys())
    new_files = [os.path.basename(path) for path in raw_files if os.path.basename(path) not in known]
    excluded = read_exclusions(lab_dir)
    exclusions = excluded.to_dict(orient="records") if len(excluded) else []
    cache = {
        "trials": os.path.exists(os.path.join(cache_dir, "trials.csv")),
        "auc": os.path.exists(os.path.join(cache_dir, "auc_wide.csv")),
    }
    return {
        "ok": True,
        "lastRun": last,
        "runs": runs,
        "newFiles": new_files,
        "newFileCount": len(new_files),
        "rawFileCount": len(raw_files),
        "cache": cache,
        "exclusions": exclusions,
        "excludedCount": len(exclusions),
        "labDir": lab_dir,
        "rawDir": ctx["rawDir"],
        "python": sys.executable,
        "pipelineVersion": PIPELINE_VERSION,
        "scriptHash": script_hash(),
        "gate": (last or {}).get("gate"),
    }


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser(description="DDT 分析直通管线")
    parser.add_argument("--stage", default="all", choices=STAGES + ["status", "all"])
    parser.add_argument("--project-root", default=r"C:\Users\16787\OneDrive\Desktop\yyh硕士论文")
    parser.add_argument("--lab-dir", default=r"D:\yyh-lab")
    parser.add_argument("--raw-dir", default="")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--run-id", default="")
    args = parser.parse_args(argv)

    lab_dir = os.path.abspath(args.lab_dir)
    raw_dir = os.path.abspath(args.raw_dir or os.path.join(args.project_root, "正式实验数据", "DDT"))
    runs_dir = os.path.join(lab_dir, "runs")
    cache_dir = os.path.join(lab_dir, "cache")
    os.makedirs(runs_dir, exist_ok=True)
    ctx = {
        "projectRoot": os.path.abspath(args.project_root),
        "labDir": lab_dir,
        "rawDir": raw_dir,
        "runsDir": runs_dir,
        "cacheDir": cache_dir,
        "runDir": "",
        "runId": "",
        "dataCutoff": date.today().isoformat(),
        "scriptHash": script_hash(),
    }

    if args.stage == "status":
        payload = status_payload(ctx)
        if args.json:
            print("===JSON===")
            print(json.dumps(payload, ensure_ascii=False))
        else:
            last = payload.get("lastRun")
            print(f"最近一次运行：{last['runId'] + '（n=' + str(last.get('n')) + '）' if last else '还没有'}")
            print(f"新增原始文件：{payload['newFileCount']} 个（共 {payload['rawFileCount']} 个）")
            print(f"缓存：{'有' if payload['cache']['trials'] else '无'} trials / {'有' if payload['cache']['auc'] else '无'} auc")
        return 0

    stages = STAGES if args.stage == "all" else [args.stage]
    run_id = args.run_id or next_run_id(runs_dir)
    run_dir = os.path.join(runs_dir, run_id)
    os.makedirs(run_dir, exist_ok=True)
    ctx.update({"runId": run_id, "runDir": run_dir})

    previous = None
    if args.run_id:
        # 单跑一个阶段：沿用同一个 run 目录，把本次阶段并进去
        previous = next((meta for meta in iter_run_metas(runs_dir) if meta.get("runId") == run_id), None)
    meta = {
        "runId": run_id,
        "startedAt": (previous or {}).get("startedAt") or now_iso(),
        "finishedAt": None,
        "status": "running",
        "stages": [stage for stage in STAGES if stage in set((previous or {}).get("stages", [])).union(stages)],
        "dataCutoff": ctx["dataCutoff"],
        "pipelineVersion": PIPELINE_VERSION,
        "scriptHash": ctx["scriptHash"],
        "python": sys.executable,
        "projectRoot": ctx["projectRoot"],
        "labDir": lab_dir,
        "rawDir": raw_dir,
        "reruns": (previous or {}).get("reruns", []) + [{"at": now_iso(), "stages": stages}],
    }
    for key in ("n", "included", "excluded", "nByCell", "availability", "qc", "model", "report", "figures"):
        if previous and key in previous and key not in meta:
            meta[key] = previous[key]

    results, failures = [], []
    started = time.time()
    for stage in stages:
        stage_started = time.time()
        try:
            payload = run_stage(stage, ctx)
            payload["ms"] = int((time.time() - stage_started) * 1000)
            results.append(payload)
            print(f"[{stage}] {STAGE_LABEL[stage]} 完成（{payload['ms']} ms）")
            if stage in ("derive", "merge") and payload.get("qc"):
                meta["qc"] = payload.get("qc")
                ctx["qc"] = payload.get("qc")
        except Exception as error:  # noqa: BLE001
            failures.append({"stage": stage, "error": str(error), "traceback": traceback.format_exc(limit=4)})
            print(f"[{stage}] 失败：{error}", file=sys.stderr)
            break

    # dataset 已经写进 run 目录；把 n / 排除 / 模型摘要收进 meta
    dataset_path = os.path.join(run_dir, "dataset.csv")
    if os.path.exists(dataset_path):
        dataset = pd.read_csv(dataset_path, encoding="utf-8-sig", dtype={"subjectid": str})
        dataset["included"] = dataset["included"].fillna(False).astype(bool)
        dataset["excluded"] = dataset["excluded"].fillna(False).astype(bool)
        included = dataset[dataset["included"]]
        meta["n"] = int(len(included))
        meta["included"] = included["subjectid"].tolist()
        meta["excluded"] = dataset[dataset["excluded"]][["subjectid", "exclude_reason"]].rename(
            columns={"subjectid": "id", "exclude_reason": "reason"}).to_dict(orient="records")
        meta["nByCell"] = included.groupby("cell").size().to_dict()
        meta["availability"] = {
            "withT1": int(dataset["has_t1"].sum()),
            "withT0T2": int((dataset["has_t0"] & dataset["has_t2"]).sum()),
            "withScores": int(dataset["has_scores"].sum()),
        }
        meta["scoreColumns"] = next((item.get("scores", []) for item in results if item.get("stage") == "merge"), [])
        meta["demographics"] = next((item.get("demographicsColumns", []) for item in results if item.get("stage") == "merge"), [])

    model_json = os.path.join(run_dir, "model.json")
    if os.path.exists(model_json):
        with open(model_json, encoding="utf-8") as fh:
            meta["model"] = json.load(fh)
    else:
        model_result = next((item for item in results if item.get("stage") == "model"), None)
        if model_result:
            write_json(model_json, model_result)
            meta["model"] = {key: model_result[key] for key in ("gate", "n", "main", "sensitivity")}

    report_result = next((item for item in results if item.get("stage") == "report"), None)
    if report_result:
        meta["report"] = report_result["report"]
        meta["figures"] = report_result["figures"]

    manifest = load_manifest(cache_dir)
    meta["inputs"] = {
        name: {"mtime": entry.get("mtime"), "size": entry.get("size"), "sha256": entry.get("sha256"),
               "session": entry.get("session")}
        for name, entry in manifest.get("files", {}).items()
    }
    meta["status"] = "ok" if not failures else "failed"
    meta["failures"] = failures
    meta["finishedAt"] = now_iso()
    meta["ms"] = int((time.time() - started) * 1000)
    meta["warnings"] = [warning for item in results for warning in item.get("warnings", [])]
    meta["changedSinceLast"] = changed_since(meta, previous_meta(runs_dir, run_id))
    merged_results = {item.get("stage"): item for item in (previous or {}).get("results", []) if item.get("stage")}
    merged_results.update({item["stage"]: item for item in results})
    meta["results"] = [{key: value for key, value in merged_results[stage].items() if key != "artifacts"}
                       for stage in STAGES if stage in merged_results]

    write_json(os.path.join(run_dir, "meta.json"), meta)

    payload = {
        "ok": not failures,
        "runId": run_id,
        "runDir": run_dir,
        "stages": [item["stage"] for item in results],
        "n": meta.get("n"),
        "gate": (meta.get("model") or {}).get("gate"),
        "report": meta.get("report"),
        "failures": failures,
        "ms": meta["ms"],
        "changed": meta["changedSinceLast"],
        "tables": [os.path.join("tables", name) for name in sorted(os.listdir(os.path.join(run_dir, "tables")))
                   if name.endswith(".csv")] if os.path.isdir(os.path.join(run_dir, "tables")) else [],
        "summaryText": summary_text(meta),
    }
    if args.json:
        print("===JSON===")
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(payload["summaryText"])
    return 0 if not failures else 1


def write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def summary_text(meta: dict) -> str:
    gate = (meta.get("model") or {}).get("gate") or {}
    lines = [
        f"运行 {meta['runId']}：{'完成' if meta.get('status') == 'ok' else '有失败'}（{meta.get('ms', 0)} ms）",
        f"n = {meta.get('n', 0)}，数据截止 {meta.get('dataCutoff')}",
        f"门禁：{gate.get('text', '未跑模型阶段')}",
    ]
    by_cell = meta.get("nByCell") or {}
    if by_cell:
        lines.append("分组：" + "，".join(f"{cell} {count} 人" for cell, count in sorted(by_cell.items())))
    changed = meta.get("changedSinceLast") or {}
    if changed.get("newSubjects"):
        lines.append("新增被试：" + "、".join(changed["newSubjects"]))
    if changed.get("droppedSubjects"):
        lines.append("退出分析：" + "、".join(changed["droppedSubjects"]))
    main = (meta.get("model") or {}).get("main")
    if main:
        interaction = main["interaction"]
        lines.append(f"主分析：突显×干预 F({interaction['df']}) = {interaction['F']:.3f}，"
                     f"p = {interaction['p']:.3f}，partial η² = {interaction['partial_eta2']:.3f}")
    if meta.get("excluded"):
        lines.append("排除：" + "；".join(f"{item['id']} {item['reason']}" for item in meta["excluded"]))
    if meta.get("failures"):
        lines.append("失败：" + "；".join(f"{item['stage']}: {item['error']}" for item in meta["failures"]))
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
