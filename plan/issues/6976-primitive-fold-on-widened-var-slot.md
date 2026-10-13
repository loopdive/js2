---
id: 6976
title: "standalone: `e.m_force` / `typeof e` constant-fold on the checker's declared `number` type of a `var e = 0` whose slot is widened to externref by a later object assignment (Octane box2d `b2Island.Solve`)"
status: done
completed: 2026-10-12
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

## Implementation notes (2026-10-12, senior-dev)

`primitiveFactContradictedBySlot` (`src/codegen/primitive-absent-property.ts`) resolves the
operand identifier (parentheses unwrapped) to its allocated slot, in the order the identifier read
itself uses:
- a `fctx.localMap` local, or its ref cell's `valType` when it is a boxed capture;
- then `ctx.capturedBoxGlobals`;
- then the module global.

A slot whose kind is not `i32`/`i64`/`f32`/`f64` contradicts a `number`/`boolean` fact, and the fold
declines. An identifier with no slot keeps the fold.
- **Property read:** `tryEmitPrimitiveAbsentPropertyRead` checks it after its existing narrowing.
- **typeof:** both lowerings, `compileTypeofExpression` and the separate `compileTypeofComparison`
  ladder, now call `typeofFold` (`src/codegen/typeof-delete.ts`). That is `staticTypeofForType`
  plus `typeofFoldContradictedBySlot`, which judges only a `"number"`/`"boolean"` answer, so every
  other fold (string, object, function, undefined) is untouched.

Why the slot and not a wider checker query: the slot typer already decided the binding holds
non-numbers, and declining is always sound. The runtime path reads the value, and a boxed number in
an externref slot still answers `"number"`.

## Results

- `tests/issue-6976-primitive-fold-widened-var.test.ts` (standalone, Script goal, no eval provider):
  - Widened rows: the box2d-shaped local, a boolean local plus a module global, a closure-captured
    var, and a parameter with a numeric default. All 4 fail on base and pass on head.
  - Unwidened control: runs right on both. Its binary is byte-identical to the same source with each
    folded operand spelled as a literal (`typeof 0`, `typeof true`), so the folds still happen.
    A mutant that disables the fold fails this check.
- Binary hashes base vs head, gc and standalone:
  - Changed: only the four widened-var probes and Octane box2d.
  - Byte-identical: the numeric control, the four #6975 probes, and Octane richards, deltablue,
    raytrace, navier-stokes, crypto, splay.
- Related tests (63 files: `*typeof*`, primitive-absent/#4483, #4204/#4491/#2623/#5360, widening),
  file-copy A/B: no pass→fail; the only flips are the four new rows.
- `node scripts/equivalence-gate.mjs`: 1748 passing, 22 known failures, no new regressions.
- All quality gates pass, including loc/func with `LOC_GATE_BASE` = the `origin/main` tip, after
  merging `origin/main` 4594f0adc4.
- Octane on a throwaway branch = `c-octane-integ` 3dc4b64076 + #6974 (net diff
  fcda5c1bb3..ada13070a9) + #6975 (599a3b265c) + this fix, `--lanes node,standalone --timeout 900`:
  - **box2d PASS** (`pass-unvalidated`), standalone 1584 = 0.01x of node 134808.
  - deltablue pass, 274 (node 81983).
  - raytrace pass, 233 (node 68662).

## Remaining

- **Not this issue: a parameter whose slot is inferred `f64` from its call sites loses a later
  object assignment.** `function h(e) { e = 0; e = obj; return typeof e.f } h(1)` gives `h` a
  `(param f64)`, and `e = obj` is coerced into it. The slot is numeric, so the fold is consistent
  with it, but the value is already lost. Both lanes; node answers `object`. The cause is the param
  slot typer, not a fold.
