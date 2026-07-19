---
id: 3440
title: "js-host uncatchable-trap growth baked into baseline by the 64.5% hand-promote — trace culprit codegen PR and lower the floor"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: n/a
goal: ci-reliability
related: [3428, 3189, 3335, 3369, 3372]
---

## Problem

The js-host baseline hand-promote to **27,824 / 43,106 (64.5%)** (#3369 recovery,
run `29660490070` / sibling data `3634d5ab7`) **baked an uncatchable-trap-count
increase into the committed baseline**. This is the growth that made the
**auto**-promote's `promote-baseline` job fail on the `#3335`
`check-baseline-trap-growth.ts` gate (per-category trap growth must be 0 unless
`BASELINE_TRAP_GROWTH_ALLOW` is set) — the hand-promote deliberately bypassed
that gate (surgical baselines push) because the user authorized publishing the
recovered number now.

Baked trap counts in the published `3634d5ab7` host report
(`error_categories`):

| trap category | prior baseline | published (this promote) |
| ------------- | -------------- | ------------------------ |
| `null_deref`  | 163            | **166** (sibling run `6a14dc5db`: 165) |
| `illegal_cast`| 78             | **81**                    |
| `oob`         | (n/a)          | 49                        |
| `unreachable` | (n/a)          | 55                        |

Net js-host uncatchable-trap growth ≈ **+5** (null_deref +2–3, illegal_cast +3)
vs. the prior published baseline.

**Why this matters:** these traps feed the `#3189` ratchet floor. A baked-in
increase silently raises that floor, so the trap-growth gate now tolerates the
higher count — masking the regression until it is traced and fixed. Until then
the floor sits elevated and cannot be lowered without re-tripping the gate.

## Newly-trapping tests (from the merge_group failure)

The auto-promote's failed run flagged these as newly uncatchable-trapping
(previously non-trapping):

- `Promise.allSettled` path
- `Promise.any` path
- `Proxy` `apply` trap
- dynamic `import()`
- direct `eval` code path

These cluster around **async / Promise-combinator + dynamic-dispatch codegen**,
which points at the async-marker / codegen changes in the #3369 wave.

## Goal / Acceptance

1. **Trace** the +5 uncatchable-trap growth to the culprit codegen PR. Prime
   suspects: **#3428 / #3372** (async-completion-marker work) — the newly-trapping
   set is Promise/async/dynamic-dispatch heavy. Bisect the trapping tests above
   against the pre-/post-#3369 commits.
2. **Fix** the codegen so those tests no longer emit an uncatchable trap
   (null_deref / illegal_cast) — either a genuine correctness fix or a structured
   catchable error where the spec expects a thrown exception.
3. **Lower the `#3189` ratchet floor** back to the prior counts (null_deref 163,
   illegal_cast 78) once the traps are eliminated, and confirm
   `check-baseline-trap-growth.ts` passes at the tightened floor.

## Reproduce

```bash
gh run download 29660490070 -R loopdive/js2wasm -n test262-merged-report -D /tmp/m
node scripts/build-test262-report.mjs \
  --input /tmp/m/test262-results-merged.jsonl \
  --output /tmp/m/host.json --baseline-sha 6a14dc5db --include-proposals
node -e "const r=require('/tmp/m/host.json');console.log(r.error_categories.null_deref, r.error_categories.illegal_cast)"
# then bucket the null_deref / illegal_cast records by file path (see the
# dereferencing-a-null-pointer [in …frame…] signatures) to find the trapping set.
```

## Context

- This is the JS-HOST counterpart to the standalone publish. The standalone
  hand-promote did NOT bake a trap floor (it sidestepped the trap gate entirely);
  the js-host one DOES, hence this dedicated follow-up.
- Published baselines: `loopdive/js2wasm-baselines` `test262-current.json` (host,
  27,824) + main-repo `benchmarks/results/test262-current.json`. Trap floor lives
  in the baselines-repo host jsonl that `check-baseline-trap-growth.ts` diffs.
