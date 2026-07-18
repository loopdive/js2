---
id: 3346
title: "standalone: typeof a boxed-number param inside a lifted foreign body reports \"undefined\" (not \"number\")"
status: ready
sprint: Backlog
created: 2026-07-17
updated: 2026-07-17
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: eval
goal: runtime-eval
parent: 2860
related: [2948, 2924, 2923, 1629]
origin: "Split from #2948 acceptance-3 (opus-3, 2026-07-17): the chained any-add half of #2948 is fixed on main; this typeof layer is independent and still broken."
---

# #3346 — `typeof` on a boxed-number param in a lifted foreign body → "undefined"

## Problem

In a **lifted foreign body** (a `ts.createSourceFile` splice with no checker
bindings — the #2923 constant-`eval` lift and the #2924 constant-`Function`
compile-away), parameters degrade to externref (`any`) and numeric arguments
arrive **boxed**. Under `--target standalone`, `typeof` on such a boxed-number
param misreports **`"undefined"`** instead of `"number"`.

This was split out of **#2948** (chained any-add in lifted foreign bodies),
which the issue itself anticipated: *"or split into its own issue if the typeof
layer proves independent."* It IS independent — as of the #745 tagged-union
value-rep work the arithmetic half of #2948 (chained `a+b+c`) computes
correctly, but `typeof` still misclassifies the boxed param.

## Minimal repro (standalone)

```ts
export function test(): number {
  const f = new Function("a", "return typeof a") as any;
  return f(5) === "number" ? 1 : 0;   // -> 0 (returns "undefined"); expected 1
}
```

Verified on main (2026-07-17): `f(5)` yields a 9-char string (`"undefined"`),
i.e. the `typeof` operator classifies the boxed-number param's rep as
`undefined`. The arithmetic controls (`a+b`, `a+b+c`) all compute correctly, so
the boxed value carries a usable number — only the `typeof` classifier misreads
its rep tag.

## Root-cause hypothesis

Same value-rep substrate class as
[reference_1629b_boxed_primitive_typeof_eq_layers]: the standalone `typeof`
lowering does not recognize the marshalled boxed-number rep that a lifted
foreign body's `any` param carries, so it falls through to the `undefined`
arm. The fix likely lives alongside the boxed-primitive `typeof`/`===` rep
classifier rather than in the eval/Function lift machinery (the lift correctly
delivers a usable value — arithmetic proves it).

## Acceptance criteria

- [ ] `new Function("a","return typeof a")(5) === "number"` standalone.
- [ ] `eval("function q(a){return typeof a} q(5)") === "number"` standalone.
- [ ] No regression to the #2948 arithmetic behavior or host (gc) mode.

## Notes

Found while landing the #2948 verification/regression-lock (opus-3, 2026-07-17).
Umbrella: #2860 (standalone-vs-host gap). Goal: `runtime-eval`.
