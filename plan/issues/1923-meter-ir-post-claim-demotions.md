---
id: 1923
title: "Meter IR post-claim demotions in the fallback ratchet — build/verify/lower failures are invisible to CI"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-2108
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ir
language_feature: compiler-internals
goal: correctness
---
# #1923 — Meter IR post-claim demotions in the ratchet

## Problem

The IR fallback ratchet (`pnpm run check:ir-fallbacks`,
`scripts/ir-fallback-baseline.json`) counts **only selector-level rejection
reasons** (`IrFallbackReason`). Functions that the selector *claims* and that
then fail during build/verify/lower demote to legacy through the warning
channel (`src/codegen/index.ts:889-896`) and are **counted nowhere**:

- `from-ast.ts` has 174 `throw new Error` sites that land as `kind: "build"`
  errors in `IrIntegrationReport` (`ir/integration.ts:238-240`, `:84`).
- `STRICT_IR_BUILD_ERRORS` exists but is empty (`codegen/index.ts:906`).
- Selector/lowerer disagreement is institutionalized: the selector
  deliberately accepts shapes the lowerer is known to reject (class
  receivers `select.ts:44-48`; array literals accepted purely to protect the
  call-graph closure with a guaranteed lowerer throw, `from-ast.ts:1221-1230`).

Consequence: a regression that makes claimed functions fail **after**
claiming bypasses CI entirely. The #1922 while-loop defect is a live example
— ordinary loops fell off the IR path and no gate noticed. The #1530
phase-out of the warning channel cannot be trusted while its main leak is
unmetered.

## Proposed approach

1. Aggregate `IrIntegrationReport.errors` by `kind` (build/verify/lower) and
   a normalized message class (first line, identifiers stripped) over the
   same `playground/examples/` corpus the ratchet already walks.
2. Add these as a second bucket family in `ir-fallback-baseline.json`
   (`postClaim: { build: {...}, verify: {...}, lower: {...} }`).
3. Same gate semantics: growth fails CI; `--update-on-decrease` banks
   improvements; `--verbose` prints per-file breakdown.
4. As buckets hit zero, promote the message class into
   `STRICT_IR_BUILD_ERRORS` so regressions become hard compile errors.

## Acceptance criteria

- `check:ir-fallbacks` output shows selector buckets AND post-claim buckets.
- A deliberate injected `from-ast` throw on a claimed shape fails the gate
  (test).
- Baseline committed; ci.yml quality job unchanged otherwise.

## Source

Compiler quality review 2026-06. Related: #1376 (ratchet), #1530 (phase-out),
#1922 (the defect this would have caught).

## Implementation (2026-06-16)

Post-claim demotions are now surfaced and gated, mirroring the #2089
`fallbackCounts` plumbing.

- **Surface** `CompileResult.irPostClaimErrors` (`src/index.ts`): each entry is
  `{ kind, func, message }` from `IrIntegrationReport.errors` (kind =
  build/verify/lower/backend-legality). Always collected on the WasmGC path
  (cheap — the errors are already iterated in `codegen/index.ts` where they
  demote to the warning channel), `undefined` for the linear backend.
  `ctx.irPostClaimErrors` accumulator added in `context/types.ts` +
  `create-context.ts`; populated in `codegen/index.ts`'s `report.errors` loop;
  returned from both `generateModule` return sites; captured/forwarded through
  all three `compiler.ts` entry points alongside `fallbackCounts`.
- **Gate** (`scripts/check-ir-fallbacks.ts`): `aggregate()` now also runs a real
  `compile()` per corpus file and buckets `irPostClaimErrors` by
  `kind → normalized message class` (`normalizeMessageClass` strips quoted
  identifiers + bare integers). New `postClaim` family in
  `ir-fallback-baseline.json` (`{ build, verify, lower, backend-legality }`).
  Same semantics as the selector ratchet: growth fails CI;
  `--update-on-decrease` banks improvements (now also fires on a post-claim
  decrease); `--verbose`/`--json` include it. The gate output shows BOTH the
  selector buckets and the post-claim buckets.
- **Baseline**: `postClaim` is all-empty on current main (the corpus has zero
  claimed-then-failed functions — the #1922 defect is fixed), so the committed
  ceiling is 0 for every kind. Any future regression that demotes a claimed
  function trips the gate.
- **Phase-out hook**: `STRICT_IR_BUILD_ERRORS` (codegen/index.ts) remains the
  per-message-class promotion point — as a post-claim bucket hits/stays zero,
  add the class there to make its regression a hard compile error (#1530).
- **Test seam**: `JS2WASM_TEST_INJECT_IR_BUILD_THROW` (integration.ts) forces a
  build-time demotion on every claimed function — off in all normal builds,
  used only by the test to exercise the metering + gate end to end.

### Acceptance criteria — met
- [x] `check:ir-fallbacks` output shows selector buckets AND post-claim buckets.
- [x] A deliberate injected `from-ast`/build throw on a claimed shape fails the
      gate (`tests/issue-1923.test.ts` runs the real gate with the injection on
      → exit 1, "post-claim demotions grew").
- [x] Baseline committed (`ir-fallback-baseline.json` gains `postClaim`); the
      `ci.yml` `quality` job is unchanged (same `pnpm run check:ir-fallbacks`
      command).

## Test Results (2026-06-16)

`tests/issue-1923.test.ts` — 4/4:
- cleanly-claimed `fib` → no post-claim demotions;
- injected build throw on a claimed fn → metered on `irPostClaimErrors`
  (`kind:"build"`, `func:"fib"`), compile still succeeds (legacy fallback);
- ratchet gate FAILS with the injection (post-claim bucket grows above 0);
- ratchet gate PASSES on the clean corpus.

`check:ir-fallbacks` (clean) and `check:codegen-fallbacks` both green (the
shared `CompileResult`/`fallbackCounts` plumbing still works). typecheck / lint
/ format clean.
