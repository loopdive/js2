---
id: 4428
title: "`new Array(<wrapper>)` element loses object identity — x[0] comes back as the unwrapped primitive"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array-constructor
goal: standalone-gap
related: [4426, 2987, 3962]
origin: "2026-08-15 ES5-standalone session — residual of the #4426 §23.1.1.1 single-non-number-argument fix."
---

# #4428 — `new Array(<wrapper>)` element loses object identity

## Problem

After #4426, `new Array(x)` with a provably non-number single argument
builds the one-element array `[x]` (length 1 — correct). But when `x` is a
WRAPPER OBJECT, the stored element is the unwrapped primitive, so identity
asserts fail:

```js
var obj = new Boolean(false);
var x = new Array(obj);
x.length === 1;      // ✓ (fixed by #4426)
x[0] === obj;        // ✗ — x[0] is primitive false (test262 S15.4.2.2_A2.3_T2)
```

Same for `new String("0")` (S15.4.2.2_A2.3_T3: `x[0]` is `"0"`, SameValue
against the wrapper fails). `new Number(0)` (T4) PASSES — so Number
wrappers survive the same lane while Boolean/String wrappers don't.

test262 (ES5 standalone): S15.4.2.2_A2.3_T2, S15.4.2.2_A2.3_T3.

## Implementation Plan

1. Establish WHERE identity is lost — three candidates, probe each:
   a. `new Boolean(false)` / `new String("0")` construction: do these even
      produce a distinct object in standalone, or do they lower to the
      primitive/box directly? Probe `var a = new Boolean(false);
      var b = new Boolean(false); a === b` (must be false — distinct
      objects) and `typeof a` (must be "object"). If construction itself is
      primitive-collapsing, THAT is the bug and the Array test is
      collateral — re-scope to the wrapper constructors
      (`expressions/new-indexed.ts` / `standalone-subclass-ctors.ts`,
      compare with the working `new Number` lane, and check
      `standalone-wrapper-instanceof.ts` (#4276 follow-up) for the current
      wrapper representation contract).
   b. The #4426 one-element path (`new-indexed.ts` `args.length === 1`
      non-number branch): `compileExpression(arg, { kind: "externref" })` —
      does the externref coercion unwrap? Compare the WAT for the `new
      Number` (passing) vs `new Boolean` (failing) arg.
   c. The read side: `x[0]` on an externref vec through the dynamic lane —
      does `__extern_get_idx`/unbox demote a stored wrapper to primitive?
2. Fix at the narrowest failing layer; do NOT introduce a new wrapper
   representation (that is #4276-adjacent substrate — coordinate via the
   issue files if the fix would collide with
   `src/codegen/standalone-wrapper-instanceof.ts`).
3. Verify with the single-test driver
   (`runTest262File(path, cat, 15000, "standalone")`):
   S15.4.2.2_A2.3_T2/T3 flip; T1/T4/T5 stay green; scoped filter
   `built-ins/Array/length` shows no regression.

## Acceptance criteria

- S15.4.2.2_A2.3_T2 and _T3 pass standalone; _T1/_T4/_T5 remain passing.
- `a === b` for two `new Boolean(false)` is `false`, `typeof` is
  `"object"` — or, if wrapper-construction identity is deliberately out of
  scope, the issue documents the layer where identity is lost and files the
  residual against the wrapper-constructor issue.
