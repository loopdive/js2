---
id: 2099
title: "promote-baseline must re-run (not carry forward) poison-classified rows"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: testing
language_feature: n/a
goal: correctness
related: [2095]
origin: "2026-06-11 analysis program (report 06 §5); stub 08-C14 — alternatively extend #1862"
---

# #2099 — phantom failures persist across promotions

## Problem

Phantom `Binary emit error` rows from poisoned compiler workers can
persist across baseline promotions (the historical drift class): once a
poisoned result enters the baseline, every later promotion carries it
forward, and the #1862 in-review work left its acceptance boxes 2–3
(promotion-time re-run) unchecked.

## Root cause

The `promote-baseline` job carries rows matching `POISON_ERROR_RE` forward
instead of re-running them (#1862 investigation item 3, unimplemented).

## Plan

In promote-baseline: collect rows matching the poison signature, re-run
just those tests serially (clean worker), promote the re-run results.
Alternatively reopen/extend #1862 — coordinate with its in-review PR
before starting.

## Acceptance criteria

- A synthetic poisoned row is healed by the next promotion
- Promotion wall-clock increase bounded (< 2 min for current poison count)

## Dupe check

#1862 (in-review) covers the residual burst analysis; the promotion-time
re-run is its unimplemented item 3 — filed so it isn't lost if #1862
closes. New (analysis program).
