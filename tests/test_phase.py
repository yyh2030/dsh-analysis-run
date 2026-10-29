# -*- coding: utf-8 -*-
"""phase.py 的多重比较校正与对比定义的单元测试。"""

import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import phase  # noqa: E402


class MultipleComparisonTest(unittest.TestCase):
    def test_bh_step_up(self):
        adjusted = phase.bh([0.001, 0.005, 0.02, 0.5])
        expected = [0.004, 0.01, 0.02 * 4 / 3, 0.5]
        np.testing.assert_allclose(adjusted, expected, rtol=1e-12)

    def test_holm(self):
        adjusted = phase.holm([0.001, 0.005, 0.02, 0.5])
        expected = [0.004, 0.015, 0.04, 0.5]
        np.testing.assert_allclose(adjusted, expected, rtol=1e-12)

    def test_p_text_is_numeric_zero(self):
        self.assertEqual(phase._num("<0.001"), 0.0)
        self.assertTrue(np.isnan(phase._num("")))


class ContrastDefinitionTest(unittest.TestCase):
    """在合成数据上验证：interaction 就是 (EFT−ERT)MS − (EFT−ERT)DP。

    四格均值：DP/ERT=0，DP/EFT=0.2，MS/ERT=0.1，MS/EFT=0.3。
    则 (EFT−ERT)MS = 0.2，(EFT−ERT)DP = 0.2，交互 = 0；(MS−DP) 等权 = 0.1。
    """

    def test_interaction_equals_difference_of_differences(self):
        import pandas as pd

        rows = []
        for salience, base, effect in (("DP", 0.0, 0.2), ("MS", 0.1, 0.2)):
            for intervention, applied in (("ERT", 0.0), ("EFT", effect)):
                for repeat in range(4):
                    rows.append({
                        "subjectid": f"{salience}{intervention}{repeat}",
                        "salience": salience,
                        "intervention": intervention,
                        "AUC_T0": 0.5,
                        "AUC_T2": base + applied + repeat * 0.01,
                    })
        data = pd.DataFrame(rows)
        _model, block = phase.fit_contrasts("synthetic", f"AUC_T2 ~ {phase.FAC} + AUC_T0", data,
                                            ["interaction", "EFT-ERT_DP", "EFT-ERT_MS", "MS-DP_equal"])
        table = {row["效应"]: row["估计"] for row in block}
        self.assertAlmostEqual(table["EFT-ERT_DP"], 0.2, places=6)
        self.assertAlmostEqual(table["EFT-ERT_MS"], 0.2, places=6)
        self.assertAlmostEqual(table["interaction"], 0.0, places=6)
        # MS−DP 等权平均 = (0.1 + 0.1)/2 = 0.1
        self.assertAlmostEqual(table["MS-DP_equal"], 0.1, places=6)


if __name__ == "__main__":
    unittest.main()
