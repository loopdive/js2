---
id: 6998
title: "standalone: AnyValue→f64 tag dispatch in `coerceType` falls string (tag 5) and object (tag 6) payloads through to `f64val` (= 0) instead of ToNumber — `(a as string|number) * 2` with `"9"` gives 0, `"abc"` gives 0 instead of NaN, `a < 10` with `"90"` is true"
status: done
completed: 2026-10-15
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

## Implementation notes (2026-10-15)

- **`__any_unbox_f64` / `__any_to_f64` are NOT complete** (plan step 1's check): `__any_to_f64` recovers `$BoxedNumber`/`$BoxedBoolean`/i31 tag-5 payloads but still reads `f64val` (0) for a tag-5 string and for tag 6, so falling back to it would not fix anything. Left untouched (it serves `ctx.fast` arithmetic helpers and `__any_lt`…).
- **Fix**: new `src/codegen/anyvalue-to-number.ts`. `prepareAnyValueDynamicToNumber` (host-free targets only; `coercionMode(ctx) === "standalone"`) registers the providers (`addUnionImports`; on `--target standalone` `ensureObjectRuntime`, which owns the native `__to_primitive` — the same registration `emitAnyRelational` does) and returns the coercion engine's `runtimeToPrimitiveInstrs(hint)` + `runtimeToNumberInstrs` run — the chain `coerceType`'s externref → f64 arm already emits on standalone (`__to_primitive` then `__unbox_number`, whose native body runs the StringToNumber scanner); WASI gets that arm's bare ToNumber. No new coercion-vocabulary sites (`check-coercion-sites` passes without an allowance). `anyValueF64DefaultArm` replaces the dispatch's final `f64val` read: tag 5 → `externval`, tag 6 → `extern.convert_any(refval)`, each through that run; tags 0/3 keep the `f64val` read. `type-coercion.ts` changes are line-neutral (one prepare call, the three-line `else` collapsed to one).
- **Unary `-`**: `-(a as any)` did not go through `coerceType` at all — it called `__any_neg`, which negates `f64val` (0 for strings, booleans, objects). On host-free targets `unary.ts` now skips `__any_neg` and falls to its existing `coerceType(→ f64)` + `f64.neg` tail (one gate condition). This also fixes `-true` (was `-0`).
- **Step 2 (mirrored directions)**: probed — ToBoolean (`!!a`, `if (a)` with `""`/`"0"`/`0`) and ToString (`String(a)`, template) of the union were already correct. `a | 0`, `~a`, `a >> 1` were wrong only because they go through the same f64 dispatch; fixed by it (`"1e3" | 0` → 1000, `"4294967297" | 0` → 1).
- **Step 3**: an object reaching the union through `as any` (object literal, class instance with `valueOf`, `[5]`, `Date`) is tag 6 and now runs ToPrimitive(number) — all match node.
- **gc byte-identical**: binaries hashed for every compile in `string-arithmetic-coercion`, `unary-plus-coercion-185/215`, `compound-assignment-coercion`, `math-pow-coercion` (38 compiles), plus all 63 #6998/#6999 probe sources compiled for gc — identical before/after.
- **Adjacent, not fixed**: `__any_neg` itself is still wrong for non-numeric tags on the `ctx.fast`/js-host paths that still call it; `__any_lt`/`__any_to_f64` remain string-blind (only reached under `ctx.fast` now that #6999 routes standalone relationals to `emitAnyRelational`).

