---
id: 2132
title: "method call on a null receiver is an uncatchable wasm trap instead of a catchable TypeError"
status: done
sprint: 61
created: 2026-06-12
updated: 2026-06-13
completed: 2026-06-13
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: exceptions
goal: core-semantics
related: [785, 2017]
renumbered_from: "residual of #785 (done) — surfaced by #1971 eval-order re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2132 — non-optional method call on a null receiver: uncatchable trap

## Problem

Calling a method on a `null` receiver traps the wasm module
(`dereferencing a null pointer`) instead of throwing a catchable `TypeError`,
so user `try/catch` around the call cannot recover.

```ts
class C { m(): number { return 1; } }
const c: C | null = null;
try {
  (c as any).m();
  return 0;
} catch (e) {
  return 99;
}
// wasm: RuntimeError: dereferencing a null pointer (uncatchable)
// node: returns 99
```

Node throws `TypeError: Cannot read properties of null (reading 'm')` which the
`catch` handles. The compiled module instead executes a raw `ref.cast` / field
access on the null reference, which the wasm engine turns into an untrappable
host RuntimeError that bypasses the module's own exception tags.

## Root cause (pointer)

The method-call lowering for a possibly-null receiver does not emit a null
guard that throws a JS `TypeError` (via the throw/`__throw` path) before the
dispatch. Optional-call (`?.`) was handled separately; the **non-optional**
call on a statically-nullable receiver needs a null check that raises a
catchable TypeError. See call-expression / member-call lowering in
`src/codegen/expressions.ts` and the throw-lowering helper (cf. #2102
`__throw`/throwJsError shared lowering).

## Acceptance criteria

- `const c:C|null=null; try{(c as any).m();return 0}catch{return 99}` → `99`
- The thrown value is a `TypeError` (message-compatible with node where the
  harness checks it)
- Non-null receivers dispatch with no added overhead on the hot path (guard
  only where the type is nullable)
- An equivalence test under `tests/` exercising the catch

## Notes

Verified on main `c19a2e9c1` via `.tmp/triage.mts` / `.tmp/triage2.mts`
(branch `po-1971-triage`). JS-host mode, default options. Coordinate with the
shared throw lowering (#2102) so this reuses one TypeError-emit helper.

## Resolution (2026-06-13)

Fixed in `src/codegen/expressions/calls.ts` (typed-class method dispatch). Root
cause: for a statically-nullable receiver the dispatch compiled the receiver
with the method's non-null `ref` param-0 hint, so `coerceType` emitted a bare
`ref.as_non_null` that trapped on null BEFORE any guard — and `as any` laundered
the `null` out of the receiver's static type so the existing nullability check
never fired.

Two changes:
1. Detect nullability by **peeling** `as` / `!` / parenthesized / type-assertion
   wrappers (`(c as any)` / `c!`) and checking the inner expression's static
   type for `Null|Undefined|Void`.
2. When the receiver may be null, compile it with a **nullable** param-0 hint
   (`ref` → `ref_null`) so the value stays nullable on the stack; the existing
   `ref_null` null-guard then tees it, null-checks, throws a CATCHABLE TypeError
   on the null branch, and re-asserts non-null only on the non-null branch.

### Test Results

`tests/issue-2132.test.ts` (5): `(c as any).m()` / `c!.m()` / undefined receiver
on null → catch returns 99 (was uncatchable `dereferencing a null pointer`
trap); non-null receiver dispatches (`m()`=7, `add(3,4)`=7). Node parity
confirmed. `#789` null-guard tests (5/5), optional-chaining, and
array-prototype-methods unregressed; the `classes.test.ts` failures pre-exist on
clean main (unrelated harness issue). `tsc`/`biome`/`prettier` clean.
