---
id: 4076
title: "Standalone: borrowed `<Builtin>.prototype.<m>.call(<invalid this>)` answers a value instead of throwing"
status: done
completed: 2026-08-02
assignee: ttraenkler/H-errmodel
sprint: 78
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: error-model
# The 183-line MECHANISM lives in the subsystem module
# (src/codegen/builtin-prototype-brand.ts), exactly as the LOC gate asks. What
# lands in the driver is the irreducible dispatch hook — 1 import + 3 comment
# lines + 3 statements + a blank = +8 — and it MUST live at the top of the
# `.call`/`.apply` block in calls.ts, because arms below claim the shape and
# answer without running step 1. It was trimmed from +28 to +8 before asking.
loc-budget-allow:
  - src/codegen/expressions/calls.ts
# Same +8, seen from the function side: the hook sits inside the `.call`/`.apply`
# arm of compileCallExpression, so the +7 body growth is the same irreducible
# dispatch. Splitting compileCallExpression is #3399's job, not this fix's.
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
---

## Problem

Slice M2 of the #4017 error-model decomposition. On `--target standalone`,

```js
Object.prototype.valueOf.call(undefined);            // returned undefined
Object.prototype.hasOwnProperty.call(null, "foo");   // returned false
Function.prototype.toString.call(undefined);         // returned undefined
Function.prototype.bind.call(true);                  // returned undefined
```

all completed **normally, with zero host imports**, where §20.1.3 / §20.2.3
require a `TypeError`. Every `assert.throws(TypeError, …)` over the shape
reported `Expected a TypeError to be thrown but no exception was thrown at all`
— the largest single in-scope failure signature at the time (102 exact-match
records in goal scope).

## Root cause — measured, not inferred

This is the **same shape as #4017**, one level deeper: *a static path that knows
the answer degrades to a silent wrong answer once its vehicle is unavailable.*

In JS-host mode the borrowed call rides the `__proto_method_call` host import
and the JS engine performs `RequireObjectCoercible` / `IsCallable` for us.
Standalone discards the vehicle, and with it the check. Two distinct failure
routes were confirmed by instrumenting the compiler:

1. **The synthesised bare call.** `src/codegen/expressions/calls.ts` (#1888
   Slice 3) rewrites `Object.prototype.hasOwnProperty.call(recv, k)` to
   `recv.hasOwnProperty(k)` and routes it through
   `compilePropertyIntrospection`, which constant-folds an answer from the
   receiver's *static* type without ever running step 1 of the algorithm.

2. **The refuse-loud is not loud.** For the methods that arm does not cover
   (`valueOf`, `toLocaleString`, the whole `Function.prototype` family) the same
   block falls through to a `reportError` refusal. That diagnostic is emitted
   **without `sticky`**, and `compileExpressionBody`'s null-result unwind
   (`rollbackSpeculative`, `src/codegen/expressions.ts`) **discards non-sticky
   diagnostics** and substitutes `pushDefaultValue`. Traced end to end:

   ```
   [TRACE] case2a typeName=Object method=valueOf standalone=true args=1
   [TRACE] REFUSE-LOUD reached Object valueOf
   [TRACE] reportError pushed; ctx.errors.len= 1 sev= error
   [TRACE] rollback DROPPING 1 diag   (at compileExpressionBody, expressions.ts:964)
   [TRACE] generateModule return errors.len= 0
   success true  errors []  imports []
   ```

   The emitted body for `Object.prototype.valueOf.call(undefined)` was literally
   `global.get $undefined; extern.convert_any; drop` — the default-value
   placeholder standing in for a refusal that had already been erased. The
   compiler raised the right objection and then deleted it.

`#3725` introduced `sticky` for exactly this class of erasure; this refusal
predates it and never adopted it. Marking it `sticky` would have converted the
silent wrong answer into a `compile_error` — better hygiene, but **zero** flips
and a real regression risk for files that survive on the degraded value. The
right fix is the #4017 one: decide statically, **throw** statically.

## Fix

`src/codegen/builtin-prototype-brand.ts` grows a sibling arm to the #3610
prototype-**receiver** gate, covering the borrowed **`this`**:
`tryBorrowedPrototypeNullishThisThrow`, wired as the **first** arm of the
`.call`/`.apply` dispatch in `expressions/calls.ts` so no downstream arm can
claim the shape first (several do — `tryEmitNativeProtoReflectiveCall` recovers
`Function.prototype.call` as a member closure and `call_ref`s it).

It fires only on a receiver whose invalidity is a **proof**:

| family | spec step | invalid receiver |
| --- | --- | --- |
| `Object.prototype.{valueOf,toLocaleString,hasOwnProperty,propertyIsEnumerable}` | `ToObject(this value)` (§20.1.3) | provably `undefined`/`null` |
| `Function.prototype.{toString,call,apply,bind}` | `If IsCallable(func) is false, throw` (§20.2.3) | the above, **plus** a *syntactically* non-callable literal (`{}`, `[]`, `/re/`, `"s"`, `1`, `true`) |

Arguments are compiled and dropped in source order before the throw, because
§13.3.6.1 EvaluateCall runs ArgumentListEvaluation before `Call`.

### What is deliberately NOT gated (each would be a wrong answer)

- **`Object.prototype.toString`** — §20.1.3.6 steps 1–2 return
  `"[object Undefined]"` / `"[object Null]"`. It is the one `Object.prototype`
  method that must *not* throw on a nullish `this`.
