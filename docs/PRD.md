# PRD — funnel-doctor

## Problem

Every product team has a funnel spreadsheet and a recurring argument about
where it leaks. The argument usually runs on vibes: the biggest absolute
number, the loudest stakeholder, the step someone worked on last. A first
diagnosis — where is the loss, is it big, and does it differ by segment —
should take two minutes and arithmetic, not a meeting.

## User

A product manager, growth lead, or founder with funnel counts in a CSV
(exported from an analytics tool, a warehouse, or a spreadsheet) and no
analyst on hand for a first pass.

## Product

A zero-install web page and a zero-dependency Python CLI that share one
set of definitions:

- Paste, upload, or load sample funnel data (`step,users`, optionally
  split by segment as `step,segment,users`).
- Per-step output: conversion from the previous step, cumulative
  conversion from the top, users lost.
- One callout: the biggest drop-off (lowest step conversion).
- If segments are present, every step's segment conversions are compared
  with a two-proportion z-test; differences at p < 0.05 are flagged.
- A written, rules-based diagnosis: biggest leak, any step converting
  below 20%, the largest significant segment gap.

## Success criteria

- A visitor can go from landing on the page to a diagnosis of the sample
  funnel in one click, offline, with no account and no data leaving the
  browser.
- The CLI produces the same numbers as the web page for the same input.
- Definitions are stated on the page and in the report — no black box.

## Non-goals

- No causal claims. A flagged drop-off or segment gap is where to
  investigate, not proof of why.
- No event-level analytics, no sessionisation, no cohort retention. This
  tool consumes already-aggregated step counts.
- No persistence, accounts, or tracking. Input lives in the page (or the
  terminal) and nowhere else.

## Guardrails

- Significance is association at p < 0.05 on adjacent-step conversion,
  with no multiple-comparison correction; with many segments and steps,
  some flags will be false positives. This is stated in the output.
- Numbers below a few hundred users per step make the z-test unreliable;
  the diagnosis is a first pass, not a verdict.

## Future, if it earns it

- Confidence intervals on step conversion.
- Multiple-comparison correction (e.g. Benjamini–Hochberg) for segment
  comparisons.
- Time-series mode: the same funnel across weeks, flagging steps whose
  conversion moved significantly.
