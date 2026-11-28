---
id: 7503
title: "pristine-builtin-global proof misses escaped global-object writes; needed before globalThis/script `this` lower"
status: backlog
sprint: Backlog
created: 2026-11-26
updated: 2026-11-28
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
blocks: [7609]
related: [7363, 7354, 7628, 7638]
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

## Delta from #7638 (2026-11-28)

#7638 ("`pristine` misses a realm global rebound through the global object") is closed as a duplicate of this issue.
What it adds:

- **How to judge a computed key.** A write whose key is not a literal (`this["Num" + "ber"] = …`) names a realm
  global when the key's possible values (#7628's `keyValues`, `src/ir/key-values.ts`) may include that name. The
  writes are the ones the member-write scan already collects (`src/ir/realm-member-writes.ts`: stores, compound
  writes, `delete`, destructuring and for-in / for-of targets, and the key writers `defineProperty`,
  `defineProperties`, `assign`, `__defineGetter__`, `__defineSetter__`); the pristine proof asks that scan for writes
  that may reach the global object. No second walk.
- **Three repro rows**, each followed by `Number.isNaN(1)` (node answers 7):
  - `Object.defineProperty(this, "Number", {value: {isNaN: function () { return 7; }}});`
  - `Object.assign(globalThis, {Number: {isNaN: function () { return 7; }}});`
  - `this["Num" + "ber"] = {isNaN: function () { return 7; }};`

  Repro script: `plan/samples/7628/probe-global.mts` at commit `77cd8bb312`.

**Measured on main `330caff2a8` (2026-11-28, Prepared entry, runner options): no row gives a wrong answer today.**

| write | outcome |
| --- | --- |
| `Object.defineProperty(this, "Number", …)`, `Object.defineProperties(this, {Number: …})` | compile; abort at run time with `unreachable` (#7609's sealed global object) |
| `this["Num" + "ber"] = …` | refused: "dynamic operation dyn.member_set with a computed key has no Prepared intrinsic" |
| `Object.assign(globalThis, …)` | refused: `identifier "Object" is not in scope in <module-init>` |
| `globalThis.Number = …` | refused: `identifier "globalThis" is not in scope in <module-init>` |
| `Reflect.set(this, "Number", …)` | refused: `identifier "Reflect" is not in scope in <module-init>` |

So the rows become reachable only when #7609 lowers a write through the global object (its slices B and C), or when
`Object` / `globalThis` / `Reflect` lower as values. This issue lands first: `blocks: [7609]`.

## Acceptance criteria

- `pristineBuiltinGlobal` returns false for each hole above, with one test row per shape, for both users.
- No change in claims or bytes for programs without such a use.
