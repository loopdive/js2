---
id: 6609
title: "standalone: `Object.getPrototypeOf(<value callable only at runtime>)` answers `null` instead of `%Function.prototype%` — every linked-provider method, and the seven Temporal `builtin.js` rows"
status: done
completed: 2026-09-14
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s22-lane
created: 2026-09-14
---

## Problem

Under `--target standalone`, `Object.getPrototypeOf(f)` answers **`null`**
whenever `f` is a function value the CHECKER cannot prove callable — an `any`
parameter, a registry lookup, or (by construction) any member of a linked
provider's namespace. §10.3.1 says the answer is `%Function.prototype%`.

Measured on this branch's base (`.tmp/s22/link.mjs`, the real Temporal provider
linked, fresh cache, `cacheHit=false`):

```
Object.getPrototypeOf(Temporal.PlainDate.compare) === Function.prototype   false
Object.getPrototypeOf(Temporal.PlainDate.compare) === null                 true
```

That is the whole of test262's seven-row
`prototype Expected SameValue(«null», «[object Function]»)` bucket — the
`built-ins/Temporal/*/builtin.js` rows, whose third assertion is

```js
assert.sameValue(Object.getPrototypeOf(Temporal.PlainDate.compare),
  Function.prototype, "prototype");
```

The other three assertions in those same files (`Object.isExtensible`,
`Object.prototype.toString.call`, `hasOwnProperty("prototype")`) **already
passed** on base. Only the [[Prototype]] read was wrong.

## Root cause

`src/codegen/expressions/object-get-prototype-of.ts`'s value arm answers
`Function` for a statically provable callable:

```ts
if (ctx.oracle.signatureOf(arg0) !== undefined || ts.isFunctionExpression(arg0) || ts.isArrowFunction(arg0)) {
  return emitEs5IntrinsicPrototype(ctx, fctx, expr, "Function");
}
```

An `any`-typed value has no signature, so it fell through to
`emitBuiltinGetPrototypeOfFallback` → the native `__getPrototypeOf`, whose
`$proto` walk decodes `$Object` receivers only. A closure carrier is not one, so
the walk reached its terminal and returned `ref.null.extern`.

## Fix

`tryEmitDynamicCallableGetPrototypeOf` (same file): in standalone/WASI only, and
only on the fallback path every static arm has already declined, decide at
RUNTIME.

```
local.set $v                     ; the argument, already coerced to externref
<Function.prototype>             ; compiled as the EXPRESSION, so identity is
local.set $fp                    ;   the same object the static arm answers
local.get $v ; call __is_callable
if (result externref) $fp else (__getPrototypeOf $v)
```

Two choices are load-bearing:

- **`__is_callable`, not `__typeof_function`.** The link boundary's
  `callable_kind` terminal sets bit 1 ([[Construct]]) for a provider-owned
  INSTANCE too — which is why `typeof <provider instance>` answers `"function"`
  (a standing #5383 residual). `__typeof_function` masks bits 0|1 and would have
  given every provider instance `%Function.prototype%`. `__is_callable` masks
  bit 0, so an instance is untouched. Verified, not assumed: `.tmp/s22/link.mjs`
  row 19 (`Object.getPrototypeOf(PlainDate.from(…)) === null`) reads `true` on
  both trees.
- **`Function.prototype` is compiled as the expression**, via the same
  `emitEs5IntrinsicPrototype` helper the static arm uses, so the two agree by
  construction and `ref.eq` identity against the test's own right-hand side
  holds. (The `%Function.prototype%` `$Object` singleton in
  `array-object-proto.ts` is a DIFFERENT object — `gPO(<top-level fn decl>) ===
  Function.prototype` is `false` on base and stays `false`; see Residuals.)

## Acceptance criteria

- [x] `Object.getPrototypeOf(<dynamic callable>)` answers `Function.prototype`
      module-locally and across a standalone link.
- [x] Non-callable receivers keep their existing answer — including the
      provider-owned instance the `typeof` residual would have mis-claimed.
- [x] The seven test262 `builtin.js` rows move; 0 legitimate `pass→fail` over a
      360-row three-family sample.
- [x] 692 must-not-move rows flat per file; 84 corpus artifacts byte-identical;
      equivalence gate at baseline.

## Residuals (measured, deliberately not fixed here)

| shape | answer | note |
| --- | --- | --- |
| `gPO(<top-level function DECLARATION>) === Function.prototype` | `false` on both trees | the #3236 arm answers the `$Object` singleton, a different object from what `Function.prototype` reads. Pre-existing; a consistency bug between two intrinsics, not a null. |
| `gPO(<class VALUE>) === Function.prototype` | `false` on both trees | `__is_callable` excludes class objects by design ([[Construct]] without [[Call]]). |
| `gPO(<array / string / number / Map / class instance via an `any` param>)` | `null` on both trees | `.tmp/s22/c3-{base,new}.out`, ten probes, every row identical. The generic walk does not decode those carriers either; only the callable case is in scope here. |

## Gates

`typecheck`, `lint`, prettier, `check-loc-budget`, `check-func-budget`,
`check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`,
`check:speculative-rollback`, `check:issue-ids:against-main`,
`update-issues --check` — green. No new `loc-budget-allow` / `func-budget-allow`
entry is needed: neither changed file crosses a ceiling on either base. The two
**inherited** reds handed down from S20/S21 reproduce unchanged and are not from
this slice: `check:compiler-boundaries` →
`inventory-valid-architecture-incomplete`, and under `LOC_GATE_BASE=origin/main`
`src/runtime.ts` 19,822 > 19,601 plus `buildImports` 308 > 300.
