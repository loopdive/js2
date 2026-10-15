---
id: 6997
title: "codegen: `==`/`!=` between two object-typed operands (class instances, arrays, Map, Date, `C | null`) is lowered as ToPrimitive→f64 equality instead of identity — the same instance compares `false`, two distinct `{valueOf(){return 1}}` compare `true`; §7.2.15 step 1 (same Type → IsStrictlyEqual) is never checked"
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
language_feature: equality, coercion
goal: core-semantics
related: [5154, 1917, 6998]
---

# Loose equality on two objects coerces instead of comparing identity

Found by the 2026-10-15 audit (coercion lane). Both lanes.

## Repro (node → wasm)

```ts
class C { v = 1 }
export function test(): number { const c = new C(); const e = c; return (c == e ? 1 : 0) + (c != e ? 10 : 0); }  // node 1, wasm 10
```
`function same(a: C|null, b: C|null){ return a == b }`: `same(c,c)` → false, `same(null,null)` → false; `[1] == [1]` (same ref) false; `new Map() == itself` false; two distinct `{valueOf(){return 1}}` instances `==` → true; `list.findIndex(y => y == x)` → -1. `===` is correct.

## Root cause

- `src/codegen/binary-ops-typed-dispatch.ts:467-490` — the `else if (isNumericOp || isEqOp || isNeqOp)` arm coerces BOTH struct refs → f64 via `coerceType(..., "default")` + `__unbox_number`, then `f64.eq`. The branch above it (both externref) falls to an externref equality cascade that does handle identity; the both-struct-ref case never checks "same Type".

## Implementation Plan

1. In that arm, split loose equality from numeric ops: when `op` is `==`/`!=` and BOTH operands are reference-typed (`leftIsRef && rightIsRef`, including `ref_null`), emit identity: `ref.eq` after coercing both to a common anyref (or `extern.convert_any`→externref + the existing externref equality cascade, whichever `===` uses — mirror the strict-equality lowering for ref/ref so `==` and `===` share one identity path; grep `EqualsEqualsEqualsToken` in the same file). Null/undefined vs object remains `false` under identity, which is correct.
2. Keep the ToPrimitive path only for the mixed case (one ref, one primitive), which is what §7.2.15 steps 10-11 describe; keep the `"default"` hint fix from #5154.
3. Check `src/codegen/binary-ops.ts:1975-2029` (the BigInt-adjacent `isLooseEq || isComparison` block) for the same ref/ref coercion and route it through the identity path too (audit PLAUSIBLE finding).
4. Check whether the IR lane (`src/ir/from-ast.ts` loose-equality lowering, `dyn-ops.ts` `__ir_dyn_eq` if present) already does identity for two refs; add a test that runs through a top-level IR-claimed function to cover it.
5. Tests: the repros above, plus `Date` instances, `Map`, arrays, `C|null` with nulls, and a mixed `obj == 1` control that still coerces.

## Acceptance

- Repros match node on standalone and gc.
- `tests/equivalence/*equal*`, `*coerc*`, `logical-conditional-identity.test.ts` pass (its known failures unchanged or removed).
- `check-coercion-sites` passes without new allowances unless justified in this file.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6997-loose-equality-object-identity.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.

## Implementation notes (2026-10-15)

- **Fix**: `src/codegen/loose-eq-object-identity.ts` (new) — `identityEqualityFlags` decides the typed dispatch's identity arm. `===`/`!==` as before; a loose `==`/`!=` now joins it when BOTH operands are Wasm refs and BOTH static types are object types (`Object`/`object` flags; a union may also carry `null`/`undefined`). `binary-ops-typed-dispatch.ts` replaces its two `isStrictEq`/`isStrictNeq` lines with one call, so `==` and `===` share the one ref/ref lowering (`ref.eq`, or `__any_strict_eq` for two `$AnyValue` boxes). Net 0 lines in the god-file/function, so no budget allowance.
- **Excluded on purpose** (keep their current lowering): a native-string ref on either side (content equality / ToPrimitive of the other side), and a `$AnyValue` box paired with a non-box (needs tag dispatch).
- **Shared path** — both lanes change. `null == null`, `undefined == null` (both `ref.null`) are now `true`, `obj == null` is `false`, as §7.2.15 steps 1-3 require.
- **Step 3** (`binary-ops.ts` BigInt block ~L1975): not applicable — it is guarded by `leftIsBigInt !== rightIsBigInt`, so one side is always a BigInt primitive; the ref arm there only meets `Object(0n)` against a BigInt, a mixed (step 10-11) case. Left as is.
- **Step 4** (IR lane): two IR-claimed shapes checked (`any` params holding objects; object-literal locals in an IR-claimed `test()`) — both already identity-correct; covered by the test.
- **Adjacent, not fixed (separate root causes):**
  - Class instance vs `any` holding the same instance (`const a: any = c; c == a`) is `false` on both lanes (pre-existing on base): the mixed struct-ref/externref pair still takes the ToPrimitive→f64 arm. Needs the externref abstract-equality cascade with the struct boxed; the gc host lane cannot ToPrimitive an opaque Wasm struct, so it is not a one-line change.
  - IR-claimed `function same(a: any, b: any) { return a == b }` with `same({valueOf(){return 1}}, 1)` traps `illegal cast` on standalone (pre-existing on base; gc correct).

