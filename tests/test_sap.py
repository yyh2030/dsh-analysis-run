# -*- coding: utf-8 -*-
"""sap.py 的单元测试：信度、反向计分、非系统折扣分级。"""

import os
import sys
import unittest

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import sap  # noqa: E402


class ReliabilityTest(unittest.TestCase):
    def test_alpha_perfect_consistency(self):
        column = [1, 2, 3, 4, 5, 6, 7, 8]
        frame = pd.DataFrame({"q01": column, "q02": column})
        self.assertAlmostEqual(sap.cronbach_alpha(frame), 1.0, places=6)

    def test_alpha_no_consistency(self):
        rng = np.random.RandomState(1)
        frame = pd.DataFrame({"q01": rng.randn(200), "q02": rng.randn(200)})
        self.assertLess(sap.cronbach_alpha(frame), 0.3)


class ReverseScoringTest(unittest.TestCase):
    def test_reverse_uses_min_plus_max(self):
        definition = {
            "response": {"min": 1, "max": 7},
            "items": [{"no": 8, "reverse": True}, {"no": 1, "reverse": False}],
        }
        items = pd.DataFrame({"q01": [1, 7], "q08": [1, 7]})
        scored = sap.score_items(items, definition)
        self.assertEqual(scored["q08"].tolist(), [7, 1])
        self.assertEqual(scored["q01"].tolist(), [1, 7])


def synthetic_points(violations: int, subject="11002", session="001", tiers=(100.0, 2000.0)):
    """每档 5 个延迟；按需构造指定数量的「IP 上跳」。"""
    delays = [1.0, 30.0, 180.0, 365.0, 1825.0]
    base = [90.0, 70.0, 50.0, 40.0, 30.0]
    rows = []
    for amount in tiers:
        values = list(base)
        for index in range(violations):
            position = 1 + index * 2
            if position < len(values):
                values[position] = values[position - 1] + 0.5 * amount
        for delay, ip in zip(delays, values):
            rows.append({"subjectid": subject, "session": session, "amountLL": amount,
                         "delayLL": delay, "IP": ip})
    return pd.DataFrame(rows)


class NonsystematicTest(unittest.TestCase):
    def test_one_violation_is_minor(self):
        # 只有一个档出现一次反转：整个 session 记「轻微」
        points = synthetic_points(violations=1, tiers=(100.0,))
        table, flagged, meta = sap.nonsystematic_table(points, pd.DataFrame({"subjectid": ["11002"]}))
        self.assertEqual(flagged, [])
        self.assertEqual(meta["minor"], 1)
        self.assertIn("轻微", table["标记"].tolist())

    def test_two_violations_is_definite(self):
        points = synthetic_points(violations=2)
        _table, flagged, meta = sap.nonsystematic_table(points, pd.DataFrame({"subjectid": ["11002"]}))
        self.assertEqual(flagged, ["11002"])
        self.assertEqual(meta["flagged"], 1)


if __name__ == "__main__":
    unittest.main()
