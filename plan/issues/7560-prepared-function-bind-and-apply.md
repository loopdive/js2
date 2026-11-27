---
id: 7560
title: "Prepared path: Function.prototype.bind and apply through values"
status: in-progress
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7557]
related: [7557, 7354, 7352]
assignee: "ttraenkler/ir-lane-a1"
---

# #7560 — Prepared path: `Function.prototype.bind` and `apply` through values

Slice A1b-2 of the Prepared whole-program IR path (#7354), stacked on A1b-1 (#7557, branch `claude/7354-a1b`, head
f240b11786). Branch `claude/7354-a1b2`.

## Problem

`harness/propertyHelper.js` (included by ~900 ES5 tests) starts with four lines of the shape
`var __join = Function.prototype.call.bind(Array.prototype.join);`. On the Prepared path (`TEST262_COMPILER_PATH=ir`,
`--target standalone`) those lines compile, but `bind` reached through a value is the built-in caller's run-time abort
(#7557's ladder has no `bind` rung). `apply` through a value is the same abort, and `call` through a value aborts with
more than three arguments after `thisArg`.

## Acceptance criteria

- `f.bind(thisArg, ...args)` makes a bound function (ES5 §15.3.4.5, ES2015+ BoundFunctionCreate §10.4.1.3 and
  §20.2.3.2): calling it calls the target with the bound `this` and the bound arguments followed by the call's;
  `typeof` is "function"; its `length` and `name` are node's; bound functions of bound functions work.
- `Function.prototype.call.bind(fn)` (the harness shape) works for a source function and for the held
  `Object.prototype.hasOwnProperty` / `propertyIsEnumerable`; for `Array.prototype.join` / `push` the bind succeeds and
  only calling the bound value may abort.
- `bind` on a value that is not callable throws a catchable TypeError. `new` of a bound function aborts.
- `f.apply(thisArg)`, `f.apply(thisArg, null / undefined)`, `f.apply(thisArg, realmArray)` agree with node (holes read
  as undefined); a primitive second argument throws a catchable TypeError; any other array-like aborts.
- Never a wrong value, never a Wasm trap where JS throws catchably, never invalid Wasm, never an exception out of
  `compile()`. The ordinary pipeline's output is byte-identical. The prelude stays inside the A1b budget (≤ +15 KB and
  ≤ +1 s over the A1a head 103,374 B).
