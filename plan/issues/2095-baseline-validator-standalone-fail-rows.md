---
id: 2095
title: "baseline validator: sample the standalone lane and fail rows, not just 50 host pass rows"
status: ready
sprint: 63
created: 2026-06-11
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: testing
language_feature: n/a
goal: correctness
related: [1897, 1862]
origin: "2026-06-11 analysis program (report 06 §5.1/§6.2); stub 08-C10"
---

# #2095 — one lane, one row class

## Problem

`test262-baseline-validate.yml` spot-checks 50 HOST `pass` rows only. A
rotted standalone baseline silently weakens the #1897 regression floor; a
stale `fail` row that now passes inflates `improvements` and masks one
real regression per PR diff.

## Root cause

Validator samples a single lane and a single row class
(scripts wired per CLAUDE.md "Baseline files" table).

## Plan

Extend the sampler: N standalone `pass` rows + M `fail` rows per lane
(fail rows assert still-failing); deterministic seed unchanged. Include
the #1897 status reconciliation (merged but stale `in-review`).

## Acceptance criteria

- Validator exercises both lanes and both row classes; CI time increase
  bounded (~+1 min)

## Dupe check

#1218 built the pass-row sampler; lane/class coverage unfiled. New
(analysis program).
