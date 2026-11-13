---
id: 7069
title: "codegen: loose `==` between a class instance and an `any` holding the SAME instance is still `false` on both lanes (mixed struct/externref arm); on standalone an IR-claimed `same(a: any, b: any)` traps `illegal cast` for `same({valueOf(){…}}, 1)` (#6997 leftovers)"
status: ready
sprint: current
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: equality, coercion, anyvalue
goal: core-semantics
related: [6997, 6998]
---
# Mixed struct/externref loose equality

Left out of PR #6698 (#6997): that PR fixed the both-struct-ref and both-externref arms; the mixed arm still coerces.

## Repro (node → wasm)

```ts
class C { v = 1 }
export function test(): number { const c = new C(); const a: any = c; return c == a ? 1 : 0; }   // node 1, wasm 0 (both lanes)
function same(a: any, b: any): boolean { return a == b; }
export function test2(): boolean { return same({ valueOf() { return 1; } }, 1); }   // node true; standalone IR-claimed: RuntimeError illegal cast
```

## Implementation Plan

1. In `src/codegen/binary-ops-typed-dispatch.ts` the mixed struct-ref/externref arm: when the externref side is an object (not a primitive box), compare identity after `extern.convert_any` on the struct side, i.e. route through the same ref/ref identity path `===` uses (the #6997 helper `helpers/loose-eq-object-identity.ts`); only when the externref side is a primitive fall through to ToPrimitive.
2. IR lane `__ir_dyn_eq` (`src/codegen/dyn-ops.ts`): the object-vs-number case must call ToPrimitive on the object, not `ref.cast` it to a number box; add the standalone test.
3. Tests in `tests/equivalence/issue-7069-mixed-loose-equality.test.ts`, both lanes.


> Filed from the 2026-10-15 compiler audit follow-ups (surfaced by the #6991–#7001 implementation PRs). Under `plan/method/ir-only-development-freeze.md` a direct-AST semantic fix needs a specific user disposition; IR/shared-runtime work does not.
