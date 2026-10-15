---
id: 6999
title: "standalone: relational `<,<=,>,>=` on `any`/`unknown`/`string|number` string operands compares numerically (NaN → false) — the #2059 string-aware any-arm is gated on `anyValueTypeIdx < 0`, which is never true in standalone, so `"b" > "a"` is false and `any[].sort((x,y)=>x<y?-1:1)` leaves strings unsorted; the IR lane (`__ir_dyn_lt`) is correct"
status: done
completed: 2026-10-15
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: relational, coercion, anyvalue
goal: standalone-gap
related: [2059, 1374, 6998]
---

# Relational operators on dynamic strings compare numerically on standalone

Found by the 2026-10-15 audit (coercion lane). Standalone only, legacy lane; #2059 is `done` but regressed in standalone.

## Repro (node → wasm, standalone)

```ts
export function test(): number { const a: any = "b", b: any = "a"; return (a > b ? 1 : 0) + ((a as any) < "b" ? 0 : 10); }  // node 1, wasm 10
```
`("2" as any) < ("10" as any)` → true (numeric); `function f(a: string|number, b: string|number){ return a > b }` `f("b","a")` → false, `f("10", 9)` → false; `arr.sort((x,y) => x<y?-1:x>y?1:0)` on `any[]` leaves `["b","a","c"]` unsorted. Top-level `function lt(a: any, b: any){ return a < b }` is IR-claimed and correct.

## Root cause

- `src/codegen/binary-ops.ts:2189` — `const anyArm = ctx.anyValueTypeIdx < 0 && (leftIsAnyish || rightIsAnyish);` In standalone `anyValueTypeIdx` is always ≥ 0, so the string-aware `emitAnyRelational` arm is shut and the op falls to the f64 `__to_number` lowering. `relational-to-primitive.ts`'s header documents exactly this hazard but only re-opened the OBJECT arm.

## Implementation Plan

1. Open the any-arm for standalone: the `anyValueTypeIdx < 0` exclusion exists because of the #1374 host-comparator hazard, which cannot occur on standalone (no host operator). Change the gate to `(ctx.anyValueTypeIdx < 0 || ctx.standalone || ctx.wasi) && (leftIsAnyish || rightIsAnyish)` AND confirm `emitAnyRelational` works on the AnyValue carrier (it may call a host helper; if so, implement the AnyValue version: both operands ToPrimitive(hint number); if both are strings → lexicographic UTF-16 compare via the native string compare already used by `===`/`localeCompare`-free paths in `string-ops.ts`; else ToNumber both and f64 compare with NaN → false). Prefer calling the IR's `__ir_dyn_lt` family (`src/codegen/dyn-ops.ts:152`) so legacy and IR share ONE implementation — but check the audit's note that `ensureDynamicRel` in `ctx.fast` aliases to `__any_*` helpers; verify those helpers have the string arm.
2. Extend to `string | number` union operands (not `any`): the same arm must admit `TypeFlags.Union` containing string and number; today they also fall to numeric.
3. Tests: the repros + `"a" <= "a"` true, `"a" < "b"` true, `"10" < "9"` true (both strings → lexicographic), `"10" < 9` false (mixed → numeric), `null < 1` true, `undefined < 1` false, sort of `any[]` strings.

## Acceptance

- Repros match node on standalone; gc byte-identical.
- `tests/equivalence/issue-2059*` (if present) and `*relational*` pass.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6999-standalone-relational-any-strings-numeric.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.

## Implementation notes (2026-10-15)

- **Step 1 finding: `__any_lt` does NOT have a string arm.** `addComparisonHelper` (`src/codegen/any-eq-helpers.ts`) emits `__any_to_f64(a) f64.lt __any_to_f64(b)` for all four relational helpers, and `__any_to_f64` reads `f64val` for a tag-5 string. The IR's `ensureDynamicRel` aliases `__ir_dyn_*` to these `__any_*` helpers only under `ctx.fast`; on the native-first (non-fast) standalone path it builds its own correct helper (`__typeof_string` both → `__str_compare`, else `__unbox_number`). The legacy `emitAnyRelational` standalone branch already does the right thing — ToPrimitive(number) both (`reduceRelationalOperandsToPrimitive`), then the same both-strings / numeric split — so no new runtime code was needed: only the gate was wrong.
- **Fix**: `admitsAnyRelational` (new, `src/codegen/relational-to-primitive.ts`) replaces the inline `anyArm` gate in `compileBinaryExpression`. js-host lane: exactly the old predicate (`any`/`unknown` operand AND `anyValueTypeIdx < 0`). No JS host (`semanticProviders === "native-first"`, native strings ready — the same readiness `admitsObjectRelational` and `emitAnyRelational`'s in-module branch require): admits `any`/`unknown` regardless of `$AnyValue` registration, plus (step 2) string-mixed primitive unions (`string | number`, `string | boolean`; BigInt excluded). `__any_lt`/`__any_le`/… were not touched (they still serve `ctx.fast` and the IR alias), so the legacy and IR lanes now agree on standalone without sharing a helper.
- **Numeric shortcut (perf, found by the #3765 pre-push check)**: opening the arm sent every untyped-JS `any` relational through the cascade — in the acorn-style tokenizer twin, `this.pos < this.input.length` (both sides already `f64` slots) gained `__box_number` ×2 + `__to_primitive` ×2 + `__typeof_string` per loop iteration. `compileRelationalOperandsToExtern` (new `src/codegen/relational-operands.ts`) now compiles the operands of the host-free any-arm at their natural type first; two Wasm numbers (f64 / non-symbol i32) compare with a plain `f64.<op>` (§7.2.13 on Numbers), anything else is boxed for the cascade. The default path (js-host lane, OBJECT arm) is the old operand code moved verbatim.
- **gc byte-identical**: hashed every binary compiled by `string-relational-operators`, `comparison-coercion`, `boolean-relational-comparison`, `string-arithmetic-coercion`, `unary-plus-coercion-185`, `compound-assignment-coercion` (48 compiles) plus all 63 #6998/#6999 probe sources for gc, base (after #6997) vs final — identical.
- Also fixes #6998's `a < 10` with `"90"` repro (it is an `any` relational).
- **Adjacent, not fixed (js-host lane, being sunset):** on gc, `("2" as any) < ("10" as any)` in an IR-claimed `test()` fails to compile (`cannot materialize callable provider intrinsic __ir_str_compare`), and `f("10", 9)` for `f(a: string|number, b: string|number) { return a > b }` returns `false` (node `true`). Both pre-existing on base; standalone is correct.