- **`Object.prototype.isPrototypeOf`** — §20.1.3.3 step 1
  ("If V is not an Object, return false") runs *before* `ToObject(this)`, so the
  receiver alone cannot decide it.
- **`String.prototype.*`** — already correct via
  `emitBorrowedStringReceiverToString` (#3254).
- **The `BRANDED_PROTO_METHODS` ctors** (Map/Set/WeakMap/WeakSet/Date/
  ArrayBuffer/TypedArray) — their `RequireInternalSlot` does reject a nullish
  `this`, but the borrowed form **already throws correctly today**: all 36
  `this-not-object-throw*.js` files pass. Coupling them here would put a 36-file
  at-risk pool behind a 1-file yield. Left as a follow-on.
- **Identifiers typed `object`** for the `IsCallable` test. Under `allowJs` an
  `object`-typed identifier may hold a function at run time, so only *syntax*
  counts. The #4017 note that `resolvesToNonConstructableValue` over-claims
  `.bind()`/`.call()`/`.apply()` results was taken seriously: that over-claim is
  **not** inherited.

Shadow safety comes from `builtinPrototypeReceiver`, which requires the base
identifier's declared type to be the lib `<Name>Constructor` interface — a user
`var Object = {…}` retypes it and the gate declines (asserted in the tests).

## Measurement

**Provenance.** Standalone JSONL fetched `--force` 2026-08-02T01:53Z,
`oracle_version` 12, 48,619 rows, row timestamps 2.8.2026 03:32:04–03:41:11,
corpus `test262@b363f29d`. Official **43,505 run / 25,995 pass (59.75 %)**;
goal scope (`es5id:` present OR none of `es5id`/`es6id`/`esid`)
**8,545 run / 6,298 pass (73.70 %) / 2,247 non-pass**; **0 unopenable**.

**Population is complete, not sampled.** The change is inert unless the source
contains `<Ctor>.prototype.<m>.call(<invalid literal>` for a gated `(ctor,
method)` pair; every other file compiles byte-identically. Statically scanning
all 43,505 openable official files for that shape gives the **entire** movable
population:

| | official | goal scope |
| --- | --- | --- |
| trigger set | **25** | 20 |
| ├ currently `pass` = **AT-RISK** | 9 | 9 |
| └ currently non-pass = **REACHABLE** | 16 | 14 |

**Result** (CI-equivalent driver: `assembleOriginalHarness` →
`CompilerPool(1,"unified")` → `scripts/test262-worker.mjs`, `target:
standalone`, primary + strict rerun; **run SOLO**, row count floored at 25/25):

| arm | pass | fail |
| --- | --- | --- |
| base (`upstream/main`) | **9** | 16 |
| branch | **24** | 1 |

- **+15 flips, 0 regressions.** 14 of the 15 are goal scope.
- **Conversion: 14/14 goal-scope reachable = 100 %.**
- **At-risk: 9/9 still pass.** The `Function.prototype.bind` files that already
  passed keep throwing `TypeError`, now from the static gate.
- The one remaining fail,
  `Object/prototype/hasOwnProperty/topropertykey_before_toobject.js`, **failed
  before and fails after** — see the known incompleteness below. It is excluded
  from the claimed flips.

**Instrument validated first.** The base arm reproduced the published baseline
*exactly* — the same 9 `pass` / 16 non-pass, file for file — before any delta
was read from it.

**Attribution by removal.** Reverting only these two files and re-running the
same driver returns all 25 rows to the base verdict, so every delta is
attributable to this change. A standalone unit probe over 26 shapes moves
12 ok / 14 bad → **26 ok / 0 bad** across the same swap.

**Host lane proven untouched, not assumed.** The gate is `noJsHost`-gated;
`target: "gc"` compiles of all 11 shapes are **byte-identical** (sha256 of the
emitted binary) before and after.

## Known incompleteness (stated, not hidden)

`hasOwnProperty`/`propertyIsEnumerable` run `ToPropertyKey(V)` **before**
`ToObject(this)` (§20.1.3.2 s1–s2), so a key whose `toString` throws must
surface *that* error rather than our `TypeError`. Compiling the key argument
evaluates the expression but does not apply `ToPropertyKey`, so
`topropertykey_before_toobject.js` still fails (differently: it now reports an
error-identity mismatch instead of "no exception was thrown"). Every trigger
file that flips passes a plain string literal, for which `ToPropertyKey` is the
identity. Closing this needs a `ToPrimitive(string)` emit on an arbitrary
externref — a follow-on.

`.apply` in the *outer* position (`X.prototype.m.apply(nullish)`) is handled by
the same gate but has **0 corpus files** (verified over all 25 trigger files).

## Tests

`tests/issue-4076-borrowed-proto-this-brand.test.ts` — 60 assertions, each on an
observable value returned from the compiled module (`2` = the module itself
caught a `TypeError`), never on "it compiles":

- 12 `Object.prototype` × nullish shapes, 36 `Function.prototype` × invalid
  shapes;
- 9 **positive controls** that must NOT throw, including
  `Object.prototype.toString.call(undefined)`, `isPrototypeOf.call(undefined,{})`
  and `String.prototype.trim.call(" a ")`;
- the user-shadowed-`Object` shadow-safety case;
- host-lane behaviour unchanged;
- zero host imports for every gated shape (#2961).
