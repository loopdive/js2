---
id: 7368
title: "Prepared path: Object.defineProperty / defineProperties / getOwnPropertyDescriptor through the Object statics table"
status: wont-fix
sprint: current
created: 2026-11-19
updated: 2026-11-26
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: [7364]
related: [7354, 7338, 7339, 7350]
---

# #7368 — Object statics on the Prepared path (superseded by #7354 O1/O2)

## Problem

The Prepared whole-program path had no `Object` statics. In the ES5 census of 2026-11-19 (main `ee3fcdd610`), 26
files stopped at "`Object.defineProperty` is not an admitted Object static" (#7364's named refusal). The branch
`claude/7368-object-statics` (1f27adbe) and its extension `claude/7368-object-statics-dyn-wip` (e91fd017) lowered the
statics through the ordinary pipeline's `objectStaticCallPlan` table. They never opened a PR.

## Why wont-fix

Lane S3's #7354 O1 and O2 (#7415) landed the same statics on main with their own design:
- the realm catalog `NATIVE_OBJECT_STATICS`, with `nativeObjectStaticCall` in `src/ir/realm-static-call.ts`;
- `src/ir/program/dynamic-object-statics.ts` and `dynamic-prototype-methods.ts`;
- the `js.object.descriptor-define`, `descriptors-define`, `own-descriptor` and `has-own` contracts.

An audit on main `2a213940e9` (2026-11-26) put each #7368 change in one of three groups:
- **Equivalent or wider on main.** These are admission, call-site lowering, defines (main reads any descriptor object,
  not only literals), the has-own / enumerable / get-own contracts, `Object.create` (main also serves
  `create(proto, props)`), the TypeError rule (main has one helper, `typeError`, in `dynamic-realm-calls.ts`), a define
  inside a program that catches, and defines on a dynamic home.
- **Matching node.** Every #7368 test program, run through the strict Prepared entry on main, matches node, apart from
  bindings that need a function value, which is a #7354 function-kind gap.
- **No yield.** On S3's 411-file ES5 sample, main passes 83 of 411, and the #7368 remainder removes no first stop.

## Left open (no measured yield, not filed)

- A String receiver of `hasOwnProperty` / `propertyIsEnumerable` / `getOwnPropertyDescriptor` aborts at run time on
  main: `Object.getOwnPropertyDescriptor("abc", "x")` traps, where node answers `undefined`. The fix answers a constant
  key that no String owns, and keeps the run-time abort for `length`, indices and computed keys. It belongs to
  S3 or the strings lane.
- The ordinary pipeline (`objectStaticCallPlan`) and the realm (`nativeObjectStaticCall`) keep two Object-statics
  admissions. Folding them into one is a quality cleanup.
