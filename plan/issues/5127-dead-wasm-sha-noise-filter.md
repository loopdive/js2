---
id: 5127
title: "diff-test262 #1222 wasm-unchanged noise filter is dead: baseline carries no wasm_sha, so every flake reads as a hard wasm-hash-changed regression"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: ci-tooling
goal: pipeline-health
---

# The #1222 wasm-unchanged exclusion can never fire

`scripts/diff-test262.ts:1747` computes

```ts
const wasmUnchanged =
  typeof baseSha === "string" && typeof curSha === "string" && baseSha === curSha;
```

but the committed baseline jsonl carries **no `wasm_sha` field at all** — 0 of
48,735 entries (verified 2026-08-28 with `node scripts/fetch-baseline-jsonl.mjs
--force`, 85 MB, stamped 08:11 the same day; row schema is `timestamp,
oracle_version, oracle_lane, file, category, status, reached_test, compile_ms,
exec_ms, scope, scope_official, strict` — no hash field under any name;
`wasmSha` / `"sha"` also 0 hits).

So `wasmUnchanged` is always false, `regressions_wasm_change` collapses onto
plain regressions, and the #1222 "byte-identical binary ⇒ CI-runner variance"
exclusion exists in code but can never fire. **Every flaky pass→fail flip is
reported as a hard regression labelled wasm-hash-changed** — the label that
reads as maximally damning is in fact vacuous.

## Measured cost (2026-08-28, PR #5125's merge_group park)

PR #5125 was auto-parked on exactly one "regression with wasm-hash change":
`built-ins/TypedArray/prototype/map/return-new-typedarray-conversion-operation-consistent-nan.js`.
A/B on the merged state showed the PR's diff contributed zero bytes to that
test's module (byte-identical both lanes, with and without the diff) and the
test passed deterministically on base, branch, merged state and plain main —
the flip was runner variance that a working #1222 filter would have excused.
Cost: one park cycle, one diagnosis dispatch, one re-admission (~40 min of
queue time plus agent time). The failure mode recurs on every flake.

## Fix directions (pick one)

1. **Emit `wasm_sha` from `promote-baseline`** (test262-sharded.yml) so the
   baseline rows carry it — the filter then works as designed. Check the
   runner already computes a module hash per row (the gate log prints
   "Regressions with wasm-hash change", so the *candidate* side has hashes;
   only the baseline side is missing).
2. If baseline hashes are impractical (size/cache churn), replace the #1222
   signal with a different noise discriminator (e.g. candidate-side hash
   equality against the merge-base compile that the #3467 per-SHA
   baseline-reuse machinery already performs).

Either way, add a self-check: if >99% of diffed rows lack a baseline hash, the
gate should say "wasm-unchanged filter INACTIVE (baseline carries no
wasm_sha)" instead of silently labelling everything wasm-hash-changed.

## Acceptance criteria

- A pass→fail flip whose candidate module is byte-identical to the baseline's
  is excluded from the fine gate (or the chosen replacement signal is), and a
  synthetic test proves the exclusion fires.
- The gate output names the filter's active/inactive state explicitly.
- No change to gate behavior for genuine wasm-changed regressions.
