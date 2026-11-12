#!/usr/bin/env python3
"""funnel-doctor: analyse a funnel CSV and print a markdown diagnosis report.

Standard library only. See README.md for the input format.

Usage:
    python3 funnel.py sample/funnel.csv
    python3 funnel.py sample/funnel_segments.csv --out report.md
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from collections import OrderedDict


# ---------------------------------------------------------------- parsing

def parse_csv_text(text):
    """Parse funnel CSV text.

    Accepted formats (header row required):
        step,users
        step,segment,users

    Returns (steps, series) where ``series`` is an OrderedDict mapping a
    segment name (or "all" for the 2-column format) to a list of user
    counts aligned with ``steps``.
    """
    reader = csv.reader([ln for ln in text.splitlines() if ln.strip()])
    rows = list(reader)
    if not rows:
        raise ValueError("empty CSV")
    header = [h.strip().lower() for h in rows[0]]
    if header[:1] != ["step"]:
        raise ValueError("first column must be 'step'")
    has_segment = len(header) >= 3 and header[1] == "segment"
    if not has_segment and not (len(header) >= 2 and header[1] == "users"):
        raise ValueError("expected columns 'step,users' or 'step,segment,users'")

    steps = []
    series = OrderedDict()
    for line_no, row in enumerate(rows[1:], start=2):
        if len(row) < (3 if has_segment else 2):
            raise ValueError(f"line {line_no}: not enough columns")
        step = row[0].strip()
        if not step:
            raise ValueError(f"line {line_no}: empty step name")
        if has_segment:
            segment = row[1].strip()
            raw = row[2].strip()
        else:
            segment = "all"
            raw = row[1].strip()
        try:
            users = int(float(raw.replace(",", "")))
        except ValueError:
            raise ValueError(f"line {line_no}: users value {raw!r} is not a number")
        if users < 0:
            raise ValueError(f"line {line_no}: users must be >= 0")
        if step not in steps:
            steps.append(step)
        idx = steps.index(step)
        bucket = series.setdefault(segment, [None] * 64)
        if len(bucket) <= idx:
            bucket.extend([None] * (idx - len(bucket) + 1))
        bucket[idx] = users
    for segment, counts in series.items():
        counts = counts[: len(steps)]
        if any(c is None for c in counts):
            raise ValueError(f"segment {segment!r} is missing a count for some step")
        series[segment] = counts
    if len(steps) < 2:
        raise ValueError("a funnel needs at least 2 steps")
    return steps, series


def load_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return parse_csv_text(fh.read())


# ---------------------------------------------------------------- math

def step_stats(counts):
    """Per-step statistics for one series of counts.

    Returns a list of dicts: users, step_conv (conversion from the previous
    step, 1.0 for the first step), cumulative (share of the first step),
    lost (users lost vs. the previous step).
    """
    stats = []
    for i, users in enumerate(counts):
        if i == 0:
            stats.append({"users": users, "step_conv": 1.0,
                          "cumulative": 1.0, "lost": 0})
        else:
            prev = counts[i - 1]
            conv = (users / prev) if prev else 0.0
            stats.append({
                "users": users,
                "step_conv": conv,
                "cumulative": (users / counts[0]) if counts[0] else 0.0,
                "lost": prev - users,
            })
    return stats


def biggest_drop(steps, counts):
    """Return (step_name, index) of the biggest drop-off.

    Biggest = lowest conversion from the previous step (largest relative
    loss); ties break on the largest absolute loss.
    """
    stats = step_stats(counts)
    best_idx, best_key = None, None
    for i in range(1, len(counts)):
        key = (stats[i]["step_conv"], -stats[i]["lost"])
        if best_key is None or key < best_key:
            best_key, best_idx = key, i
    return steps[best_idx], best_idx


def _norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def two_proportion_ztest(x1, n1, x2, n2):
    """Two-proportion z-test. Returns (z, two-sided p-value).

    x = successes, n = trials for each of the two groups.
    """
    if n1 <= 0 or n2 <= 0:
        return 0.0, 1.0
    p1 = x1 / n1
    p2 = x2 / n2
    pooled = (x1 + x2) / (n1 + n2)
    se = math.sqrt(pooled * (1.0 - pooled) * (1.0 / n1 + 1.0 / n2))
    if se == 0:
        return 0.0, 1.0
    z = (p1 - p2) / se
    p = 2.0 * (1.0 - _norm_cdf(abs(z)))
    return z, min(1.0, max(0.0, p))


def segment_comparisons(steps, series):
    """Compare segments pairwise at each step after the first.

    The conversion tested at step i is conversion from step i-1 within
    each segment. Returns a list of dicts with p-values and a
    ``significant`` flag (p < 0.05).
    """
    names = list(series.keys())
    out = []
    if len(names) < 2:
        return out
    for i in range(1, len(steps)):
        for a in range(len(names)):
            for b in range(a + 1, len(names)):
                sa, sb = series[names[a]], series[names[b]]
                z, p = two_proportion_ztest(sa[i], sa[i - 1], sb[i], sb[i - 1])
                out.append({
                    "step": steps[i], "index": i,
                    "seg_a": names[a], "seg_b": names[b],
                    "conv_a": (sa[i] / sa[i - 1]) if sa[i - 1] else 0.0,
                    "conv_b": (sb[i] / sb[i - 1]) if sb[i - 1] else 0.0,
                    "z": z, "p": p, "significant": p < 0.05,
                })
    return out


# ---------------------------------------------------------------- report

def _pct(x):
    return f"{x * 100:.1f}%"


def build_report(steps, series):
    lines = ["# Funnel Diagnosis", ""]
    segmented = not (len(series) == 1 and "all" in series)

    totals = [sum(series[s][i] for s in series) for i in range(len(steps))]
    total_stats = step_stats(totals)
    drop_step, drop_idx = biggest_drop(steps, totals)

    lines.append("## Funnel")
    lines.append("")
    lines.append("| Step | Users | From previous | Cumulative | Lost |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for i, step in enumerate(steps):
        st = total_stats[i]
        conv = "—" if i == 0 else _pct(st["step_conv"])
        lines.append(
            f"| {step} | {st['users']:,} | {conv} | "
            f"{_pct(st['cumulative'])} | {st['lost']:,} |")
    lines.append("")
    lines.append(
        f"**Biggest drop-off:** {steps[drop_idx - 1]} → {drop_step} — "
        f"only {_pct(total_stats[drop_idx]['step_conv'])} convert "
        f"({total_stats[drop_idx]['lost']:,} users lost).")
    lines.append("")
    lines.append(
        f"**Overall conversion:** {_pct(total_stats[-1]['cumulative'])} "
        f"({totals[0]:,} → {totals[-1]:,}).")
    lines.append("")

    comparisons = []
    if segmented:
        lines.append("## Segments")
        lines.append("")
        for name, counts in series.items():
            st = step_stats(counts)
            lines.append(
                f"- **{name}**: {_pct(st[-1]['cumulative'])} end-to-end "
                f"({counts[0]:,} → {counts[-1]:,})")
        lines.append("")
        comparisons = segment_comparisons(steps, series)
        sig = [c for c in comparisons if c["significant"]]
        if sig:
            lines.append("### Statistically significant segment gaps (p < 0.05)")
            lines.append("")
            for c in sig:
                lines.append(
                    f"- **{c['step']}**: {c['seg_a']} {_pct(c['conv_a'])} vs "
                    f"{c['seg_b']} {_pct(c['conv_b'])} "
                    f"(z = {c['z']:.2f}, p = {c['p']:.4f})")
            lines.append("")

    lines.append("## Diagnosis")
    lines.append("")
    lines.append(
        f"- Biggest leak: {steps[drop_idx - 1]} → {drop_step} at "
        f"{_pct(total_stats[drop_idx]['step_conv'])} step conversion. "
        "Start the investigation here.")
    low = [(steps[i], total_stats[i]["step_conv"])
           for i in range(1, len(steps)) if total_stats[i]["step_conv"] < 0.20]
    if low:
        for step, conv in low:
            lines.append(f"- Weak step: {step} converts below 20% ({_pct(conv)}).")
    else:
        lines.append("- No step converts below 20%.")
    if segmented:
        sig = [c for c in comparisons if c["significant"]]
        if sig:
            worst = max(sig, key=lambda c: abs(c["conv_a"] - c["conv_b"]))
            lines.append(
                f"- Largest significant segment gap: {worst['step']} — "
                f"{worst['seg_a']} {_pct(worst['conv_a'])} vs "
                f"{worst['seg_b']} {_pct(worst['conv_b'])} "
                f"(p = {worst['p']:.4f}). The weaker segment likely hits "
                "different friction at this step.")
        else:
            lines.append("- No statistically significant segment gaps (p < 0.05).")
    lines.append("")
    lines.append(
        "_Significance is a two-proportion z-test on adjacent-step "
        "conversion; it flags association, not causation._")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------- cli

def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="funnel.py",
        description="Analyse a funnel CSV and print a markdown diagnosis report.")
    parser.add_argument("csv", help="path to the funnel CSV file")
    parser.add_argument("--out", metavar="FILE",
                        help="write the report to FILE instead of stdout")
    args = parser.parse_args(argv)
    try:
        steps, series = load_csv(args.csv)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    report = build_report(steps, series)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(report)
    else:
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
