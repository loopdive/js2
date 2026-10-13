---
id: 6975
title: "standalone: `y.prototype = new K` keeps the fnctor struct as the prototype; `__object_create` drops a non-plain proto, so subclass instances lose inherited methods (Octane box2d `Box2D.inherit` → `SetAsEdge` not a function)"
status: done
completed: 2026-10-11
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-10-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: constructor-functions, prototype, new
goal: standalone-gap
related: [6974, 6970, 6969, 6951, 6944]
loc-budget-allow:
  # 2026-10-11 (#6975) new-super.ts +4: the reconstruct consumer check's doc gains
  #   case (c), the `.prototype` store; the predicate itself lives in
  #   fnctor-instance-object-slot.ts (`isPrototypeStoreValue`). Also restates
  #   #6974's +1 (its import) so the grant is not stranded if #6974 lands first.
  - src/codegen/expressions/new-super.ts
---

# A `new F` result stored as a prototype stays a fnctor struct

Found by the #6974 implementer (Session D, 2026-10-11). This is box2d's next standalone blocker after
#6974 (PR #6652). Module init and `new b2World(gravity, true)` now complete, then `shape.SetAsEdge(...)`
throws `TypeError: called value is not a function`.

## Cause

`Box2D.inherit` does `function K(){}; K.prototype = x.prototype; y.prototype = new K;`. Because that
`new K` sits on the right of a property assignment, it stays a fnctor **struct** instead of a plain
runtime object. `fnctorNewResultConsumedAsExternref` (`src/codegen/expressions/new-super.ts`) does not
accept that position.

When `new <subclass>` runs, `__object_create(proto)` keeps a prototype only if it is a plain
`$Object`. So the struct is dropped and the subclass loses its inherited methods.

The minimized repro is in the #6974 issue file's Remaining section, and in the #6974 implementer's
worktree `.tmp/`.
- node: `number:number:true:true`
- standalone: `number:undefined:false:true`

## Plan

1. Make a `new F` result stored into a `.prototype` member write lowered as a runtime object. The
   #6974 implementer's unshipped experiment extended `fnctorNewResultConsumedAsExternref` to accept
   `<member> = new F`, and that fixed every `inherit`-shaped repro. Prefer the narrowest form: the
   target is a `.prototype` property, or the result flows into a prototype slot. Alternatively, teach
   `__object_create` to accept a fnctor-struct prototype through the #6944 struct-link helpers. Pick
   whichever is smaller and keeps gc byte-identical.
2. Re-measure box2d. The experiment's next failure was in `b2Island.Solve`: `e.m_force.x` reads back
   undefined. Triage it, and fix it here if it is small and the same family; otherwise file it.

## Acceptance

- The `inherit`-shaped repro matches node on standalone.
- A regression test `tests/issue-6975-*.test.ts` covers: an inherit-style subclass method call; a
  direct `new` control; and `instanceof` across the chain.
- Box2d gets past `SetAsEdge`. Report how far it gets: PASS, or the next blocker with a repro.

## Implementation notes (2026-10-11, senior-dev)

The reconstruct gate's consumer check, `fnctorNewResultConsumedAsExternref` (`new-super.ts`),
now has a case (c): the right-hand side of a `<x>.prototype = …` / `<x>["prototype"] = …` store.
The syntactic test is `isPrototypeStoreValue` in `src/codegen/fnctor-instance-object-slot.ts`,
beside the site predicate it pairs with. The value becomes a [[Prototype]] link, which must be an
`$Object`, so an approved empty-body `new K` is emitted as `__object_create(K.prototype)` instead of
a `$__fnctor_K` struct.

