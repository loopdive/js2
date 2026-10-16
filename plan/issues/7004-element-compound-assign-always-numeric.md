---
id: 7004
title: "codegen: compound assignment on `any[]` / `(string|number)[]` ELEMENTS is always numeric — `a[0] += 1` with `a[0] === "5"` traps `dereferencing a null pointer` on standalone and yields `""` on gc (node `"51"`); `o.n += 1` on the same values is correct"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: compound-assignment, coercion, arrays
goal: standalone-gap
related: [6998, 6997]
---

# Element compound assignment skips string concatenation

Reported by the 2026-10-15 audit (coercion lane, CONFIRMED by the audit on both lanes). Not re-run by the lead — reproduce first.

## Repro (node → wasm)

```ts
export function test(): string { const a: any[] = ["5"]; a[0] += 1; return String(a[0]); }   // node "51"; standalone trap, gc ""
```
`a[0] += "1"` same; `(string|number)[]` same. `o["n"] += 1` on an `any` object is a no-op (`"5"`), while `o.n += 1` → `"51"` (correct).

## Root cause

- `src/codegen/expressions/operator-assignment.ts:3355-3358` — the element compound path does `coerceType(elem → f64)` + RHS f64 + `emitCompoundOp`; `+=` never consults the dynamic `+` (ToPrimitive, string concat) path that the property compound path uses.

## Implementation Plan

1. Route the element `+=` on a dynamic/union element type through the same dynamic-add helper the `o.n += 1` path uses (find it in the same file: the property compound arm that handles `any`), i.e. read element → dynamic `+` with the RHS → store. Keep the f64 fast path only when the static element type is `number`.
2. Fix `o["n"] += 1` (computed-key compound on `any`) with the same helper.
3. Tests: the repros + `a[0] -= 1` with `"5"` → 4 (numeric ops still coerce), `a[0] += true`, nested `a[i][j] += "x"`.

## Acceptance

- Repros match node on standalone and gc. `check-coercion-sites` passes.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-7004-element-compound-assign-always-numeric.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
