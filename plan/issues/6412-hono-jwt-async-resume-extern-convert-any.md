---
id: 6412
title: "hono's JWT subpaths emit an invalid module — `extern.convert_any[0] expected type anyref, found call of type externref` in `__async_resume_fimportPublicKey`"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

## Problem

Three hono subpath modules compile successfully and then fail
`WebAssembly.compile`:

| module | engine message |
| --- | --- |
| `dist/utils/jwt/index.js` | `Compiling function #212:"__async_resume_fimportPublicKey" failed: extern.convert_any[0] expected type anyref, found call of type externref @+56513` |
| `dist/middleware/jwk/index.js` | `Compiling function #426:"__async_resume_fimportPublicKey" failed: extern.convert_any[0] expected type anyref, found call of type externref @+187403` |
| `dist/middleware/jwt/index.js` | `Compiling function #425:"__async_resume_fimportPublicKey" failed: extern.convert_any[0] expected type anyref, found call of type externref @+183035` |

All three are the same defect reached through three entry points: the async
resume continuation for `importPublicKey` feeds an `extern.convert_any` with a
value the call already produced as `externref`. `extern.convert_any` takes
`anyref` — converting an `externref` that is already external is the type
error. The coercion is emitted in the resume path, not the straight-line one,
which is why it survives the ordinary async lowering tests.

Found by the `--surface exports` survey added in
[#5368](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5368-dogfood-validation-gate-declared-entry-only)
on `cf82f78d6d` (2026-09-12). Recorded in `KNOWN_INVALID_MODULES` in
`scripts/check-dogfood-validation.mjs`; deleting those three rows is the
acceptance test.

## Reproduce

```bash
node --import tsx tests/dogfood/dogfood-surface-probe.mjs \
  --package hono --modules dist/utils/jwt/index.js
```

## Acceptance criteria

1. All three modules compile to binaries that pass `validateEmittedBinary`.
2. Their three rows are deleted from `KNOWN_INVALID_MODULES`.
3. A regression test that fails on the parent commit and passes with the fix.

## Implementation Plan

**Root cause (verified on 23a0ddaa26, not a hypothesis).** An activated async
function's Wasm result is rewritten to `externref` only when its *body* is compiled
(`rewriteFuncResultType` inside `maybeActivateAsync`, `src/codegen/async-activation.ts`
~L36/L281). The pre-pass `collectDeclarations` (`src/codegen/declarations.ts` ~L2887–3029)
registers the *unwrapped* `Promise<T>` type — for `exportPublicJwkFrom` that is the
object-literal struct `(ref null $7)`. A caller compiled **before** the callee reads that
stale signature via `funcSignatureOf` and, to feed the `await` (externref), wraps the call
in `extern.convert_any`; the callee's body later flips its type to `(result externref)`,
so the final module has `extern.convert_any (call $exportPublicJwkFrom)` → invalid.
Pure declaration-order bug: in hono's `jws.js`, `importPublicKey` precedes
`exportPublicJwkFrom`. Minimal repro (`outer` awaits `inner(key)`; `inner` is an async fn
returning `{ kty, key_ops: [...] }` declared *after* `outer`) is invalid on gc, wasi and
standalone; swapping the two declarations is valid on parent (anti-vacuity control).

**Fix (one site).** In `collectDeclarations`, immediately after
`results = widenAsyncThenableResults(...)` (~L2998) and before `addFuncType`, bake the
Promise carrier at declaration time:
`if (isAsync && !isGenerator && asyncEngineWouldActivate(ctx, stmt)) results = [{ kind: "externref" }]`.
`asyncEngineWouldActivate` is the existing pure predicate (already evaluated pre-body by
`planIrOverlay`, `src/codegen/index.ts` L5812, which runs after `collectDeclarations` L5701),
so the decision is known to be stable at this point. Order constraints: (a) place it AFTER
`prepareAsyncCallableAbi`/`widenAsyncThenableResults` so the prepared-IR ABI fingerprint
still sees the fulfillment results; (b) keep `rewriteFuncResultType` in `maybeActivateAsync`
(now a no-op for declarations) but `reportError` if the registered result is not already
`externref` when the engine activates — a pre-pass/body-time disagreement must be loud, not
a silently mistyped call. The #3587 hazard report the predicate emits on decline is deduped
per declaration, so diagnostics are unchanged. Check the two other `addFuncType` registration
paths in `declarations.ts` (~L3218, ~L3288) for the same async shape; closures already bake
`externref` up front (`planAsyncClosureActivation`) and need nothing.

**Probe first:** `.tmp/6412/probe.mjs` (compileProject + validateEmittedBinary) on
`.tmp/6412/r1.js` — must go invalid→valid; `r2.js` must stay valid.

**Regression test** `tests/issue-6412-async-forward-ref-result-abi.test.ts`: untyped
two-file fixture (`mod.js` + `entry.ts`, pattern of `tests/issue-5302-*.test.ts`). Case A:
caller declared before the async callee returning an object literal — `compileProject`
succeeds AND `validateEmittedBinary(binary).valid` (fails on parent). Case B (control): the
same module with the callee first — valid on parent and after. Case C: instantiate A with
`instantiateWithRuntime` and `await outer(...)` resolves to the object (proves the call
result is the Promise, not a mistyped struct). Repeat A for `target: "wasi"` and
`"standalone"` (both reproduce today).

**Dogfood movement:** delete the three hono rows from `KNOWN_INVALID_MODULES`
(`scripts/check-dogfood-validation.mjs` L142–160, present on HEAD); re-run
`node --import tsx tests/dogfood/dogfood-surface-probe.mjs --package hono --modules dist/utils/jwt/index.js,dist/middleware/jwk/index.js,dist/middleware/jwt/index.js`
→ all `valid`. The hono upstream suite does not exercise jwt/jwk, so the hono 259/324 anchor
and every other suite anchor are expected unchanged; any async-forward-reference call site
in the corpus now sees the same `externref` it sees when the callee is declared first, so no
byte change is expected elsewhere. Standalone lane: same fix applies (predicate is per-lane
inside `decideAsyncActivation`); no floor movement expected.

**Acceptance:** AC1–3 from the issue, plus the pre-pass/body-time disagreement guard.

## Dispatch

opus — one well-located insertion plus a guard, but the correct placement relative to the
prepared-IR ABI fingerprint and the sibling registration paths needs judgment, not just
mechanical edits.
