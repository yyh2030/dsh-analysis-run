# -*- coding: utf-8 -*-
"""DDT 原始数据解析与推导。

这一层只做两件事，口径与 `03_延迟折扣任务与代码/Codes/ddt_extract_rt.py`、
`ddt_preprocess.py`、`ddt_primary_analysis.py` 保持一致，改动必须同步改版本号：

1. parse_file：一份 PsychoPy 原始 CSV → 逐试次长表。
2. derive_auc_k：无差异点 → 归一化 AUC（Myer et al., 2016）与 k。

原始 CSV 只读；本模块不写任何文件。
"""

from __future__ import annotations

import hashlib
import os
import re

import numpy as np
import pandas as pd

VERSION = "ddt/1.0.0"

SESSION_LABEL = {"001": "T0", "002": "T1", "003": "T2"}
SESSION_ORDER = {"T0": 0, "T1": 1, "T2": 2}

# Delay_Time 文本 -> 天数（与 R 脚本 parse_delay 一致）
DELAY_DAYS = {
    "1天后": 1.0,
    "1个月后": 30.0,
    "6个月后": 180.0,
    "1年后": 365.0,
    "一年后": 365.0,
    "5年后": 1825.0,
}

TIERS = [100.0, 2000.0]  # 延迟金额的两个档（小 / 大）
TIER_TAG = {100.0: "s", 2000.0: "l"}
MAX_DELAY = 1825.0
# (block 序号, 例程名, 即时按钮前缀, 延迟按钮前缀)
BLOCKS = [
    (1, "trails1", "button_now", "button_later"),
    (2, "trails1_2", "button_now_3", "button_later_3"),
]

TRIAL_COLUMNS = [
    "subjectid",
    "session",
    "session_label",
    "block",
    "cell",
    "trial_in_cell",
    "trial",
    "delay_text",
    "delayLL",
    "amountSS",
    "amountLL",
    "choice",
    "rt",
    "n_timeouts",
    "timed_out",
    "first_trial_of_block",
    "source_file",
]


class ParseError(RuntimeError):
    """原始文件读不出任何试次。"""


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _first_number(value):
    """PsychoPy 把 Button 的 timesOn/timesOff 存成 '[[2.957]]'，取第一个数。"""
    if isinstance(value, (int, float, np.floating)) and not pd.isna(value):
        return float(value)
    if isinstance(value, str):
        nums = re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", value)
        if nums:
            return float(nums[0])
    return np.nan


def _pick(columns, name: str) -> str:
    """取列名：优先精确匹配；2026-10 版程序里按钮列被 Loop 加了前缀（retry1./delays_1.）。"""
    if name in columns:
        return name
    for column in columns:
        if column.endswith("." + name):
            return column
    return name


