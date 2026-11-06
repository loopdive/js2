---
id: 7006
title: "standalone: array ToPrimitive through `+`/`==` renders nested array elements as `[object Object]` — `[[1,2],[3]] + ""` gives `"[object Object],[object Object]"` (node `"1,2,3"`), `[[]] == 0` is false; `String(a)` and `a.join()` are correct because two different join engines exist (`array-to-primitive.ts` vs `array-join-element.ts`)"
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
language_feature: coercion, arrays, toString
goal: standalone-gap
related: [4515, 6998]
---

# Array ToPrimitive uses a second, non-recursive join

Reported by the 2026-10-15 audit (coercion lane, CONFIRMED standalone). Not re-run by the lead — reproduce first.

## Repro (node → wasm, standalone)

```ts
export function test(): string { const a: any = [[1, 2], [3]]; return a + ""; }   // node "1,2,3", wasm "[object Object],[object Object]"
```
`const a: number[][] = [[1,2]]; a + ""` → `"[object Object]"`; `[[]] == 0` → false; `+[[]]` → NaN; `[[true]] + ""` → `"[object Object]"`. `String(a)` / `a.join()` are correct.

## Root cause

- `src/codegen/array-to-primitive.ts:178-205` — `__array_to_primitive_string` hard-codes a `join(",")` that calls `__any_to_string` per element and does not recurse into vec elements, whereas `.join()`/`String()` use `buildJoinBoxedElementToString` (`src/codegen/array-join-element.ts:73`) → `__extern_toString`, which recurses.

## Implementation Plan

1. Delete the private join in `array-to-primitive.ts` and call the `array-join-element.ts` engine (one join). If the two have different null/undefined → `""` handling, the join-element one is the spec-correct one (`Array.prototype.join` step 7).
2. Tests: the repros + `[null, undefined, [null]] + ""` → `",,"`, `[1, [2, [3]]] + ""` → `"1,2,3"`, `[] + {}`, `{} + []` (statement vs expression position only in expression form).

## Acceptance

- Repros match node on standalone; gc unchanged. `check:dead-exports` passes after removing the duplicate.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-7006-array-toprimitive-nested-join.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