- Code quality: one mechanism (the #7557 route: the built-in caller and its identity ladder), no per-arity copies,
  `from-ast.ts` does not grow, no new IR→runtime or IR→codegen import edges, the gates pass.

## Implementation Plan

### What is reused

- **The route of #7557.** The dispatcher's built-in arm calls the realm's built-in caller (`realm-builtin-caller.ts`)
  with the built-in, `this` and an `$ObjVec` of the arguments; the caller's body is the identity ladder
  (`dynamic-builtin-call.ts`) over the `BuiltinCall` record. `bind`, `apply` and the bound function are new rungs of that
  ladder; nothing else dispatches built-ins.
- **The vector-apply builder** (`buildNativeClosureVectorApplyDefinition`, `closure-vector-apply-body.ts`): Call(F, this,
  list) over a run-time argument vector. A second instance over the `$ObjVec` layout (the caller's own vector type) is
  the one call primitive every rung uses: `apply-arguments(callee, this, vector)`. Its built-in arm passes its vector
  straight back to the caller, so a built-in target (`Function.prototype.call.bind(h)`: the target is `call`) reaches
  the ladder again ("then again" of #7557's plan).
- **`js.object.init-function`** (F1b): the bound function's own `length` and `name` are seeded into its bag by the same
  realm function every source function object gets them from; the kernel's [[Get]], `typeof`, `instanceof Function` and
  [[GetPrototypeOf]] treat it like any other closure without builtin metadata.

### What changes, by module

- **`closure-vector-apply-body.ts` / `closure-method-body.ts`** (runtime): the apply builder reads its vector through
  an operand (a typed parameter, or an externref cast to `$ObjVec`); the built-in arm's `BuiltinCallSite` carries the
  argument vector's instructions instead of argument locals (the method body builds it from its locals, the
  `$ObjVec` apply passes its parameter). One shared entry test (`ref.test` allocation ∧ `ref.test` lifted func) serves
  the dispatch arms and the new `is-source` test.
- **`builtin-caller-bodies.ts`** (runtime): the bodies of the caller's new callables, beside `argument` /
  `argument-count`:
  - `arguments(vector, from, tail)`: `vector[from..] ++ tail` (`tail` null: none; `from` clamped to the length);
  - `bind(target, vector)`: a `$BoundFunction` (a closure-root subtype holding its record `[target, ...vector]`);
  - `bound(value)`: its record, or null for any other value;
  - `is-source(value)`: whether a dispatch arm runs `value` (a source closure).
- **`native-invocation.ts`** (backend): the caller's callables are one table (kind → name, signature, body), each
  reserved only where the program calls it; the `$BoundFunction` type only where `bind` is called.
- **`closure-invocation-callables.ts`** (core + runtime declarations), **`manifest.ts`**,
  **`native-invocation-requirements.ts`**: the new kinds, their signatures and operand counts, from one table each
  (the requirements' special case for the caller's kinds becomes a table lookup).
- **`dynamic-builtin-call.ts`** (legalization): the rungs, in order: bound function (where `bind` is spelled), `call`,
  `apply`, `bind`, the held methods.
  - `call`: `apply-arguments(this, args[0], arguments(args, 1, null))`. The count-picked chain and its
    three-argument limit go away (item 3 of the slice falls out of the same mechanism).
  - bound: `apply-arguments(record[0], record[1], arguments(record, 2, args))`.
  - `apply`: by the kinds of `args[1]`: `undefined` / `null` → no arguments; a realm array → its list (below); another
    object or a function → the run-time abort; a primitive → CreateListFromArrayLike's TypeError.
  - `bind`: a `this` that is not a function → the TypeError; else `bind(this, args)`, then `length` (§20.2.3.2 steps
    4–6: HasOwnProperty(target, "length"), Get, a Number → max(0, ToIntegerOrInfinity(L) − count), else 0) and `name`
    ("bound " + Get(target, "name") where a string, else "bound "), seeded with `js.object.init-function`.
- **`dynamic-function-operations.ts`**: `new C(…)` constructs only a value a dispatch arm runs (`is-source`); any other
  function value (a held built-in, a bound function) is the run-time abort. Today a held built-in reached by `new`
  is run by the caller as a call and answers an object where node throws (found while planning; fixed here).

### CreateListFromArrayLike of a realm array

The kernel already has a spec-shaped CreateListFromArrayLike builder (`create-list-from-array-like-body.ts`, used by
the ordinary pipeline's invokers). Whether its bindings (Get, ToLength, index-to-key, vector new/push) are reachable
from the realm-array resource without new cross-pack plumbing is measured first; if they are not, a realm array is the
run-time abort in this slice and the gap is recorded for A1b-3 (which brings the legalization's loop builders).

### Refuses / aborts (each sound)

- `new` of a bound function or of any built-in function value: the run-time abort.
- `apply` with an array-like that is not a realm array (or, per the measurement above, any array).
- A bound function whose target's `length` or `name` is read through an accessor runs the accessor, as Get does.
- `bind` reached without its name being spelled (a computed key): no rung, the run-time abort (as today).

### Code-quality criterion

- One call primitive (`apply-arguments`) for `call`, `apply` and bound calls; no arity-picked chains remain.
- Sibling callables declared in one table per layer; no per-kind special cases outside those tables.
- `from-ast.ts` does not grow; no new import edges across IR/runtime/codegen; gates green against
  `LOC_GATE_BASE=origin/main`.

### Measurement

- Probes against node with wrong twins (≤ 10 compiles per node process); the #7557 test file's rows; the 43
  propertyHelper rows' first stops; the 411-row ES5 sample, base vs head; prelude bytes and median compile time (3 runs);
  ordinary-pipeline byte identity over the 32-binary set.

## Progress

(in progress)
