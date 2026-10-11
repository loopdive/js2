---
id: 6814
title: "codegen: `this?.x` with no receiver (extracted method, strict module) throws a TypeError on the host lane — JS short-circuits to `undefined`"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: low
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: codegen
language_feature: optional-chaining
goal: core-semantics
related: [6789, 6813]
requested_by: ttraenkler/claude-review
origin: "reported by the #6789 implementation (2026-10-01) as a sibling shape it did not fix; not re-measured by the filer"
---
# #6814 — optional chaining must see the null receiver before the member read

## Problem

```ts
const obj = { x: 1, m() { return this?.x; } };
export function run(): string {
  const m = obj.m;
  try { return JSON.stringify(m()); } catch (e) { return "threw:" + (e as Error).constructor.name; }
}
```

JS: `undefined` (strict-mode `this` is `undefined`, `?.` short-circuits). The
host lane throws a `TypeError` — after #6789 the trampoline's null-receiver arm
throws before the body runs, and before that fix the body trapped on the
`struct.get`. Either way `?.` on `this` never gets to short-circuit.

## Correction

The null-receiver `TypeError` of #6789 is the right default for a plain
`this.x` read (JS also throws there: `undefined.x`). The optional-chain case
needs the body to run with a null `this` and the `?.` lowering to test the
receiver: in the member-access lowering, when the object expression is `this`
and the access is optional, emit the `ref.is_null` short-circuit instead of
relying on the trampoline's precheck — i.e. the trampoline must only throw when
the method body dereferences `this` unconditionally (or the precheck is dropped
and `this.x` throws at the access site, which is also spec-exact).

## Acceptance

- The probe returns `undefined` (JSON `null` is NOT acceptable; return
  `String(m())`) on both lanes; `this.x` without `?.` still throws a catchable
  TypeError.
- Row added to `tests/issue-6789.test.ts`.
