---
id: 3088
title: "test262-runner: non-BigInt testWithTypedArrayConstructors shim passes 1 arg but the real harness passes 2 (constructor + boundArgFactory) — 2-param callbacks stay vacuous via the #1837 over-arity-void skip"
status: done
sprint: current
model: opus
priority: medium
horizon: s
feasibility: medium
task_type: bugfix
area: test262-harness
language_feature: typed-arrays, test262-harness, closures
goal: host-independence
related: [3074, 2939, 2940, 3086, 1837]
created: 2026-07-07
completed: 2026-07-08
origin: "2026-07-07 measured under #3074 keystone validation (dev-keystone): 8/12 non-CE fill/*.js stay vacuous after the dispatch fix because their function(TA, makeCtorArg) callback is over-arity-void for the 1-arg shim."
---

# #3088 — non-BigInt `testWithTypedArrayConstructors` shim under-passes (1 arg vs real harness's 2)

## Problem

The runner shim (`tests/test262-runner.ts`) for the non-BigInt
`testWithTypedArrayConstructors(fn)` calls `fn(constructors[i])` — **1 arg**. But
the real test262 harness (`harness/testTypedArray.js` →
`testWithAllTypedArrayConstructors`) calls `f(constructor, boundArgFactory)` —
**2 args**. Many real tests declare `function (TA, makeCtorArg) { … }` (2 params,
void) and use `makeCtorArg` in the body (`new TA(makeCtorArg([0,0,0]))`).

Even after #3074 makes nested callbacks dispatch on the gc lane, a 2-param VOID
callback invoked with 1 arg is an **over-arity void candidate**, which
`tryEmitInlineDynamicCall` intentionally SKIPS (#1837 — a void closure padded
past its arity marshals a stack-invalid `call_ref`). So those callbacks are
still dropped → still vacuous. Measured under #3074: **8/12 non-CE
`built-ins/TypedArray/prototype/fill/*.js` stay `vacuous:true`** for exactly this
reason (e.g. `fill-values.js`, `fill-values-relative-end.js`).

## Fix

Make the non-BigInt shim pass a second `boundArgFactory` argument — a
passthrough factory mirroring the existing BigInt shim's
`__ta_makeCtorArgPassthrough` — so the 2-param callbacks are called with 2 args
(arity matches → dispatches). This also makes the shim faithful to the real
harness signature.

- 1-param callbacks `function(TA)` called with 2 args: the extra arg is
  truncated by the dispatcher (under-arity is fine) — unchanged behavior.
- The BigInt variant already does this; this just brings the non-BigInt variant
  to parity.

## Sequencing

Do this **after** the honest baseline (#3086 / dev-honest) lands — that work
measures the vacuity signature against the CURRENT shim, so changing the shim
mid-flight would perturb its baseline. Bounded, runner-only, low risk once
unblocked. Value is still gated on #3087 (dynamic `new TA`) for the vacuous→pass
conversion; this converts more vacuous→honest (executing) results.

## Acceptance

- The `fill/*.js` (and sibling) 2-param-callback harness tests no longer report
  `vacuous: harness-wrapper callback never executed` — the callback executes
  (then passes, or honest-fails on #3087, per its body).
- Shim signature matches real test262 (`f(constructor, boundArgFactory)`).
- No net regression.

## Resolution (2026-07-08, dev-ta)

Fixed in `tests/test262-runner.ts`: extracted the identity
`__ta_makeCtorArgPassthrough` helper (previously emitted only inside the BigInt
block) to a shared block emitted when EITHER wrapper is referenced, and changed
the non-BigInt `testWithTypedArrayConstructors` shim from `fn(constructors[i])`
to `fn(constructors[i], __ta_makeCtorArgPassthrough)` so 2-param
`function(TA, makeCtorArg)` callbacks match arity and dispatch (instead of being
skipped as over-arity-void per #1837).

Scoped verification (via `runTest262File`, gc lane):

- `fill/fill-values.js`, `fill/fill-values-relative-end.js`,
  `fill/fill-values-non-numeric.js`: `vacuous:true` → **`vacuous:false`**, now
  honest-fail on #3087 (`No dependency provided for extern class "TA"`) —
  exactly the vacuous→honest transition this issue promised.
- `fill/fill-values-conversion-operations.js` stays vacuous, but it uses a
  *different* harness (`testTypedArrayConversions`, 4-param callback) outside
  this issue's scope — correctly unchanged.

tsc + prettier clean. Full vacuous→pass conversion still gated on #3087.
