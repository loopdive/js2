---
id: 7065
title: "codegen (legacy lane): a getter read on a base-typed receiver is statically bound to the declared class's accessor, skipping the subclass override — `a.g` with `a: A` holding a `B` returns A's value (100 instead of 200); the IR half was refused by #7000, the direct path still miscompiles"
status: ready
sprint: current
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: classes, inheritance, accessors, virtual-dispatch
goal: core-semantics
related: [7000, 1299]
---
# Legacy getter devirtualisation

PR #6699 (#7000) fixed the IR half by refusing the claim; the direct-AST path has the same bug for accessors and now runs these programs.

## Repro (node → wasm, both lanes)

```ts
class A { get g(): number { return 100; } }
class B extends A { get g(): number { return 200; } }
function read(a: A): number { return a.g; }
export function test(): number { return read(new B()); }   // node 200, wasm 100
```

## Root cause

The direct-path accessor read (`src/codegen/property-access*.ts`, accessor arms) resolves the getter against the receiver's static class shape and emits a direct call, while method calls go through `src/codegen/expressions/virtual-dispatch.ts` (#1299). Setters likely share the bug.

## Implementation Plan

1. Route accessor reads/writes on a receiver whose static class has a subclass override (reuse `src/ir/class-overrides.ts`'s per-file scan, or the legacy `__tag` dispatch table) through the same virtual dispatch methods use.
2. Tests: getter and setter repros, 3-level chain, exact-instance control (`new A().g` stays direct), in `tests/equivalence/issue-7065-getter-virtual-dispatch.test.ts`.


> Filed from the 2026-10-15 compiler audit follow-ups (surfaced by the #6991–#7001 implementation PRs). Under `plan/method/ir-only-development-freeze.md` a direct-AST semantic fix needs a specific user disposition; IR/shared-runtime work does not.
