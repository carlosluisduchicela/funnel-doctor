import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import funnel  # noqa: E402


class TestConversionMath(unittest.TestCase):
    def test_step_and_cumulative_conversion(self):
        stats = funnel.step_stats([1000, 500, 100])
        self.assertEqual(stats[0]["step_conv"], 1.0)
        self.assertEqual(stats[0]["cumulative"], 1.0)
        self.assertAlmostEqual(stats[1]["step_conv"], 0.5)
        self.assertAlmostEqual(stats[1]["cumulative"], 0.5)
        self.assertAlmostEqual(stats[2]["step_conv"], 0.2)
        self.assertAlmostEqual(stats[2]["cumulative"], 0.1)
        self.assertEqual(stats[1]["lost"], 500)
        self.assertEqual(stats[2]["lost"], 400)

    def test_zero_previous_step_does_not_divide_by_zero(self):
        stats = funnel.step_stats([100, 0, 0])
        self.assertEqual(stats[2]["step_conv"], 0.0)


class TestDropOff(unittest.TestCase):
    def test_picks_the_right_step(self):
        # Both relative loss and absolute loss are largest at C.
        steps = ["A", "B", "C", "D"]
        step, idx = funnel.biggest_drop(steps, [1000, 900, 300, 270])
        self.assertEqual(step, "C")
        self.assertEqual(idx, 2)

    def test_lowest_conversion_wins_over_absolute_loss(self):
        # Visit->Signup loses the most people, Paid loses the largest share.
        steps = ["Visit", "Signup", "Paid"]
        step, _ = funnel.biggest_drop(steps, [10000, 5000, 500])
        self.assertEqual(step, "Paid")


class TestZTest(unittest.TestCase):
    def test_flags_a_known_large_gap(self):
        # 50% vs 80% conversion on large samples must be significant.
        _, p = funnel.two_proportion_ztest(1600, 3200, 1120, 1400)
        self.assertLess(p, 0.05)

    def test_does_not_flag_a_tiny_gap(self):
        # 50.0% vs 50.5% on modest samples must not be significant.
        _, p = funnel.two_proportion_ztest(500, 1000, 505, 1000)
        self.assertGreaterEqual(p, 0.05)

    def test_segment_comparisons_flag_sample_gap(self):
        steps = ["Visit", "Signup"]
        series = {"free": [8000, 3200], "pro": [2000, 1400]}
        comps = funnel.segment_comparisons(steps, series)
        self.assertEqual(len(comps), 1)
        self.assertTrue(comps[0]["significant"])


class TestParsing(unittest.TestCase):
    def test_two_column_format(self):
        steps, series = funnel.parse_csv_text("step,users\nA,100\nB,50\n")
        self.assertEqual(steps, ["A", "B"])
        self.assertEqual(series["all"], [100, 50])

    def test_three_column_format(self):
        steps, series = funnel.parse_csv_text(
            "step,segment,users\nA,free,100\nA,pro,40\nB,free,50\nB,pro,30\n")
        self.assertEqual(steps, ["A", "B"])
        self.assertEqual(series["free"], [100, 50])
        self.assertEqual(series["pro"], [40, 30])

    def test_bad_number_raises(self):
        with self.assertRaises(ValueError):
            funnel.parse_csv_text("step,users\nA,many\nB,50\n")

    def test_sample_files_parse_and_report(self):
        here = os.path.join(os.path.dirname(__file__), "..", "sample")
        for name in ("funnel.csv", "funnel_segments.csv"):
            steps, series = funnel.load_csv(os.path.join(here, name))
            report = funnel.build_report(steps, series)
            self.assertIn("Biggest drop-off", report)
            self.assertIn("Diagnosis", report)


if __name__ == "__main__":
    unittest.main()
