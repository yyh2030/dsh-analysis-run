# -*- coding: utf-8 -*-
"""ddt.py 的单元测试：口径一旦改动，这里先红。

跑法（在插件目录）：
    <pythonPath> -m unittest discover -s tests -v
"""

import os
import sys
import unittest

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import ddt  # noqa: E402

LEGACY_WIDE = r"C:\Users\16787\OneDrive\Desktop\yyh硕士论文\正式实验数据\DDT\analysis\DDT_AUC_wide.csv"
CACHE_WIDE = r"D:\yyh-lab\cache\auc_wide.csv"


DELAYS = [("1天后", 1.0), ("1个月后", 30.0), ("6个月后", 180.0), ("1年后", 365.0), ("5年后", 1825.0)]


def synthetic_cells(subject="11002", session="001", amounts=(100.0, 2000.0), ip=50.0):
    """两个 block × 5 个延迟 × 6 次呈现的合成试次，第 6 次金额为 ip。"""
    rows = []
    for block, amount in enumerate(amounts, start=1):
        cell = 0
        for delay_text, delay in DELAYS:
            cell += 1
            for trial_in_cell in range(1, 7):
                rows.append({
                    "subjectid": subject,
                    "session": session,
                    "session_label": ddt.SESSION_LABEL[session],
                    "block": block,
                    "cell": cell,
                    "trial_in_cell": trial_in_cell,
                    "trial": len(rows) + 1,
                    "delay_text": delay_text,
                    "delayLL": delay,
                    "amountSS": ip if trial_in_cell == 6 else 10.0,
                    "amountLL": amount,
                    "choice": 0,
                    "rt": 1.0,
                    "n_timeouts": 0,
                    "timed_out": 0,
                    "first_trial_of_block": trial_in_cell == 1,
                    "source_file": "synthetic.csv",
                })
    return pd.DataFrame(rows)


class IndifferencePointTest(unittest.TestCase):
    def test_takes_sixth_presentation(self):
        trials = synthetic_cells(ip=42.5)
        points = ddt.indifference_points(trials)
        self.assertEqual(len(points), 10)
        self.assertTrue((points["IP"] == 42.5).all())

    def test_missing_sixth_is_nan(self):
        trials = synthetic_cells()
        trials = trials[~((trials["block"] == 1) & (trials["cell"] == 1) & (trials["trial_in_cell"] == 6))]
        points = ddt.indifference_points(trials)
        missing = points[(points["block"] == 1) & (points["cell"] == 1)]
        self.assertEqual(len(missing), 1)
        self.assertTrue(pd.isna(missing["IP"].iloc[0]))


class AucTest(unittest.TestCase):
    def test_matches_trapezoid(self):
        delays = np.array([1.0, 30.0, 180.0, 365.0, 1825.0])
        ips = np.array([95.0, 80.0, 55.0, 40.0, 10.0])
        x = np.concatenate([[0.0], delays / ddt.MAX_DELAY])
        y = np.concatenate([[1.0], ips / 100.0])
        expected = float(np.trapezoid(y, x))
        self.assertAlmostEqual(ddt.auc_myer(delays, ips, 100.0), expected, places=12)

    def test_bounds(self):
        delays = np.array([1.0, 30.0, 180.0, 365.0, 1825.0])
        # 全选 SS：只有 (0,1) → (1 天, 0) 那一小段面积
        self.assertAlmostEqual(ddt.auc_myer(delays, np.zeros(5), 100.0), 0.5 / ddt.MAX_DELAY, places=12)
        # 全选 LL：处处 r = 1，面积 = 1
        self.assertAlmostEqual(ddt.auc_myer(delays, np.full(5, 100.0), 100.0), 1.0, places=12)


class KFitTest(unittest.TestCase):
    def test_recovers_known_k(self):
        true_k = 0.01
        delays = np.array([1.0, 30.0, 180.0, 365.0, 1825.0])
        ips = 100.0 / (1 + true_k * delays)
        k, at_bound, _n = ddt.fit_k(delays, ips, 100.0)
        self.assertFalse(at_bound)
        self.assertAlmostEqual(k, true_k, delta=true_k * 0.02)

    def test_flat_response_hits_bound(self):
        delays = np.array([1.0, 30.0, 180.0, 365.0, 1825.0])
        k, at_bound, _n = ddt.fit_k(delays, np.full(5, 100.0), 100.0)
        self.assertTrue(at_bound)
        self.assertLess(k, 1e-5)


class WideTest(unittest.TestCase):
    def test_groups_from_digits(self):
        per_session = pd.DataFrame({
            "subjectid": ["11002", "11002", "21007", "21007"],
            "session": ["001", "003", "001", "003"],
            "session_label": ["T0", "T2", "T0", "T2"],
            "AUC": [0.4, 0.5, 0.6, 0.7],
            "AUC_s": [0.4, 0.5, 0.6, 0.7],
            "AUC_l": [0.4, 0.5, 0.6, 0.7],
            "lnk": [-5.0, -5.5, -6.0, -6.5],
            "k_s": [1e-2, 2e-2, 1e-2, 2e-2],
            "k_l": [1e-2, 2e-2, 1e-2, 2e-2],
        })
        wide = ddt.wide_by_subject(per_session).set_index("subjectid")
        self.assertEqual(wide.loc["11002", "salience"], "MS")
        self.assertEqual(wide.loc["11002", "intervention"], "EFT")
        self.assertEqual(wide.loc["21007", "salience"], "DP")
        self.assertEqual(wide.loc["21007", "intervention"], "EFT")
        self.assertAlmostEqual(wide.loc["11002", "AUC_T2"], 0.5)
        self.assertTrue(pd.isna(wide.loc["11002", "AUC_T1"]))


@unittest.skipUnless(os.path.exists(LEGACY_WIDE) and os.path.exists(CACHE_WIDE),
                     "没有历史分析输出或缓存，跳过对拍")
class LegacyMatchTest(unittest.TestCase):
    def test_auc_and_lnk_match_legacy(self):
        old = pd.read_csv(LEGACY_WIDE, dtype={"subjectid": str}).set_index("subjectid")
        new = pd.read_csv(CACHE_WIDE, dtype={"subjectid": str}).set_index("subjectid")
        common = sorted(set(old.index) & set(new.index))
        self.assertGreater(len(common), 0)
        for column in ("AUC_T0", "AUC_T1", "AUC_T2", "lnk_T0", "lnk_T1", "lnk_T2"):
            diff = (old.loc[common, column] - new.loc[common, column]).abs().max()
            self.assertLess(diff, 1e-9, f"{column} 与历史输出不一致（{diff}）")


if __name__ == "__main__":
    unittest.main()
