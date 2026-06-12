---
id: 2098
title: "encode flake-classification rules in diff-test262: ct_flake/ct_suspect split + bucket signature hash"
status: ready
sprint: 63
created: 2026-06-11
updated: 2026-06-12
priority: low
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: testing
language_feature: n/a
goal: correctness
related: [2095]
origin: "2026-06-11 analysis program (report 06 §5); stub 08-C13"
---

# #2098 — triage rules live in tribal memory

## Problem

Regression-triage rules are re-derived by every agent from memory files:
"pass→compile_timeout is runner-load flake unless baseline compile >5s";
"identical regression clusters across unrelated PRs are baseline drift".
Nothing in the tooling encodes them.

## Root cause

scripts/diff-test262.ts doesn't read `timing.compileMs` and emits no
cluster identity.

## Plan

(1) Split compile_timeout regressions into `ct_flake` (baseline compileMs
≤ 5s) vs `ct_suspect` (> 5s) in the diff summary. (2) Emit a stable
bucket-signature hash so identical clusters across PRs are mechanically
recognizable as drift. Output-only — no gate behavior change.

## Acceptance criteria

- Diff summaries carry the split + hash; documented in the triage skill

## Dupe check

Memory files feedback_regression_analysis/baseline_drift_cross_check hold
the rules; no tooling issue exists. New (analysis program).
