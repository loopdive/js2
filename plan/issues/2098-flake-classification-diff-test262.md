---
id: 2098
title: "encode flake-classification rules in diff-test262: ct_flake/ct_suspect split + bucket signature hash"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-07-21
completed: 2026-06-16
assignee: ttraenkler/dev-b
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

## Resolution (2026-06-16, dev-b)

Both rules now encoded in `scripts/diff-test262.ts` (output-only, no gate change):

- **ct_flake / ct_suspect split** — each regression entry carries the
  baseline-side `compile_ms`. `pass → compile_timeout` regressions split at a
  5000ms threshold: `ct_flake` (baseline ≤ 5s → runner-load noise) vs
  `ct_suspect` (baseline > 5s OR no recorded baseline compile → investigate).
  Suspect files are listed inline. Encodes "pass→compile_timeout is
  runner-load flake unless baseline compile >5s" (`feedback_regression_analysis`).
- **Regression bucket signature** — a 16-hex sha256 over the SORTED set of
  `{file, destination-status}` for all non-CT regressions. Independent of PR,
  run order, and counts, so identical clusters across PRs emit the SAME hash —
  mechanically recognizable as baseline drift
  (`feedback_baseline_drift_cross_check`). compile_timeout flake is excluded so
  a flapping test can't perturb the signature.

Documented in `.claude/skills/regression-triage.md` (new Step 2b). Tests:
`tests/issue-2098.test.ts` (3 cases — ct split with flake/suspect/unknown,
signature stable across reorder+wasm_sha, signature changes when cluster
differs). All pass. Stacked on the #2096 branch (shares diff-test262.ts).

## Follow-up resolution (2026-07-21 — absent trap baseline rows)

The predecessor merge-group artifact from run `29801056655` omitted two host
rows. Candidate run `29801877164` compiled and retried those tests and reported
`oob`, so the trap ratchet's former `!base` branch classified both as newly
trapping. That conclusion was unsupported: an absent JSONL row records no
baseline runtime outcome.

Direct `runTest262File` controls confirmed the failure mode independently. Both
tests were run three times on predecessor `1aef2ea8` and B0 `01ef0f6`; every run
produced the identical OOB message. The predecessor Wasm hashes were
`eb448e75ca22` / `8b9477e75bf1`, while B0 produced `c01964041b67` /
`c70a3d758a1a`. The standalone lane also passed both tests on both commits. The
host traps therefore pre-existed B0; only the predecessor CI row omission
manufactured apparent growth.

The CLI's same-corpus artifact comparison now explicitly asks
`evaluateTrapCategoryGrowth` to apply the same evidence rule to missing rows as
it already applies to an explicit baseline `compile_timeout`. The helper's
default remains strict for direct callers modeling a genuinely new candidate
test:

- candidate traps with no baseline row are excluded from category growth;
- the paths remain visible under `Trap baseline unknowns`, annotated with
  `baseline absent` or `baseline compile_timeout`;
- a baseline row with any observed non-trap runtime outcome changing to a trap
  still increments the category and hard-fails the ratchet.

Focused coverage in `tests/issue-2098.test.ts` pins both halves: absent→trap is
diagnostic-only, while observed `assertion_fail`→`oob` remains a gate failure.
