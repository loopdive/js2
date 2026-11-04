---
id: 7215
title: "Constructor parameter properties (`constructor(public x)`) are never stored"
status: done
sprint: Backlog
created: 2026-10-31
updated: 2026-11-04
completed: 2026-11-04
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7199]
# 2026-11-04 (#7215): parameter properties reuse the existing property-field
# builder (extracted into a closure, not duplicated) and the existing
# field-initializer store loop in the class constructor. Round 2 (review of
# PR #7045) adds the all-or-none admission check for optional/native
# parameter properties, in the same loops: +40 LOC in class-bodies.ts,
# +31 (collectClassDeclaration) / +5 (compileClassBodiesInner).
loc-budget-allow:
  - src/codegen/class-bodies.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/class-bodies.ts::compileClassBodiesInner
---

# #7215 — TypeScript parameter properties are dropped

Found while implementing #7199 and confirmed by the PR #7017 review on main
(9e82d60c42), all 3 lanes:

```ts
class A { constructor(public x: number, public y: string) {} }
const a = new A(1, 'p');
console.log(JSON.stringify(a), a.x);   // node: {"x":1,"y":"p"} 1 — we: {} NaN
```

## Plan

1. Find where class fields are collected and make parameter properties
   (`public`/`private`/`protected`/`readonly` on constructor params)
   declare fields and emit the `this.x = x` stores at the start of the
   constructor body, before user statements and after `super(...)`.
2. Tests on 3 lanes: plain, `readonly`, mixed with normal fields and
   initializers (order), in a subclass with `super`, and JSON/keys order.

## Resolution (2026-11-04)

**Cause.** Nothing in the legacy class lowering looked at parameter
properties: `collectClassDeclaration` built struct fields only from
`PropertyDeclaration`s and `this.x = …` statements in the constructor body,
and the constructor emitted only property initializers. The IR selector
already declines constructors with parameter properties
(`src/ir/select.ts`, `body-shape-rejected`), so every such class took the
legacy path and lost the fields on all lanes.

**Fix** (`src/codegen/class-bodies.ts`, helper
`constructorParameterProperties` in `src/codegen/ast-modifiers.ts`):

- Each parameter property (`public`/`private`/`protected`/`readonly`/
  `override`, any combination) declares an own field ahead of the class
  properties, through the same builder the property declarations use.
- The constructor stores `this.x = x` right after the own field initializers
  (base class: at entry; derived class: right after `super(...)` returns),
  in parameter order, after parameter defaults are applied. This is the
  `tsc` ES2022 emit (`x; z = …; constructor(x) { super(); this.x = x; … }`).
- The IR path is unchanged and still declines these constructors, so both
  paths agree.

## Not fixed here

Each case below compiles **byte-identically to base**: no field is declared and
nothing is stored.

- **Classes where any parameter property cannot get a field yet** declare none
  of their parameter properties. Declaring only some of them is worse than
  declaring none: a declared field turns `o.next!.v` on an undeclared
  `next` into a struct read off a typed null, which traps, while base falls
  back and does not trap. "Cannot get a field yet" means one of:
  - **An argument that may be `undefined`:** `public s?: string`,
    `public s: string | undefined`, `public p?: P`, `public x?: number`,
    `public c?: boolean`, all without a default. No field slot holds
    `undefined` yet. A typed slot reads `null`/`0`/`false`. An externref slot
    reads correctly but serialises as `"s":null` and, for `x?: number`,
    boxes the omitted argument as `0`. Both were measured in round 2.
  - **A native annotation (`public n: i32`).** An `i32` field fails the IR
    methods' type check, a compile error where base compiled. An `f64` field
    still fails `run` ("'+' operands not provably both-number"). Explicit
    `n: i32` fields fail to compile on base as well.
- **Externref-backed builtin subclasses** (`class E extends Error { constructor(public
  code: number) … }`, also `extends Object`, `Map`, `Array`, …). Their
  own-field writes go through the `$Error_struct`/`$Object` props backing,
  which field initializers do not reach either: `class E extends Error {
  code = 7 }` reads `NaN` on base too.
- **`super(...)` nested in a statement** (`if (f) super(1); else super(2);`).
  The store is not emitted. TS rejects this program (TS2401).

Pre-existing gaps seen while probing. The equivalent explicit-field class has
each of them too, so they are not part of this fix:
- A declared field assigned in the constructor body enumerates before
  earlier initialised fields.
- An uninitialised `number` field reads `0` instead of `undefined`. This shows
  up as `y = this.x * 2`, a TS2729 program, giving `0`.
- On wasi, `"x" in o` and `Object.prototype.hasOwnProperty.call(o, "x")`
  throw.
- `Object.keys` through an abstract-base-typed value omits the derived
  class's own field.

Tests: `tests/equivalence/issue-7215-ctor-parameter-properties.test.ts`
(32 rows × gc/standalone/wasi, diffed against node; includes the undeclared
optional shapes and the native `i32` compile rows).
