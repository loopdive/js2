---
id: 2132
title: "method call on a null receiver is an uncatchable wasm trap instead of a catchable TypeError"
status: ready
sprint: 61
created: 2026-06-12
updated: 2026-06-12
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
