---
id: 7072
title: "issue-tests wave 15 (grep/other/sentinels): five compiler regressions the blind detector hid, and the 11 sentinel pins they unblock"
status: done
sprint: Backlog
assignee: "ttraenkler/wave15-grep-other-sentinels"
created: 2026-10-18
updated: 2026-10-18
completed: 2026-10-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: n/a
goal: ci-hardening
related: [7014, 7073, 4489, 4491, 4492, 4655, 1277, 2176, 4076]
requested_by: ttraenkler/wave15-grep-other-sentinels
loc-budget-allow:
  # 2026-10-18: +37 — `pinNameMatchedGrowableLiteralTypes` (the T4 open-carrier
  # lockstep pass) lives next to the name-keyed collector it complements and
  # reuses its private `recordOpenObjectConsumerTypes`.
  - src/codegen/declarations/object-shape-widening.ts
  # 2026-10-18: +3 — the synthetic-call position guard and its comment.
  - src/codegen/regexp-standalone.ts
func-budget-allow:
  # 2026-10-18: +1 — the call to the lockstep pass at the end of the collector.
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
---

# #7072 — issue-tests wave 15: grep / other / sentinel slice, compiler fixes

Follow-up of [#7014](./7014-issue-tests-detector-red-since-july.md) (the
`issue-tests` detector was blind from July to 2026-10-15). This slice is the
source-grep / "other" classes plus the four files whose red test blocked
promoting their `it.fails` pins. Stale-test re-pins are in #7073; the parts too
large for this wave are #7074–#7077.

## Root causes fixed (each with the regression test that was red)

1. **Synthetic `recv.toString()` has no source position** —
   `src/codegen/regexp-standalone.ts`. `String(arr)` on an array is lowered by
   #2160's `tryEmitArrayToStringNative` to a synthetic `arr.toString()` call;
   when an `Array.prototype.toString` override is live, the #4556 two-arm
   compiles that call, and the RegExp toString claim called `expr.getStart()`
   on it (13a0918337). TypeScript's "Node must have a real position" assert
   turned the whole function into a compile error. Use the receiver
   identifier's position for a synthetic call. Pin:
   `issue-4492-wave5` R1 CONTROL ("a NAMED array receiver DOES honour the
   override").
2. **A name-keyed open object kept its closed struct type** —
   `src/codegen/declarations/object-shape-widening.ts`. `growableObjectLiteralVars`
   is keyed by NAME, so a module-level `var object` redeclared with diverging
   shapes makes every `var object = {…}` literal — including a fresh one inside
   a function — build as an open `$Object`. Its checker type still resolved to
   the closed anonymous struct, so `new Array(object)` / `[object]` built a
   struct-typed vec, guard-cast the `$Object` and stored NULL: the element's own
   `toString` was never called. New `pinNameMatchedGrowableLiteralTypes` pins
   those literals' types to the open carrier (standalone only). Pin:
   `issue-4655` `S15.4.4.2_A1_T4.js` — the ES5 row the edition ratchet lists as
   "has failed since the floor was seeded" now passes.
3. **CommonJS named exports vanished** — `src/cjs-rewrite.ts`. Since the
   single-assignment rewrite (ad543a660e) `module.exports = { inc, dec }`
   became `export default { inc, dec }`, which the declaration walker's
   pattern 1c never sees: `inc`/`dec` were no longer Wasm exports, and a
   multi-file importer's `const { Config } = require(…)` failed TS2614. The
   rewrite now adds `export { inc, dec }` for every shorthand / `key: ident`
   property naming a top-level declaration. Pin: `issue-1277` (3 tests).
4. **Script `let name` assigned as lib.dom's `const name`** —
   `src/codegen/expressions/helpers.ts`. In a Script the checker resolves the
   reference to the ambient lib symbol alone, so `isConstIdentifierAssignmentTarget`
   saw a `const` and `let name = "a"; name = "b"` threw "Assignment to constant
   variable" (both lanes). Fall back to the user binding (`findUserBindingDecl`,
   the #2176 read-side helper). Pin: `issue-2176-template-literal-interp`.
5. **Standalone minted `env::__to_property_key`** —
   `src/codegen/builtin-prototype-brand.ts`. 6cf0f5555c routed
   `hasOwnProperty`/`propertyIsEnumerable.call(nullish, key)` through a late
   import; standalone owns the native `__to_property_key` in the object runtime,
   so ensure that runtime first. Pin: `issue-4076` (7 tests).

## Sentinel pins promoted (11)

`issue-4489` (1), `issue-4491-wave4` (2), `issue-4492-wave5` (4),
`issue-4655` (4) — each `it.fails`/`failSource` measured passing on main.
`issue-4489`'s and `issue-4491-wave4`'s other red tests were stale (strict
module goal makes them early/runtime errors by spec); they now compile as a
synthetic-`export` Script (`inferModuleStrictArguments: false`, #6988).
