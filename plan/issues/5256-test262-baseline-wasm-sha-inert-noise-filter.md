---
id: 5256
slug: test262-baseline-wasm-sha-inert-noise-filter
status: ready
sprint: current
priority: high
horizon: s
goal: ci-infra
feasibility: medium
created: 2026-09-01
requested_by: ttraenkler/fable-ir-takeover
---

# The #1222 wasm-byte-identity noise filter is structurally inert — the promoted baseline JSONL carries no `wasm_sha`

## Problem

The merge-group regression gate (`scripts/diff-test262.ts:1747`) classifies a
pass→fail transition as noise when the emitted binary did not change:

```js
const wasmUnchanged = typeof baseSha === "string" && typeof curSha === "string" && baseSha === curSha;
```

`wasmUnchanged` requires BOTH sides to carry a `wasm_sha`. Measured 2026-09-01
against a fresh fetch of the promoted baseline
(`loopdive/js2wasm-baselines`, `test262-current.jsonl`):
**0 of 48,735 entries carry `wasm_sha`** — including 0 of the 35,659 `pass`
entries. Consequences, all observed in one live incident:

- `wasmUnchanged` can never be true, so the `Wasm-identical noise
  (pass → other, same wasm_sha)` line is structurally `0` — reported as a
  measurement, actually a schema guarantee.
- Every pass→fail transition is counted under `Regressions with wasm-hash
  change`, which reads as "the PR changed this test's binary" even when it
  did not.
- The exact failure class the filter was built to absorb — a
  runner-load-variance flip on a byte-identical binary — hard-fails the net
  gate and auto-parks the PR.

## Incident evidence (PR #5412, merge-group run 33497198917)

The gate parked the F1-S3 PR on one regression:
`test/language/statements/class/subclass/class-definition-null-proto-super.js`
pass → fail (`Maximum call stack size exceeded`), reported as a wasm-hash
change with a `LIKELY-REAL` banner (baseline content-current). The park
diagnosis (PR #5412 comment, 2026-09-01T10:56Z) measured the binary
**byte-identical** base-vs-branch five ways — raw body, harness sloppy,
harness strict, the runner's exact `compileOptions`, and the runner's own
`assembleOriginalHarness` + `computeWasmSha` (primary and strictRerun
variants), deterministic across 3 runs — and the same run showed the load
signature (aggregate compile +1.8%, one `compile_error → compile_timeout`
drift). With a working filter this park does not happen; the PR lost a full
queue cycle to it.

Note the gate's own footnote already anticipates the drift cross-check
(`Same signature on another PR ⇒ identical cluster ⇒ likely baseline
drift`), but nothing anticipates the filter itself being unpluggable.

## Root-cause question (to verify, not assume)

Where does `wasm_sha` get dropped — does the sharded runner not RECORD it in
per-shard JSONL, does the `promote-baseline` job strip it on merge, or does
the baselines-repo writer filter fields? `runs/`-side artifacts and
`tests/test262-runner.ts` (`computeWasmSha` exists and is called — the #5412
diagnosis used it) suggest recording works and promotion drops it. Establish
which stage loses the field before writing any fix.

## Acceptance criteria

1. The promoted `test262-current.jsonl` carries `wasm_sha` for at least the
   `pass` population (size cost measured and stated; if size is the reason
   for the historical drop, record that trade-off explicitly and gate the
   decision with the project lead rather than silently re-dropping).
2. `wasmUnchanged` is live: a synthetic diff with identical shas on a
   pass→fail row classifies it as wasm-identical noise (a test pins this).
3. The `Wasm-identical noise` and `Regressions with wasm-hash change` report
   lines are honest again — when the baseline lacks the field, the report
   must SAY the filter is inert (`wasm_sha coverage: N/M baseline entries`)
   instead of printing a guaranteed 0/inflated count.
4. Baseline-validate spot-checks tolerate the new field (schema-additive).

## Lane

CI/infra — Lane A per `plan/method/lane-partition.md`. Filed by the Fable IR
lane from the #5412 incident; not claimed by the filer.
