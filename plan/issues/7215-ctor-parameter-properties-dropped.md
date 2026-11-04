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
# field-initializer store loop in the class constructor; +13 LOC net in
# class-bodies.ts, +9 / +3 in the two functions that own those loops.
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

**Not covered (unchanged from base, byte-identical):** parameter properties on
externref-backed builtin subclasses (`class E extends Error { constructor(public
code: number) … }`). Their own-field writes go through the `$Error_struct`
props backing, which the field-initializer loop does not reach either
(`class E extends Error { code = 7 }` reads `NaN` on base too). Needs a
follow-up.

Pre-existing gaps seen while probing, also present for the equivalent
explicit-field class and so not part of this fix: a declared field assigned
in the constructor body enumerates before earlier initialised fields; an
uninitialised `number` field reads `0` instead of `undefined`; `"x" in o` /
`Object.prototype.hasOwnProperty.call(o, "x")` throw on wasi.

Tests: `tests/equivalence/issue-7215-ctor-parameter-properties.test.ts`
(27 rows × gc/standalone/wasi, diffed against node).
