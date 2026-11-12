# funnel-doctor

Paste a funnel, find the leak — per-step conversion, the biggest drop-off, segment significance tests, and a written diagnosis, in your browser or from the command line.

## What it does

- **Per-step diagnosis:** conversion from the previous step, cumulative conversion from the top of the funnel, and users lost at every step — plus one clear callout of the biggest drop-off (the lowest step conversion).
- **Segment comparisons:** if the data is split by segment, every step's segment conversions are compared with a two-proportion z-test and differences at p < 0.05 are flagged.
- **A written diagnosis, not just charts:** rules-based findings — the biggest leak, any step converting below 20%, and the largest significant segment gap — in the web page, or as a markdown report from the CLI.

All sample data in this repo is fake, generic SaaS data.

## Run the web demo

No build step, no server, no network — it works offline:

```bash
# Option 1: just open the file
open index.html            # macOS; xdg-open on Linux, double-click on Windows

# Option 2: serve the folder (same result)
python3 -m http.server 8000
# then visit http://localhost:8000
```

Click **Load sample data**, or paste / upload your own CSV, then **Analyse**.
Nothing you paste leaves the browser.

## Run the CLI

Python 3, standard library only:

```bash
python3 funnel.py sample/funnel.csv                 # markdown report to stdout
python3 funnel.py sample/funnel_segments.csv --out report.md
python3 funnel.py --help
```

## Input format

A header row is required. Two shapes are accepted; steps are read in the
order they first appear, and in the segment format every segment needs a
count for every step.

```csv
step,users
Visit,12000
Signup,5400
Activated,2700
```

```csv
step,segment,users
Visit,free,8000
Visit,pro,2000
Signup,free,3200
Signup,pro,1400
```

Definitions: *step conversion* = users at this step ÷ users at the previous
step. *Cumulative* = users at this step ÷ users at the first step.
*Biggest drop-off* = the step with the lowest step conversion (largest
relative loss); the table also shows absolute loss, and the two do not
always point at the same step.

## Architecture

```
index.html + app.js + styles.css   Static web demo. Vanilla JS/CSS, no
                                   libraries, no CDN, works offline.
                                   Parses, computes, renders bars, runs
                                   the z-tests, writes the diagnosis.
funnel.py                          The same logic as a CLI: CSV in,
                                   markdown report out (stdout or --out).
                                   Stdlib only (csv, math, argparse).
sample/                            funnel.csv (2-column) and
                                   funnel_segments.csv (3-column, with a
                                   real free-vs-pro gap).
tests/test_funnel.py               unittest suite: conversion math,
                                   drop-off detection, z-test behaviour,
                                   CSV parsing, sample-file reports.
docs/PRD.md                        The one-page product spec.
```

The browser and the CLI intentionally implement the same definitions, so a
report says the same thing in both places.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

## Limitations — stated honestly

- **Significance is association, not causation.** It is a two-proportion
  z-test on adjacent-step conversion (per step, per segment pair), flagging
  where conversion differs at p < 0.05. It tells you where to investigate,
  never why the gap exists.
- **No multiple-comparison correction.** With many steps and segments,
  roughly 1 in 20 "significant" flags is expected by chance alone. Treat
  borderline results as leads.
- **Small numbers are shaky.** Steps with only a few hundred users make the
  z-test unreliable; the diagnosis is a first pass, not a verdict.
- **Aggregated counts only.** No event data, sessions, identity stitching,
  or cohorts — the tool reads the funnel you give it, exactly as given
  (including any step that goes *up*, which usually means the counts came
  from different windows).

## License

MIT — see [LICENSE](LICENSE).
