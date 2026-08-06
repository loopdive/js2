---
id: 4192
title: "`this` is dead inside a function EXPRESSION held in a variable — .call/.apply/.bind and plain method invocation all drop the receiver (BOTH lanes)"
status: ready
created: 2026-08-06
updated: 2026-08-06
priority: high
task_type: bug
area: codegen
goal: es5
feasibility: hard
reasoning_effort: max
sprint: current
horizon: l
related: [4025, 3983, 3796, 2152, 1636, 4163]
---

# #4192 — `this` in a variable-held function expression is never bound

## Repro (both `--target standalone` AND the JS-host lane)

```js
var fe = function () { this.touched = true; };
var o1 = {}; fe.call(o1);        // o1.touched === undefined   (want true)
var o3 = {}; fe.apply(o3);       // o3.touched === undefined   (want true)
var o4 = {}; fe.bind(o4)();      // o4.touched === undefined   (want true)
var o5 = { m: fe }; o5.m();      // o5.touched === undefined   (want true)

var ge = function () { return this.v; };
ge.call({ v: 9 });               // NaN                        (want 9)

function fd() { this.touched = true; }   // a DECLARATION works
var o2 = {}; fd.call(o2); // o2.touched === true  ✓
function gd() { return this.v; }
gd.call({ v: 9 });        // 9                    ✓
```

Verified through `runTest262File(…, "standalone")` **and** through the JS-host
lane on the same file — identical failure text, so this is **not** a standalone
gap. `.tmp` repro: a single test262-shaped file asserting all seven rows.

Adjacent, same family, also both lanes:

```js
var cb = function () { this.touched = true; };
[1].forEach(cb, {});             // TypeError: fn is not a function
[1].forEach(function () { this.touched = true; }, {});   // works (inline)
```

So a function expression is fine **inline**; it breaks once it is bound to a
variable and referenced by name.

## Root cause (traced, not guessed)

The receiver-install machinery is keyed on **`ts.isFunctionDeclaration`**:

- `resolveDeclaration` (`src/codegen/named-this-call.ts:94`) returns `undefined`
  for anything that is not a `FunctionDeclaration`, so
  `resolveNamedThisCallTarget` / `tryReshapeApplyToNamedThisCall` never fire.
- At the call site (`src/codegen/expressions/calls.ts:~7005`) the named-`this`
  arm is additionally gated on **`!closureInfo`**. `var fe = function (){}`
  registers a `closureMap` entry, so even the identifier form takes the
  `closureInfo` branch — which is the legacy *evaluate-`thisArg`-and-**drop**-it*
  lowering (`fctx.body.push({ op: "drop" })`).

That is the same defect class #4025/#3983 fixed for declarations ("a silent
wrong answer, not a refusal"), left standing for the closure/function-expression
shape — which is the dominant shape in test262 and in real JS.

## Why it is worth a max-effort slice

`var f = function () {…}` is the single most common function form in the ES5
corpus. Directly observed in the 2026-08-06 ES5 standalone census:

| where | evidence |
| --- | --- |
| `built-ins/Function/prototype/{apply,call}` | ~19 non-eval ES5 failures, incl. the whole `A5_T4/T5/T6/T8` "`obj.touched` is expected to be true" family — the tests are literally the repro above |
| `built-ins/Function/prototype/bind` | part of the 34-file bucket (`15.3.4.5-11-1`, `-6-2`, `-6-6`: "obj.property Expected SameValue(«undefined», «12»)") |
| unmeasured | every HOF `thisArg`, every `Function.prototype.call` idiom in library code, both lanes |

The measured Function.prototype slice alone is ~20 ES5 files; the true blast
radius is larger and spans the host lane, so it is **not** an es5-standalone-only
lever.

## Direction

Two independent halves; do the first alone and re-measure.

1. **Call-site receiver install for the closure shape.** Extend the
   `named-this-call` trampoline (or an inline save/install/restore of
   `__current_this` with the existing `catch_all`-restore discipline) to a
   callee that resolves to a stable, non-reassigned function-expression
   binding. The trampoline body already exists — the work is admission, not
   new lowering.
2. **Method invocation** (`o5.m()` where `m` holds the function expression) —
   a different call path (`call-receiver-method.ts`), same missing install.

Do NOT widen `bodyReferencesOwnThis`'s meaning; the function-expression body
already reads `__current_this` when it references `this` (`function-body.ts:378`
runs for expressions too). The gap is purely who writes that global.

## Acceptance

- All seven repro rows above pass on both lanes.
- `built-ins/Function/prototype/{call,apply}` ES5 standalone improves; zero
  regressions in a base-vs-head sweep of `built-ins/Function/**` and
  `built-ins/Array/prototype/**` (the HOF `thisArg` users).
- A committed vitest covering: declaration (unchanged), inline expression
  (unchanged), variable-held expression via `.call`/`.apply`/`.bind`/method,
  and the null-receiver case (`f.call(null)` must keep `this === undefined`).
