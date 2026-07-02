---
id: 2926
title: "Emit wasm_sha in the CI shard JSONL so diff-test262's wasm-identical-noise filter works in CI"
status: backlog
priority: medium
sprint: Backlog
created: 2026-07-02
feasibility: medium
task_type: improvement
area: tooling
goal: developer-experience
related: [2920, 2912, 1222, 1943]
---

# #2926 — Emit `wasm_sha` in the CI shard JSONL (permanent fix for verdict-only landings)

## Problem

`scripts/diff-test262.ts` classifies a `pass → fail` regression as
**"wasm-identical noise"** (excluded from every gated regression count — the
`check for test262 regressions` net gate, the `#1668` catastrophic guard, and
the `#1897` standalone guard) **only when both the baseline row and the new row
carry the same non-null `wasm_sha`** (`diff-test262.ts` `wasmUnchanged`, ~line
440; the #1222 byte-identical filter). If either side lacks `wasm_sha`, the
regression is conservatively counted as real.

**The CI shard runner never emits `wasm_sha`.** `tests/test262-shared.ts`
`recordResult` (the producer of the sharded JSONL that CI merges and the
baseline is promoted from) has no `wasm_sha` field — confirmed against
`.test262-cache/test262-current.jsonl` (keys: category, compile_ms, exec_ms,
file, host_import_leak_class, imports, oracle_version, reached_test, scope,
scope_official, status, strict, timestamp — no `wasm_sha`). Only the legacy
`tests/test262-vitest.test.ts` runner computes it (`computeWasmSha`,
`tests/test262-runner.ts:136`), and that runner is not the CI path.

So the #1222 wasm-identical-noise filter is **completely inert in CI**: a
verdict-only change (byte-identical compiled Wasm; only the pass/fail score
flips) reads as N real regressions.

## Impact — why this matters (the #2920 landing)

This is exactly why #2920 (the strict negative-verdict arm, an intentional −439
that changes NO codegen) could not land through the normal gates and needed a
**temporary `#1668` threshold bump (200→500)** plus a manual standalone
high-water lower. If the shard JSONL carried `wasm_sha`, all 439 verdict-only
flips would classify as wasm-identical noise and pass `#1668` / `#1897` / the
regression gate **cleanly** — leaving only the absolute `#2097` floor to adjust.
Every future oracle/verdict tightening (there will be more as the negative-test
and error-classification oracle sharpens) hits the same wall.

## Fix direction

1. **Compute `wasm_sha` in the CI path** — `tests/test262-shared.ts` (and, for
   the worker-driven main path, `scripts/test262-worker.mjs` /
   `metadataFromWorkerResult`): hash the compiled binary (reuse
   `computeWasmSha` from `tests/test262-runner.ts`) and thread it through
   `recordResult` into the JSONL row (same field name `wasm_sha` that
   `diff-test262.ts` already reads). Emit it for BOTH pass and fail rows (a
   flip needs the hash on both sides) whenever a binary was produced; leave it
   absent when no binary exists (compile_error) so the conservative
   "count-as-real" fallback still applies there.
2. **Refresh the baseline** so the committed/promoted baseline rows also carry
   `wasm_sha` (a normal push:main `promote-baseline` after the emitter lands).
   Until both baseline and candidate carry it, the filter stays inert — so this
   is a land-then-one-clean-baseline-cycle change.
3. Once in place, verdict-only landings need no threshold bump — verify by
   re-checking that a no-codegen oracle change nets 0 gated regressions.

## Acceptance

- CI shard JSONL rows carry `wasm_sha` for every row where a binary was
  produced (host and standalone lanes).
- After one baseline refresh, a verdict-only (byte-identical-Wasm) change nets
  **0** `regressionsWasmChange` in `diff-test262.ts` and passes `#1668` /
  `#1897` / the regression gate without any threshold change.

## Context

Filed from the #2920 landing-blocker analysis (2026-07-02). See
`plan/issues/2920-strict-negative-verdict-succeeded-arm.md` "Landing mechanics".
