---
id: 4429
title: "String-hint ToPrimitive drops the receiver `this` — `'' + a` / `String(a)` call toString with wrong this (in-tree #2679 tests failing)"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: to-primitive
goal: standalone-gap
related: [2679, 4426]
origin: "2026-08-15 ES5-standalone session — tests/issue-2679-toprimitive-this.test.ts has 2 failing cases, reproduced identically at merge-base 63785cb (silent regression of the #2679 fix, string-hint half)."
---

# #4429 — string-hint ToPrimitive drops the receiver `this`

## Problem

Two cases of the COMMITTED test `tests/issue-2679-toprimitive-this.test.ts`
fail on current main (vitest, no test262 involved):

- `'' + a` calls `toString` with `this === a` → expected 1, got 0
- `String(a)` calls `toString` with `this === a` → expected 1, got 0

for `var tv; var a = { toString() { tv = this; return "x"; } }`. The
`@@toPrimitive` and every NUMBER-hint case in the same file pass — the
number-hint dispatch installs `__current_this` around the call
(`type-coercion.ts` ~3153, the #2679 fix); the string-hint path was
documented there as "static-dispatches the raw method with the receiver as
param-0, was correct", which is evidently no longer true. test262 tests are
not the trigger here but the same defect underlies `Object.prototype`-level
`toString` receivers across the ES5 standalone `object-to-primitive`
bucket (36 ES5 rows).

## Implementation Plan

1. Reproduce: `npm test -- tests/issue-2679-toprimitive-this.test.ts` —
   2 failures expected. These are vitest tests; fastest loop available.
2. The string-hint dispatch emitters live in `src/codegen/type-coercion.ts`:
   - `tryStructPrimitiveToString*` (~line 180–290): the toString-first
     OrdinaryToPrimitive(string) static dispatch — closure-ref arm (~225,
     `emitGuardedFuncRefCast` + `call_ref`) and eqref candidate-chain arm
     (~280).
   - `tryStructToString` (~3496) and its `normaliseToString`.
   Determine which arm the test's shape takes (object-literal method → the
   `__obj_meth_tramp_*` trampoline reads `this` from the `__current_this`
   GLOBAL, not param-0 — the exact mechanism the number-hint fix (#2679)
   documents at ~3132). The probable root cause: object-literal methods
   moved to trampolines after the string-hint path was written, so the
   "receiver as param-0" claim silently rotted.
3. Fix: mirror the #2679 `__current_this` save/install/restore around the
   string-hint dispatch arms (both closure-ref and eqref chains), reading
   `ctx.currentThisGlobalIdx` FRESH at each global op (the ~3156 comment
   documents the mid-dispatch global-shift hazard — copy that discipline,
   and note the #4426 session restructured the number-hint candidate chain
   at ~3082, so diff against that shape, not the pre-#4426 one).
4. Sanity: whole `tests/issue-2679-toprimitive-this.test.ts` green (13/13);
   `tests/es5-standalone-callable-tostring.test.ts` and
   `tests/issue-4208-ordinary-to-primitive-ir.test.ts` stay green; scoped
   standalone run over `language/types/object|built-ins/Object/prototype`
   for flips in the object-to-primitive bucket.

## Acceptance criteria

- All 13 cases of `tests/issue-2679-toprimitive-this.test.ts` pass.
- No regression in the ToPrimitive-adjacent suites named above.