def parse_file(path: str) -> dict:
    """一份原始 CSV → 逐试次长表。

    返回 {"trials": DataFrame, "meta": {...}}；文件里没有任何有效试次时抛 ParseError。
    """
    frame = pd.read_csv(path, encoding="utf-8-sig", dtype=str, keep_default_na=False)
    frame = frame.replace({"": np.nan})
    columns = list(frame.columns)

    def first(name):
        column = _pick(columns, name)
        if column in frame.columns:
            series = frame[column].dropna()
            if len(series):
                return series.iloc[0]
        return np.nan

    subject = first("participant")
    if pd.isna(subject):
        subject = os.path.basename(path).split("_")[0]
    subject = str(subject).strip()
    session = str(first("session") or "").strip()
    if session.isdigit():
        session = session.zfill(3)

    parts = []
    for block_id, routine, now_prefix, later_prefix in BLOCKS:
        start_col = _pick(columns, f"{routine}.started")
        stop_col = _pick(columns, f"{routine}.stopped")
        if start_col not in frame.columns:
            continue

        sub = frame[frame[start_col].notna()]
        if sub.empty:
            continue

        rt = pd.to_numeric(sub[stop_col], errors="coerce") - pd.to_numeric(sub[start_col], errors="coerce")
        choice = pd.to_numeric(sub[_pick(columns, f"{later_prefix}.numClicks")], errors="coerce")
        amount_ss = pd.to_numeric(sub[_pick(columns, "button_now_1.reward")], errors="coerce")
        amount_ll = pd.to_numeric(sub[_pick(columns, "button_later_1.reward")], errors="coerce")

        # 只有"有金额记录"的呈现才是真正作答的试次；超时呈现没有金额。
        answered = amount_ss.notna().values
        keep = pd.DataFrame(
            {
                "delay_text": sub["Delay_Time"].values if "Delay_Time" in sub.columns else np.nan,
                "amountSS": amount_ss.values,
                "amountLL": amount_ll.values,
                "choice_LL": choice.values,
                "rt": np.round(rt.values, 4),
            }
        )[answered].reset_index(drop=True)
        if keep.empty:
            continue

        counts, pending = [], 0
        for flag in answered:
            if flag:
                counts.append(pending)
                pending = 0
            else:
                pending += 1

        timeout_col = _pick(columns, "n_timeouts")
        if timeout_col in sub.columns:
            program = pd.to_numeric(sub[timeout_col], errors="coerce")
            if program.notna().any():
                keep["n_timeouts"] = pd.Series(program.values[answered]).fillna(0).astype(int).values
        if "n_timeouts" not in keep.columns:
            keep["n_timeouts"] = counts[: len(keep)]

        keep["subjectid"] = subject
        keep["session"] = session
        keep["block"] = block_id
        keep["trial_in_block"] = np.arange(1, len(keep) + 1)
        keep["first_trial_of_block"] = keep["trial_in_block"] == 1
        keep["timed_out"] = (keep["n_timeouts"] > 0).astype(int)
        keep["delayLL"] = keep["delay_text"].map(DELAY_DAYS)
        keep["choice"] = keep["choice_LL"].astype(int)
        parts.append(keep)

    if not parts:
        raise ParseError(f"{os.path.basename(path)} 里没有可用试次（两个 block 都没跑或列名不对）")

    trials = pd.concat(parts, ignore_index=True).sort_values(["block", "trial_in_block"]).reset_index(drop=True)
    trials["source_file"] = os.path.basename(path)

    # 每格 6 次连续呈现：按 block 内 delay_text 的连续段切 cell
    cells = []
    for _block, group in trials.groupby("block", sort=False):
        seg = (group["delay_text"] != group["delay_text"].shift()).cumsum()
        cells.append(seg.astype(int))
    trials["cell"] = pd.concat(cells).sort_index().values
    trials["trial_in_cell"] = trials.groupby(["block", "cell"]).cumcount() + 1
    trials["trial"] = np.arange(1, len(trials) + 1)
    trials["session_label"] = trials["session"].map(SESSION_LABEL)

    meta = {
        "subject": subject,
        "session": session,
        "date": None if pd.isna(first("date")) else str(first("date")),
        "expStart": None if pd.isna(first("expStart")) else str(first("expStart")),
        "n_trials": int(len(trials)),
        "complete_cells": int((trials.groupby(["block", "cell"]).size() == 6).sum()),
    }
    return {"trials": trials[TRIAL_COLUMNS], "meta": meta}


def indifference_points(trials: pd.DataFrame) -> pd.DataFrame:
    """每格无差异点：第 6 次呈现的即时金额（IP）。"""
    keys = ["subjectid", "session", "session_label", "block", "cell", "delay_text", "delayLL"]
    info = (
        trials.groupby(keys, dropna=False)
        .agg(amountLL=("amountLL", "first"), n_trials_in_cell=("trial", "size"))
        .reset_index()
    )
    last = trials[trials["trial_in_cell"] == 6][
        ["subjectid", "session", "block", "cell", "amountSS"]
    ].rename(columns={"amountSS": "IP"})
    points = info.merge(last, on=["subjectid", "session", "block", "cell"], how="left")
    points["IP"] = points["IP"].round(2)
    return points.sort_values(["subjectid", "session", "block", "cell"]).reset_index(drop=True)


def auc_myer(delays, ips, amount_ll) -> float:
    """归一化 AUC（含 delay=0 处 r=1 的锚点）。越大 = 折扣越弱。"""
    delays = np.asarray(delays, dtype=float)
    ratios = np.asarray(ips, dtype=float) / amount_ll
    x = np.concatenate([[0.0], delays / MAX_DELAY])
    y = np.concatenate([[1.0], ratios])
    return float(np.sum(np.diff(x) * (y[:-1] + y[1:]) / 2))


def fit_k(delays, ips, amount_ll):
    """拟合 k：min Σ(IP − A/(1+kD))²，在 log10(k) ∈ [−7, 2] 上搜索。"""
    from scipy.optimize import minimize_scalar

    delays = np.asarray(delays, dtype=float)
    values = np.asarray(ips, dtype=float)

    def sse(log_k):
        k = 10 ** log_k
        return float(np.sum((values - amount_ll / (1 + k * delays)) ** 2))

    result = minimize_scalar(sse, bounds=(-7, 2), method="bounded")
    k = 10 ** result.x
    at_bound = bool(result.x <= -6.99 or result.x >= 1.99)
    return k, at_bound, int(result.nfev)


