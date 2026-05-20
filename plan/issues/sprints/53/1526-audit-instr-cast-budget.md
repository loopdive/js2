---
id: 1526
sprint: 53
title: "Audit `as unknown as Instr` cast budget — restore type safety on Wasm ops"
status: ready
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: codegen
goal: maintainability
related: [1095]
---

# #1526 — Audit `as unknown as Instr` cast budget — restore type safety on Wasm ops

## Problem

`CLAUDE.md` documents:

> `as unknown as Instr` for Wasm ops not yet in the Instr union (f64.copysign,
> f64.min/max) — **158 occurrences, tracked for cleanup**.

Today: **379 occurrences** (`grep -rn "as unknown as Instr" src/ | wc -l`).
That's 140 % growth since the "tracked" line was written. The cast bypasses
TypeScript's instruction union check, so any new Wasm opcode can be emitted
without the type system noticing — including invalid bytecode patterns.

Distribution (top files):
- `src/codegen/expressions/calls.ts` (8,389 LOC)
- `src/codegen/index.ts` (8,313 LOC)
- `src/codegen/array-methods.ts` (5,908 LOC)

A prior issue (#1095) flagged 273 sites and was marked `Ready (L)`. It
has not progressed and the number has grown.

## Acceptance criteria

1. **Inventory**: a one-off script `scripts/audit-instr-casts.mjs`
   enumerates every `as unknown as Instr` site, groups them by the Wasm
   op being emitted, and writes a categorised report to
   `plan/log/instr-cast-inventory.md`.
2. **Union update**: for ops that are first-party Binaryen instructions
   (e.g. `f64.copysign`, `f64.min`, `f64.max`, `i32.extend8_s`,
   `i64.extend_i32_s`, etc.), add them to the `Instr` union in
   `src/codegen/...` and delete the casts. Target: eliminate ≥ 50 % of
   the current 379 occurrences in one PR.
3. **Budget gate**: a CI check fails if the cast count grows above the
   post-PR baseline. The number lives at
   `scripts/instr-cast-baseline.json` and PRs that need to grow it must
   update it explicitly (similar to the IR fallback budget pattern).
4. **Remaining sites are categorised**: each leftover cast either has
   an inline `// reason:` comment naming the missing union member, or is
   linked to a tracking issue.

## Implementation notes

- The Binaryen TypeScript types may already cover most of the missing
  ops — the project's local `Instr` union may simply be out of sync.
  Check `node_modules/binaryen` types as a starting point.
- Be careful with op variants that take immediate operands — those may
  need new union members per immediate set.
- Coordinate with #1095; supersede it if this issue covers the scope.
