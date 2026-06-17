---
id: 2143
title: "WebAssembly.validate lane for unoptimized pipeline output (split of #1858-C5)"
status: done
sprint: 63
created: 2026-06-12
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-1921
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infra
area: ci
language_feature: compiler-internals
goal: trustworthiness
related: [1858, 1853, 1941]
origin: "2026-06-12 sprint-62 architecture analysis (quality workstream N4)"
---

# #2143 — default-pipeline malformed Wasm is only caught if a test happens to instantiate it

## Problem

Only *optimizer* output is validated (`src/optimize.ts:234`). Malformed
Wasm from the default pipeline surfaces at instantiate time, only when a
test executes that module. #1941's corpus work found 2 programs whose
unoptimized binary fails `WebAssembly.validate` — invisible to any gate.

## Approach

Validate in the equivalence-test helpers + diff-test harness (not the prod
hot path); classify failures as `malformed_wasm` feeding #1853's
hard-error stability bucket.

## Acceptance criteria

- The 2 known invalid-unoptimized corpus programs surface as bucketed hard
  errors.
- A regression emitting invalid Wasm on any corpus program fails CI loudly.

## Notes

S-size, routine dev; ride along with #1853 in the same lane.

## Resolution (2026-06-16)

The default (unoptimized) pipeline's output is now validated in the
differential harness, and a validation failure is classified as a distinct
`malformed_wasm` outcome.

- **`scripts/diff-test.ts`** — after a successful compile, `runJs2wasm` now runs
  `WebAssembly.validate(r.binary)` BEFORE instantiating. A failure returns the
  new `outcome: "malformed_wasm"` (instead of surfacing as an
  indistinguishable `runtime_error` at instantiate time, only when the program
  happened to be executed). The `FileResult.outcome` union and the `Summary`
  counters/console output gained the `malformed_wasm` bucket. This runs in BOTH
  lanes — the default pipeline AND the `-O3` lane (`optimize.ts` already
  validated its own output; the default path did not).
- **`scripts/diff-test-gate.ts` / `diff-test-optimize-gate.ts`** — the
  per-file delta gate already fails on any `match → non-match` flip, so a
  corpus program regressing from `match` to `malformed_wasm` now fails CI
  loudly (acceptance criterion 2). Their `outcome` types were extended to
  include `malformed_wasm` for type-correctness.
- The **equivalence-test helper** (`tests/equivalence/helpers.ts`) already
  validates the binary (pre-existing) — the test-side lane the issue asked for
  is in place.

The 2 known invalid-unoptimized corpus programs (#1941's corpus work) now
surface as `malformed_wasm`: `array/02-push-pop.js` and
`control/12-for-in-object.js` (both compile `success: true` but fail
`WebAssembly.validate`). Neither was `match` in the baseline
(`runtime_error` / `mismatch` respectively), so reclassifying them is a
better-signal change, not a new gate failure.

### Test Results

- `tests/issue-2143-validate-unoptimized.test.ts` — 3/3 pass: the 2
  known-malformed programs are detected (`success: true` + `validate: false`),
  and a clean program (`numeric/01-basic-arithmetic.js`) still compiles AND
  validates (the detection isn't over-eager). The pin ratchets: if a future fix
  makes one of the two validate cleanly, the test flags it for removal from
  `KNOWN_MALFORMED`.
- `npx tsx scripts/diff-test.ts` locally reports `Malformed wasm: 2`.
- `npm run typecheck` + `npm run lint` (Biome) clean.