def derive_auc_k(points: pd.DataFrame) -> pd.DataFrame:
    """无差异点 → 每被试每时间点一行（AUC_s / AUC_l / AUC / k_s / k_l / lnk）。"""
    points = points.sort_values(["subjectid", "session", "amountLL", "delayLL"])
    rows = []
    for (subject, session), group in points.groupby(["subjectid", "session"], sort=True):
        row = {"subjectid": subject, "session": session, "session_label": group["session_label"].iloc[0]}
        complete = True
        for amount_ll in TIERS:
            tier = group[group["amountLL"] == amount_ll].sort_values("delayLL").dropna(subset=["IP"])
            tag = TIER_TAG[amount_ll]
            if len(tier) < 2:
                complete = False
                row[f"AUC_{tag}"] = np.nan
                row[f"k_{tag}"] = np.nan
                row[f"k_{tag}_bound"] = False
                continue
            row[f"AUC_{tag}"] = auc_myer(tier["delayLL"], tier["IP"], amount_ll)
            k, bound, _n = fit_k(tier["delayLL"], tier["IP"], amount_ll)
            row[f"k_{tag}"] = k
            row[f"k_{tag}_bound"] = bound
        if complete and not (np.isnan(row.get("AUC_s", np.nan)) or np.isnan(row.get("AUC_l", np.nan))):
            row["AUC"] = (row["AUC_s"] + row["AUC_l"]) / 2
            row["lnk"] = float(np.mean([np.log(row["k_s"]), np.log(row["k_l"])]))
        else:
            row["AUC"] = np.nan
            row["lnk"] = np.nan
        rows.append(row)
    out = pd.DataFrame(rows)
    out["session_order"] = out["session_label"].map(SESSION_ORDER)
    return out.sort_values(["subjectid", "session_order"]).reset_index(drop=True)


def wide_by_subject(per_session: pd.DataFrame) -> pd.DataFrame:
    """每被试一行：AUC_/lnk_/k_ 的 T0/T1/T2 宽表 + 分组。"""
    values = ["AUC", "AUC_s", "AUC_l", "lnk", "k_s", "k_l"]
    wide = per_session.pivot(index="subjectid", columns="session_label", values=values)
    wide.columns = [f"{value}_{timepoint}" for value, timepoint in wide.columns]
    wide = wide.reset_index()
    for timepoint in ["T0", "T1", "T2"]:
        for value in values:
            column = f"{value}_{timepoint}"
            if column not in wide.columns:
                wide[column] = np.nan
    wide["salience"] = wide["subjectid"].str[0].map({"1": "MS", "2": "DP"})
    wide["intervention"] = wide["subjectid"].str[1].map({"1": "EFT", "2": "ERT"})
    wide["cell"] = wide["salience"].fillna("?") + "×" + wide["intervention"].fillna("?")
    return wide


def qc_summary(trials: pd.DataFrame, points: pd.DataFrame, per_session: pd.DataFrame) -> dict:
    """质控：每格 6 试次、缺失 IP、k 在边界、RT 非正、超时。"""
    cell_sizes = trials.groupby(["subjectid", "session", "block", "cell"]).size()
    bad_cells = int((cell_sizes != 6).sum())
    missing_ip = int(points["IP"].isna().sum()) if len(points) else 0
    k_bound = 0
    if len(per_session):
        for _tag in ("s", "l"):
            column = f"k_{_tag}_bound"
            if column in per_session.columns:
                k_bound += int(per_session[column].fillna(False).astype(bool).sum())
    return {
        "n_trials": int(len(trials)),
        "n_points": int(len(points)),
        "bad_cells": bad_cells,
        "missing_ip": missing_ip,
        "k_at_bound": k_bound,
        "rt_missing": int(trials["rt"].isna().sum()),
        "rt_nonpositive": int((trials["rt"] <= 0).sum()),
        "timeout_trials": int((trials["timed_out"] == 1).sum()),
        "timeout_retries": int(trials["n_timeouts"].sum()),
        "n_subjects": int(trials["subjectid"].nunique()),
        "n_sessions": int(trials.groupby(["subjectid", "session"]).ngroups),
        "duplicated_trials": int(
            trials.duplicated(subset=["subjectid", "session", "block", "delay_text", "trial_in_cell"]).sum()
        ),
    }
