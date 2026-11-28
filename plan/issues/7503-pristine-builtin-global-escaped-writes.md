---
id: 7503
title: "pristine-builtin-global proof misses escaped global-object writes; needed before globalThis/script `this` lower"
status: backlog
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7363, 7354]
---

## Problem

`pristineBuiltinGlobal` (`src/ir/builtin-global-binding.ts`, #7354 O1) proves that an identifier reads the realm's
unchanged built-in: lib-declared only, no source binds the name, and no source writes it. Its write walk sees direct
identifier writes and static member writes through a global alias (`globalThis.X = …`, `this.X = …`). It does not
see a write that reaches the global object some other way:

- a computed key: `globalThis["Obj" + "ect"] = f`;
- an escaped global-object value: `var g = globalThis; g.Object = f`, or the value passed to a function;
- `Object.defineProperty(globalThis, "Object", …)`, `Reflect.set`, `Object.assign(globalThis, …)`;
- code run by the runtime-eval provider or the `Function` constructor;
- a literal-key element write: `globalThis["Object"] = f`, `this["Object"] = f`;
- `delete Object` (#7363 A4 adds `DeleteExpression` to the walk; this row pins it);
- **compiles today:** a sloppy function that reads ambient `this`, called as a value:
  `function f(){return this} var h = f; var G = h(); G.Object = …`. It compiles on the Prepared path and is held
  only by the run-time trap in sloppy `dyn.current_this`; it becomes a wrong value once the global object
  materialises on standalone (PRV-A4, verified on main). #7363 A4 refuses it for `eval` with the contracts'
  `ambientThisMayBeGlobal` flag (`source-dynamic-contracts.ts`: a sloppy function whose own `this` escapes,
  `ownThisEscapes`); the `Object` statics must ask the same flag.
  The same holds for a plain call with no function value at all (`function f(){return this} f().Object = …`):
  A4's flag judges the code's own strictness for that reason (RV7502 finding 4).
- **misjudged strictness:** `isStrictContext` reports an object-literal method (`{ m(){ return this } }`) as
  strict, so the flag does not see its `this`. Extracting it (`var h = o.m; h()`) refuses today ("closure must have
  a return type annotation"); before object-literal methods lower as values, the strictness must be the method's
  real one (sloppy in sloppy code).

## Users

- **The `Object` statics** (#7354 O1: `realm-static-call.ts`, `function-object-lowering.ts`, `identifier-read.ts`):
  the call form and the flow rule read the realm's `Object` when the proof holds.
- **Eval A4** (#7363, "A4 narrowed"): a literal direct eval site is a direct call of its source's unit when the
  global `eval` is pristine, with no run-time identity test.

## Why it is (mostly) sound today

Except the sloppy-`this` row above (held only by a run-time trap), every hole needs the global object as a first-class value or a dynamic code path, and the Prepared path refuses
both: `globalThis` ("identifier "globalThis" is not in scope"), script-level `this` ("'this' reference outside an
instance method body"), a plain call of a `this`-using function ("installs no receiver for its 'this'"), and an
unbound eval statement or indirect eval (#7363 slice 1).

## What must happen first

Before any change makes `globalThis` or script-level `this` lower to a value on the Prepared path, the proof must
refuse a program where that value escapes. That means any use other than a static member read or a static member
write the walk already sees. The proof must also refuse a program with dynamic code. #7363 A4's boundary test fails
when either refusal label goes away and points here.

## Acceptance criteria

- `pristineBuiltinGlobal` returns false for each hole above, with one test row per shape, for both users.
- No change in claims or bytes for programs without such a use.
