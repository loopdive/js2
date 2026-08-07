---
id: 4192
title: "`this` is dead inside a variable-held function EXPRESSION — .call/.apply/.bind and method invocation all drop the receiver (BOTH lanes)"
status: ready
created: 2026-08-06
updated: 2026-08-07
priority: high
task_type: bug
area: codegen
goal: es5
feasibility: hard
reasoning_effort: max
# assignee cleared 2026-08-07 (W22): `ttraenkler/W13-builtin-proto-residue` is a
# dead lane; slice 1 landed, the remainder below is unowned.
sprint: current
horizon: l
related: [4025, 3983, 3796, 2152, 1636, 4163]
# Slice 1 (this PR): +31 LOC in calls.ts — the receiver-install plan + the three
# `finishClosureReceiverCall` sites. The mechanism itself lives in the new leaf
# module src/codegen/closure-receiver-install.ts; only the call-site wiring can
# live in the driver.
loc-budget-allow:
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
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
```

Verified through `runTest262File(…, "standalone")` **and** the JS-host lane on
the same file — identical failure text, so this is **not** a standalone gap.

## Root cause (traced, then confirmed against the emitted WAT)

The receiver-install machinery is keyed on **`ts.isFunctionDeclaration`**:

- `resolveDeclaration` (`src/codegen/named-this-call.ts:94`) returns `undefined`
  for anything that is not a `FunctionDeclaration`, so
  `resolveNamedThisCallTarget` / `tryReshapeApplyToNamedThisCall` never fire.
- At the call site (`src/codegen/expressions/calls.ts`) the named-`this` arm is
  additionally gated on **`!closureInfo`**. `var fe = function (){}` registers a
  `closureMap` entry, so even the identifier form takes the `closureInfo`
  branch — the legacy *evaluate-`thisArg`-and-**drop**-it* lowering.

Same defect class #4025/#3983 fixed for declarations ("a silent wrong answer,
not a refusal"), left standing for the dominant JS shape.

**The lifted body needs no change.** WAT for the repro shows the closure opening
with `global.get $__current_this; ref.is_null; (if … $__undefined …)` — i.e.
`bodyReferencesOwnThis` was true, `compileFunctionBody` set `readsCurrentThis`,
and the body reads the global correctly. Nothing in the module ever *wrote* it:
`global.set` on `$__current_this` appeared only inside `__call_fn_method_N`,
which this path does not reach. Only the writer was missing.

## Slice 1 — LANDED: `.call` / `.apply` (this PR)

New leaf module `src/codegen/closure-receiver-install.ts`:

- `planClosureReceiverInstall` — admission. Fires only when the callee
  identifier resolves to a `VariableDeclaration` whose initializer is a
  **`FunctionExpression`** (arrows excluded: their `this` is lexical, and
  installing a dynamic receiver would *change* their meaning), non-generator,
  non-`async`, no explicit `this` parameter, and whose body
  `bodyReferencesOwnThis` — the same predicate the body used to decide it would
  read the global, so the two can never disagree.
- `emitClosureReceiverInstall` / `finishClosureReceiverCall` — inline
  save/install/restore around the call, mirroring `__call_fn_method_N`
  (closure-exports.ts) and `fillDirectCallTrampolines` (typed-this.ts),
  **including their documented limitation that an exceptional unwind skips the
  restore**. An inline sequence cannot use the trampoline's `catch_all` without
  wrapping an arbitrary sub-expression in a `try`; matching the established
  sequence exactly is worth more than being the one path that differs.

A **null** receiver needs no arm: the body's own `ref.is_null` guard already
answers `undefined`, so `f.call(null)` keeps the value it has today. That is
deliberately unlike `named-this-call.ts`, which must branch because its
trampoline passes the receiver as a parameter.

Reassignment of the variable is deliberately **not** checked. Unlike the
exact-target trampoline this install bakes no callee: if the variable holds some
other function at runtime, that function either reads `__current_this` (in which
case installing the spec receiver is correct) or does not (in which case the
install is unobservable).

### Measured

Base-vs-head, `--target standalone`, ES5 label, interpreter runtime-eval tier:

| corpus | base | head |
| --- | ---: | ---: |
| `built-ins/Function/prototype` (189 ES5 files) | 94 pass | **95** pass |
| 148-file corpus: every ES5 file using `.call(`/`.apply(` **and** a function expression, ∪ the `Array.prototype` HOF-`thisArg` family (the other `__current_this` consumer) | 84 pass | **86** pass |

**FIXED 2** (`Function/prototype/{apply,call}/S15.3.4.{3,4}_A5_T5.js` — literally
the repro), **BROKE 0**, zero signature changes among the still-failing. Two
apparent regressions in the first sweep were parallel-run compile timeouts and
pass when re-run serially.

Covered by `tests/issue-4192-fn-expr-this-call-apply.test.ts` (10 cases, each
asserted on **both** lanes). Verify-first: 6 of the 10 are RED on `origin/main`;
the 4 that are green on both are the guards that must not move (null receiver,
function declaration, arrow, callee that never mentions `this`).

The ES5 count is small because only 43 ES5 files use this shape at all. The
value is host-lane correctness in the dominant JS function form, not the
conformance delta.

## Remaining (NOT this PR)

1. **`.bind`** — `fe.bind(o)()` still drops the receiver; the `$__bound_fn`
   carrier (#3140) is a third path. Folded into **#4196**, where it is 3 of the
   34-file `Function.prototype.bind` bucket.
2. **Method invocation** — `var o = { m: fe }; o.m()`. **Sized after slice 1 and
   it is SMALL — see below. My earlier "probably the most valuable follow-up"
   was wrong.**

### Sizing the method-invocation shape (2026-08-07) — it is not a lever

I claimed method invocation was the commonest shape and the biggest remaining
half. Measured, it is neither.

**Behaviour matrix** (10 shapes, post-slice-1, both lanes identical):

| # | shape | result |
| --- | --- | --- |
| 1 | inline fn-expr in a literal, **number** prop read | ✅ |
| 2 | same, call in argument position | ✅ |
| 3 | **variable-held fn-expr** as a literal property | ❌ `NaN` |
| 4 | variable-held fn-expr assigned AFTER (`o.m = fe`) | ✅ |
| 5 | method shorthand `{ m() {…} }` | ✅ |
| 6 | **function DECLARATION** as a literal property | ❌ `NaN` |
| 7 | inline fn-expr **writing** `this.touched = true` | ❌ lost |
| 8 | variable-held fn-expr writing through `this` | ❌ lost |
| 9 | inline fn-expr, **string** prop read | ❌ `undefined` |
| 10 | any of the above nested inside a function scope | ✅ |

So "method invocation is broken" is false. Only rows 3 and 6 are the missing
receiver install — a function defined **elsewhere** used as a method, where
`this` is untyped and therefore reads `__current_this`. Rows 7 and 9 are a
different defect entirely (a *closed-struct* one: `touched` is not a declared
field of the literal, and a `string` field read answers `undefined`), and rows
1/2/4/5 already work because TypeScript types `this` as the literal and the read
lowers to `struct.get`.

**Corpus count.** 155 ES5 files contain a method-shaped function expression
whose body mentions `this` (brace-matched scan, not a bare grep); 86 fail
standalone. Subtracting mechanisms that already have owners:

| n | mechanism |
| ---: | --- |
| 26 | `with` (#1387 / #671) |
| 23 | 10.4.3 sloppy-`this` cluster (W12) |
| 19 | descriptor MOP (#1906 / #2992 / #3251) |
| 3 | `Function.prototype` census (#4192 / #4196) |
| 3 | `String.prototype` census (#2875) |
| **12** | **residue** |

And the 12-file residue does **not** survive causality spot-checks as method
invocation:

- `language/statements/function/S13.2.2_A15_T3/T4` — `new __FACTORY()`, a
  **constructor** `this`, not a method call.
- `built-ins/Object/create/15.2.3.5-4-11` and friends — an accessor `get`
  invoked with an exotic receiver (`this instanceof Date`); descriptor-MOP
  receiver binding, already counted above where the path matched.
- `language/statements/try/12.14-15`/`-16` — `e()`, a **bare** call whose
  sloppy-mode `this` must be the global object: W12's 10.4.3 cluster.
- `language/statements/function/S13.2.2_A4_T2` — fails at `printShape ===
undefined`, i.e. `__FACTORY.prototype = {…}` is not visible on the instance:
  prototype-chain lookup (#4176 territory), never reaching a receiver question.
- `language/expressions/call/11.2.3-3_*` — expects a TypeError from calling a
  non-callable; an IsCallable gap, the same one as #4196's 5-file bucket.

**Verdict: the genuine "method call on a function defined elsewhere does not
install the receiver" population is ~2–4 ES5 files.** That is smaller than the
43-file `.call`/`.apply` population slice 1 addressed, and it is squarely inside
the flat tail #4163 describes. Do not staff it as a lever; fold rows 3/6 in
opportunistically if someone is already inside `call-receiver-method.ts`. Rows
7 and 9 are a separate closed-struct question and deserve their own probe before
anyone sizes them.

## Status after #4203 (W22, 2026-08-07) — the `.bind` third is STILL OPEN

#4203 added `tryReshapeBindToNamedThisCall`, which puts immediate
`f.bind(t, …)(…)` onto the receiver-correct `.call` trampoline. That closes the
`.bind` gap for a function **DECLARATION** callee — but **not for this issue's
shape**. The reshape is deliberately gated on `!closureInfo`, mirroring slice
1's own gate: `var fe = function () {…}` has a `closureMap` entry, so it takes
the `closureInfo` branch of the immediate bind-and-call arm and never reaches
the trampoline.

Re-measured on `origin/main` @ `b28970e206` + #4203, both lanes identical:

| repro row | result |
| --- | --- |
| `fe.call(o1)` | ✅ (slice 1) |
| `fe.apply(o3)` | ✅ (slice 1) |
| `ge.call({v:9})` | ✅ (slice 1) |
| `fd.call(o2)` — declaration control | ✅ |
| **`fe.bind(o4)()`** | **❌ still drops the receiver** |
| **`var o5 = { m: fe }; o5.m()`** | **❌ still drops the receiver** (the row #4168 also has) |

### The `.bind` slice is now small and fully specified

`call-tail-dispatch.ts`, the `identifier.bind(…)(…)` arm: the `closureInfo`
branch currently evaluates `thisArg`, DROPS it, and builds a `syntheticCall`
for `compileClosureCall`. Reshape it to `fe.call(t, …partial, …rest)` instead
and let the existing `calls.ts` closure arm handle it — that arm already calls
`planClosureReceiverInstall` / `emitClosureReceiverInstall`, i.e. slice 1's own
machinery, so no new mechanism is needed. Admission is slice 1's
`planClosureReceiverInstall` gate verbatim (function expression, not an arrow,
non-generator, non-async, body references own `this`).

Expected yield is small — slice 1's whole `.call`/`.apply` half measured +2 ES5
— so size it as tail filler, not a lever.

## Coordination

W12 is concurrently implementing the 168-file 10.4.3 `this`-binding cluster
(sloppy-mode `this` falling through to `emitUndefined` regardless of strictness)
in `src/codegen/expressions.ts`. **Different mechanism, adjacent territory.**
This slice touches neither `expressions.ts` nor the body's `this` lowering — it
only adds the missing *writer* of `__current_this` at one call site. The two
compose: W12 decides what a body reads when nothing is installed; this decides
what gets installed.
