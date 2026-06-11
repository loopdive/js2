---
id: 2063
title: "switch violates strict-equality matching across types: switch(true){case 1:} matches; \"1\" matches case 1; mixed cases crash"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: switch
goal: core-semantics
related: [162, 198, 245]
origin: "2026-06-10 deep-audit sweep (control-flow agent): verified miscompile on main; semantic bug introduced by #198's coercion fix"
---

# #1943 — switch unifies cases into one coercion domain instead of per-case StrictEquality

## Problem

[§14.12.2 CaseClauseIsSelected](https://tc39.es/ecma262/#sec-runtime-semantics-caseclauseisselected)
requires per-case **StrictEquality** (different types ⇒ no match, no coercion).
The compiler instead unifies the whole switch into one comparison domain,
producing silent wrong-branch execution and a runtime crash on valid code.

## Repro (verified on main)

```ts
export function t3(): number {
  const x: any = true;
  switch (x) { case 1: return 100; default: return 0; }
}
export function s(): number {
  const x: any = "1";
  switch (x) { case 1: return 100; default: return 0; }
}
export function t2(): number {  // crash variant
  const x: any = "1";
  switch (x) { case 1: return 100; case "1": return 50; default: return 0; }
}
```

| fn | wasm | node |
|----|------|------|
| `t3` | `100` | `0` (true !== 1) |
| `s` | `100` | `0` ("1" !== 1) |
| `t2` | `RuntimeError: Illegal argument` | `50` |
| `switch(1){case "1":}` | `RuntimeError: Illegal argument` | no match |

## Root cause

`src/codegen/statements/control-flow.ts:551-680` (`compileSwitchStatement`):
if any case is string-typed, everything is compared with string equality
(numeric discriminant/cases get shoved through `wasm:js-string equals` → host
"Illegal argument"); otherwise an externref discriminant is unboxed to f64
(:588-591), i.e. ToNumber semantics — `true`→1.0 and `"1"`→1.0 then `f64.eq`
matches `case 1`. #198 introduced this "type coercion for mixed-type case
clause comparisons" to fix compile errors.

## Fix direction

When the discriminant (or any case) type is not statically homogeneous, keep
the discriminant boxed and compare per-case with a strict-equals helper that
type-tag-dispatches (any-value helpers already exist); only use the unified
f64/i32/string fast path when discriminant and all cases are provably the same
primitive type.

## Acceptance criteria

- All three repros match Node (no match for cross-type, no crash on mixed cases)
- Homogeneous numeric/string switches keep the fast path (no test262 or perf
  regression on the common case)
- `switch` on booleans, null, undefined matches strict-equality

## Dupe check

Grepped `switch` + strict/coerc/mixed/discriminant: #162 (literal-narrowing,
done), #198 (done — introduced the coercion), #245 (string cases, done). The
strict-equality violation itself is unfiled.
