---
id: 3966
title: "fix(codegen): `position++` on an implicit global does not persist — the increment/compound write path does not consult `sloppyImplicitGlobals`"
status: done
completed: 2026-08-25
sprint: current
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
goal: core-semantics
created: 2026-08-01
related: [3956, 2726]
loc-budget-allow:
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/expressions/unary-updates.ts
func-budget-allow:
  - src/codegen/expressions/operator-assignment.ts::compileCompoundAssignment
  - src/codegen/expressions/unary-updates.ts::compilePrefixUpdate
---

# #3966 — increment / compound-assignment write on an implicit global is lost

## Problem

After #3956 the **read** of an implicit global resolves correctly, but an
increment or compound-assignment **write** to one does not persist:

```js
// test/language/types/object/S8.6.2_A5_T2.js (verbatim shape)
this.position = 0;
var seat = {};
seat['move'] = function () { position++ };
seat.move();
if (position !== 1) { /* fails: position === 0 */ }
```

Measured standalone, 2026-08-01: `position` reads back as `0`, so the read
found the global-object property (pre-#3956 it would have been a
`ReferenceError` or the auto-local `0`) but `position++` inside the closure
wrote somewhere else.

Same shape in `test/language/types/object/S8.6.2_A5_T4.js`
(`this["beep"] = function(){__count++}`).

## Suspected cause

`src/codegen/expressions/assignment.ts`'s **simple-assignment** arm has an
unresolvable-identifier branch (§6.2.5.6 PutValue) that emits
`__extern_set(<globalThis>, name, v)` and registers the name in
`ctx.sloppyImplicitGlobals`. The **increment / compound-assignment** path
(`src/codegen/expressions/operator-assignment.ts`) has its own identifier
resolution and does not appear to route through the same carrier — it has a
`${name} is not defined` throw site of its own around line 1800, which suggests
it knows about unresolvable identifiers but resolves them differently.

So the read (`emitImplicitGlobalRead`, `src/codegen/global-environment.ts:57`)
and the increment's write disagree about where the value lives — the mirror
image of the #3956 defect, which was a dropped write against a correct read.

## Scope

Found while measuring #3956; deliberately kept out of that PR so its
+37 / −0 stayed attributable. Independently reproducible with the snippet above
and narrower than #3956.

## Acceptance criteria

- [x] `this.p = 0; (function(){ p++ })(); p === 1` holds in both lanes
- [x] `p = 0; p += 2; p === 2` holds for an implicit global in both lanes
- [x] A/B measured over the affected population with denominators, both directions

## Test Results

- Exact standalone Test262 bucket: 3/3 passing (+3), with no regressions in the
  focused implicit-global cases.
- Focused Vitest: `tests/issue-3966.test.ts` — 5/5 tests passing.
- TypeScript 7 and TypeScript 5 typechecks, formatting, lint, and the invariant
  guard suite pass on the implementation branch.
