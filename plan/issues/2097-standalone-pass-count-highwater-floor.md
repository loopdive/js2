---
id: 2097
title: "absolute standalone pass-count floor — high-water-mark backstop against compounding small regressions"
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
goal: host-independence
related: [2095]
origin: "2026-06-11 analysis program (report 06 §4); stub 08-C12"
---

# #2097 — a moving floor ratchets nothing

## Problem

The #1897 standalone regression floor is MOVING (re-seeded from the new
baseline on every push to main), so a sequence of small net-negative PRs
each within tolerance compounds without any ratchet catching the trend.

## Root cause

Tolerance-vs-rolling-baseline design — no absolute reference.

## Plan

Commit a standalone high-water mark (like
benchmarks/results/test262-current.json); a weekly job (or a step in the
sharded workflow) asserts standalone pass-count ≥ high-water − 50, with
the mark auto-raised on improvement.

## Acceptance criteria

- High-water file committed and auto-raised; breach fails loudly with the
  trend window in the message

## Dupe check

#1897 (merged) is the per-PR rolling gate; the absolute backstop is
unfiled. New (analysis program).
