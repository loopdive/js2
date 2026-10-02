---
id: 6803
title: "codegen: TypeScript parameter properties (`constructor(public n: number) {}`) never assign the field — every read is NaN"
status: ready
sprint: Backlog
created: 2026-10-01
updated: 2026-10-01
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: classes
goal: core-semantics
related: [6787]
requested_by: ttraenkler/claude-review
origin: "found by the #6787 implementation (2026-10-01) while writing class-instance element rows"
---

# #6803 — `public`/`private`/`readonly` constructor parameters are declared but not initialised

## Problem

```ts
class P { constructor(public n: number) {} }
export function run(): string {
  const a = [new P(1), new P(2), new P(3)];
  return JSON.stringify([a.map(p => p.n), a[0].n, a.map(p => p.n * 2)]);
}
```

| lane | result |
|---|---|
| wasm (JS host, 2026-10-01, `9d977a7e`) | `[[null,null,null],null,[null,null,null]]` (NaN serialises as `null`) |
| JS | `[[1,2,3],1,[2,4,6]]` |

The struct gets a field `n` (the read compiles and does not trap) but the
constructor body never stores the parameter into it. TS's `transpileModule`
inserts `this.n = n;` as the first statement of the constructor body for every
parameter with an accessibility modifier or `readonly`; the compiler walks the
untransformed AST and sees an empty body.

The only reference to parameter properties in codegen is
`closedFactoryParameterPropertyKeys` in `src/codegen/generic-struct-factory.ts:606`
(the generic-factory specialisation path), so ordinary classes have no
handling at all.

## Correction

In the class-constructor lowering (the site that emits the field stores for
`this.x = …` and the implicit `super()` ordering), synthesise
`this.<name> = <param>` for every parameter where
`ts.isParameterPropertyDeclaration(param, ctor)` is true, **after** the
`super(...)` call for derived classes and before the first user statement
(TS semantics). Cover the IR lane (`src/ir/from-ast.ts` class lowering) the
same way or route it through the same helper.

## Acceptance

- The probe matches JS on both lanes; a derived-class variant with
  `super(x)` followed by a parameter property, and a `private readonly`
  variant, are asserted in a new `tests/equivalence/` file.
- `pnpm run -s test:guard` unchanged; the row is added to
  `tests/guard-suite.json` (class syntax this common must stay pinned).
