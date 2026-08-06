---
id: 4164
title: "runtime-eval-consumer mode: mixed-type conditional expression produces an incoherent boxed value — typeof says 'string', Number() gives NaN, string-concat gives '[object Object]'"
status: ready
sprint: Backlog
created: 2026-08-06
priority: high
feasibility: hard
area: codegen, coercion, runtime-eval
language_feature: conditional-expression
goal: runtime-eval
related: [3251]
discovered_by: ttraenkler/L2-fable-array-exotic
---

# #4164 — mixed-type ternary yields an incoherent box (runtime-eval-consumer mode only)

## Problem

A conditional expression whose branches have different primitive types
(`number : string`) compiles to a value the runtime classifiers cannot agree
on — but ONLY when the module is compiled as a **runtime-eval consumer**
(`sourceUsesRuntimeEvalBoundary`, e.g. because it reads the global `Function`
value). Verified 2026-08-06, `--target standalone`, CI-aligned in-process
test262 harness (refusal-tier provider):

```js
// this single line flips the compile into runtime-eval-consumer mode:
var __call = Function.prototype.call.bind(Function.prototype.call);

var localNum = 4294967295;
var cond = true;
var v = cond ? localNum : "str";
typeof v      // "string"          (should be "number")
Number(v)     // NaN               (should be 4294967295)
"" + v        // "[object Object]" (should be "4294967295")
String(v)     // "4294967295"      (correct!)
v.length      // undefined
```

Four readers, four different answers. **Without** the `Function.prototype`
line the same program is fully coherent (`number / 4294967295 /
"4294967295"`) — the plain lowering is fine; only the runtime-eval-consumer
lowering miscompiles the mixed-type ternary result.

Negative result recorded so the next owner doesn't re-chase it: a plain TS
probe (`function pick(c: any): any { return c ? 4294967295 : "unlikely"; }`)
does NOT reproduce; `Math.pow`, module-scope `var`s, and `&&`-guarded
conditions are all irrelevant (bisected via scratch probes v9–v15 in the
#3251 S3 session).

## Why it matters (measured impact)

`test262/harness/propertyHelper.js` reads the global `Function` at line 31,
so **every test that includes propertyHelper.js is a runtime-eval consumer**
— and `isWritable` (line 174) computes exactly this shape:

```js
var unlikelyValue = __isArray(obj) && name === "length" ?
  nonIndexNumericPropertyName :   // 4294967295, a number
  "unlikelyValue";                // a string
obj[name] = unlikelyValue;
```

Every `verifyProperty(arr, "length", {...})` / `verifyWritable(arr,
"length")` therefore writes an incoherent box into `arr.length`. With #3251
S3 (ArraySetLength) landed, `ToNumber(box)` is NaN → a spec-correct
RangeError where the harness expects a clean write; propertyHelper rethrows
as `Test262Error: Expected TypeError, got RangeError: Invalid array length`.
`built-ins/Object/defineProperty/15.2.3.6-4-116.js` fails solely on this,
and the whole length-cluster `verifyProperty(…, "length", {writable: …})`
family is capped by it. Pre-S3 the bug was invisible (standalone length
writes were a lenient no-op).

Blast radius is wider than arrays: ANY propertyHelper test whose control flow
depends on a mixed-type ternary value is affected.

## Root-cause direction (unverified)

Whatever the runtime-eval-consumer mode changes about expression lowering
(value-representation widening for the eval boundary?), its mixed-type
conditional unification emits a box whose tag and payload the standard
classifiers (`__typeof_*`, `__unbox_number`, concat's ToString) read
inconsistently — while `String()` reads it correctly, so the payload is
intact and the tagging/classifier disagreement is the bug. Start from the
conditional-expression result-type unification under
`sourceUsesRuntimeEvalBoundary` (`src/codegen/index.ts:3196, :5951`-era
flags) and diff the emitted ternary lowering with/without the boundary flag.

## Acceptance criteria

- The v15 repro above returns `number / 4294967295 / "4294967295"` for
  `typeof/Number/concat` in standalone runtime-eval-consumer mode.
- `built-ins/Object/defineProperty/15.2.3.6-4-116.js` passes with #3251 S3
  merged (its only remaining failure is this).
- No regression on the equivalence suite / standalone floor.
