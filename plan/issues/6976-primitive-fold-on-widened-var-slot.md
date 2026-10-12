---
id: 6976
title: "standalone: `e.m_force` / `typeof e` constant-fold on the checker's declared `number` type of a `var e = 0` whose slot is widened to externref by a later object assignment (Octane box2d `b2Island.Solve`)"
status: in-progress
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-10-12
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: var, typeof, property-access, type-facts
goal: standalone-gap
related: [6975, 6974, 4483, 6967]
loc-budget-allow:
  # 2026-10-12 (#6976) typeof-delete.ts +7: the import of the slot predicate and
  #   the 4-line `typeofFold` wrapper both typeof folds call. The predicate
  #   itself lives in primitive-absent-property.ts beside the property-read fold.
  - src/codegen/typeof-delete.ts
---

# A static `number` fold on a var whose slot was widened

Found by the #6975 implementer (Session D, 2026-10-12). This is box2d's **last** known standalone
blocker after #6974 (PR #6652) and #6975 (PR #6653). With a throwaway patch for the property-read
half below, box2d gets a **PASS** row on standalone (`pass-unvalidated`, the same as node's own lane).

## Cause

box2d's `b2Island.Solve` does `var b = 0, e = 0, f; … e = this.m_bodies[b]; … e.m_force.x`.
- In JS mode the checker types `e` as `number`, from its initializer.
- The slot typer gives `e` an **externref** local, because `e` is later assigned an object.

Two folds trust the checker instead of the slot:
- `tryEmitPrimitiveAbsentPropertyRead` (`src/codegen/primitive-absent-property.ts`, #4483) sees
  `ctx.oracle.typeFactOf(e) === "number"` and folds `e.m_force` to the constant `undefined`.
- `staticTypeofForType` (`src/codegen/typeof-delete.ts`) folds `typeof e` to `"number"`.

Both lanes are affected, also on `main`.

## Repro

```js
function B() { this.f = { x: 1 }; }
var arr = [new B()];
function get() { return arr; }
export function main() {
  var e = 0;
  e = get()[0];
  return typeof e + ":" + typeof e.f + ":" + typeof e["f"];
}
```

node `object:object:object`; standalone and gc `number:undefined:object`.

## Plan

1. In `tryEmitPrimitiveAbsentPropertyRead`, decline the fold when the receiver is an identifier
   whose allocated slot (local via `fctx.localMap` + `getLocalType`, parameter, or module global) is
   not `f64`/`i32`. The slot is the authority, as in `fnctorNewResultConsumedAsExternref`.
2. Give `staticTypeofForType`'s identifier caller the same guard: answer `null`, so the runtime
   `__typeof` is used.
3. Keep every fold whose slot really is a number. Unwidened `var n = 0` must still fold, so that
   hot numeric code doesn't lose the constant.

## Acceptance

- The repro matches node on standalone (and gc).
- `tests/issue-6976-*.test.ts` covers: a widened var property read and `typeof`; an unwidened
  numeric var control (the fold must still apply: check the wasm has no runtime `__typeof` call for
  it, or that the result is identical); and a parameter case.
- **Octane box2d `--lanes node,standalone`** on c-octane-integ + #6974 + #6975 + this: a PASS row.
- gc output is unchanged except for widened-var sites.
