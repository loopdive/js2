---
id: 6998
title: "standalone: AnyValue→f64 tag dispatch in `coerceType` falls string (tag 5) and object (tag 6) payloads through to `f64val` (= 0) instead of ToNumber — `(a as string|number) * 2` with `"9"` gives 0, `"abc"` gives 0 instead of NaN, `a < 10` with `"90"` is true"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: coercion, union-types, anyvalue
goal: standalone-gap
related: [1917, 745, 2949, 6999]
---

# `string | number` unboxed to number reads the f64 payload instead of ToNumber

Found by the 2026-10-15 audit (coercion lane). Standalone only (AnyValue carrier).

## Repro (node → wasm, standalone)

```ts
function f(a: string | number): number { return (a as any) * 2; }
export function test(): number { return f("9"); }   // node 18, wasm 0
```
`-a` → -0, `a/2` → 0, `+a` → 0, `a%2` → 0, `a|0` → 0, `Number(a)*2` → 0, `f("abc")` → 0 (node NaN); `a < 10` with `"90"` → true (node false). A statically-typed `"9" * 2` is fine.

## Root cause

- `src/codegen/type-coercion.ts:2962` (inside `coerceType`, AnyValue → f64 tag dispatch): tags 2/4 → `f64.convert_i32_s(i32val)`, tag 1 → NaN, and `// default: f64val (covers tag 0/null=0, tag 3/f64, tag 5/string, tag 6/object)` — string and object payloads read the f64 field, which is 0.

## Implementation Plan

1. Add explicit arms for tag 5 (string): call the standalone native string→number routine already used for `Number(<string>)` / `+str` in the typed path (grep `__string_to_number` / `stringToNumber` in `src/codegen/string-ops.ts`, `src/stdlib/`); for tag 6 (object): ToPrimitive(hint "number") via the existing `__to_primitive` runtime (`src/codegen/object-runtime.ts` ~4383) then recurse into this same dispatch (or call the `__any_unbox_f64` helper if it is complete — check that it handles tags 5/6; if it does, the fast inline path should simply fall back to the helper for tags 5/6 rather than duplicating).
2. Check the mirrored dispatches: the i32 (`a|0`), boolean (ToBoolean of a string AnyValue: `""` false, else true), and string (ToString of a number AnyValue) directions in the same region of `type-coercion.ts` — fix any that read the wrong payload for tags 5/6.
3. The audit's PLAUSIBLE twin: `(x as string|number)` holding an object through `any` leakage must also go through ToPrimitive, covered by the tag-6 arm.
4. Tests: all repros, plus `f(" 12 ")` → 24, `f("0x10")` → 32, `f("1e3")` → 2000, `f("")` → 0, `f(true as any)` → 2, `f(null as any)` → 0, `f(undefined as any)` → NaN, `f({valueOf(){return 7}} as any)` → 14.

## Acceptance

- Repros match node on standalone; gc byte-identical (this dispatch is AnyValue-only; prove with one gc equivalence file unchanged).
- `check-coercion-sites` passes.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-6998-anyvalue-string-object-to-number-zero.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