Why this and not teaching `__object_create` to accept a struct prototype: `$Object.$proto` is an
`$Object` field, so a struct node would need a new link representation in every walker (#6944's
plan). The store-side change is a predicate, reaches every inherit idiom that uses an empty helper
constructor (box2d `Box2D.inherit`, deltablue `inheritsFrom`, the db12 shape of #6944), and is
narrow: the other reconstruct conditions (standalone, escape-gate approved, empty body, no
arguments) are unchanged.

gc is byte-identical: the predicate is only consulted behind `newExpressionReconstructsAsObject`,
which returns false outside standalone/WASI. Verified by hashing the gc binaries of four probes
base vs head.

## Results

- `tests/issue-6975-new-result-as-prototype.test.ts` (standalone, Script goal, no eval provider):
  the inherit-shaped subclass, the direct `new Sub()` after `Sub.prototype = new K()`, and a
  two-level `instanceof` chain fail on the base (#6974 merged) and pass with the fix; the control
  (`o.k = new K()`) passes on both.
- gc byte-identical: sha256 of the gc binary matches base vs head for the four test sources and
  Octane `deltablue.js`, `box2d.js`, `raytrace.js`.
- Related tests (119 files naming `new-super`, `fnctor-instance-object-slot`, the touched
  predicates, `*fnctor*`, `*prototype*`, #6944/#6951/#6969/#6970/#6974), file-copy A/B: base and
  head both 1189/1235 with the identical 46 failing rows; no pass→fail.
- `node scripts/equivalence-gate.mjs` (after merging `origin/main` a87e4b905a): 1748 passing,
  22 known failures, no new regressions.
- Octane box2d (`--lanes node,standalone --timeout 900`), measured 2026-10-12 on a throwaway
  branch = `c-octane-integ` 3dc4b64076 + #6974 (net diff fcda5c1bb3..ada13070a9, which applies
  cleanly; cherry-picking ada13070a9 alone conflicts because its parent is the #6974 WIP commit)
  + this fix:
  - base (without this fix): standalone `runtime-error — TypeError: called value is not a
    function` (`SetAsEdge`); node 79201.
  - head: gets past `SetAsEdge`, standalone `runtime-error — TypeError: Cannot access property on
    null or undefined at 620:218` (`b2Island.Solve`, `e.m_force.x`); node 47907.
  - head + the throwaway half-fix described under Remaining: standalone **PASS**
    (`pass-unvalidated`, 1206 = 0.03x of node 53340). Node scores vary run to run on the shared
    4-core box.

## Remaining

- **`Sub.prototype = new Base(x)` with a non-empty `Base`** still builds a struct (the
  reconstruct path only covers empty bodies with no arguments), so instances lose `Base`'s
  prototype methods. That is #6944's struct-ancestor walk; not on box2d's path.
- **Next box2d blocker — new issue: a property read folds on the checker's declared `number`
  type of a `var` whose slot was widened to externref.** box2d's `b2Island.Solve` does
  `var b = 0, e = 0, f; … e = this.m_bodies[b]; … e.m_force.x`. In JS mode the checker types `e`
  as `number` (its initializer), while the slot typer gives `e` an externref local because it is
  later assigned an object. `tryEmitPrimitiveAbsentPropertyRead` (`src/codegen/primitive-absent-
  property.ts`, #4483) trusts `ctx.oracle.typeFactOf(e) === "number"` and folds `e.m_force` to
  the constant `undefined`. `typeof e` folds to `"number"` the same way
  (`staticTypeofForType`, `src/codegen/typeof-delete.ts`). Both lanes, also on `main`. Minimized:

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

  Plan: in `tryEmitPrimitiveAbsentPropertyRead`, decline when the receiver is an identifier
  whose allocated slot (local, parameter or module global) is not `f64`/`i32` — the slot is the
  authority, as in `fnctorNewResultConsumedAsExternref`. Give `staticTypeofForType`'s identifier
  caller the same guard (answer `null` → runtime `__typeof`). A 6-line throwaway patch of the
  first half alone (the receiver identifier's `fctx.localMap` slot, via `getLocalType`, must be
  `f64`/`i32` or the fold declines), measured on `c-octane-integ` + #6974 + #6975, makes **box2d
  PASS on standalone** (`pass-unvalidated`; 1677 = 0.02x of node 111036 on 2026-10-11, and 1206 =
  0.03x of node 53340 on 2026-10-12). With that half alone the repro answers
  `number:object:object`: the property read is right, `typeof e` still folds. Not shipped here: it
  is a different family (a static-type fold, not a prototype link) and its files are outside this
  issue's scope. It needs its own issue id.
