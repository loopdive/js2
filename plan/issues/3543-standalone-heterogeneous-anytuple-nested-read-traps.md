---
id: 3543
title: "standalone: heterogeneous inner-tuple (anytuple) nested reads broken — numbers read back NaN, strings trap 'dereferencing a null pointer' (5 red tests on main)"
status: done
completed: 2026-07-25
created: 2026-07-23
updated: 2026-08-18
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays, tuples, any
es_edition: es5
goal: standalone
umbrella: 2860
sprint: 78
horizon: m
related: [2190, 2873, 3497]
origin: "Red-suite triage 2026-07-23 (fable-exposed): 5 tests in tests/issue-2190.test.ts (#2190b block) fail on clean origin/main. A scoped source bisection on 2026-07-26 identified 570c816bbea429b81e672ccc2f9b9caed44ba33a (#745 S4.5 unionAnyRep native-lane default flip) as the first bad commit."
# The fix belongs at compileArrayLiteral's carrier-selection seam: it must align
# the outer expected vec type with the inner literal writer before construction.
loc-budget-allow:
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/literals.ts::compileArrayLiteral
---

# #3543 — standalone heterogeneous anytuple nested reads: NaN / null-deref traps

## Confirmed symptom (vitest, red on clean `origin/main` today)

`npx vitest run tests/issue-2190.test.ts` — the 5 failures in the
`#2190b heterogeneous inner-tuple read-back` block:

| test                                             | expected | actual                                 |
| ------------------------------------------------ | -------- | -------------------------------------- |
| `[["a", 7]]` — `e[0][1]` reads the number        | 7        | **NaN**                                |
| `[["a", 7]]` — `e[0][0]` still reads the string  | "a"      | **trap: dereferencing a null pointer** |
| `[[7, "ab"]]` — `e[0][1]` reads the string       | "ab"     | **trap: dereferencing a null pointer** |
| `[[7, "ab"]]` — `e[0][0]` still reads the number | 7        | **NaN**                                |
| three-element mixed `[string, number, string]`   | —        | **trap: dereferencing a null pointer** |

The sibling cases in the same block PASS: boolean+number heterogeneous tuple,
flat `any[]` `[0, "last"]`, pure `number[][]` nested, pure `string[]`. So the
break is specific to **string⊕number heterogeneous INNER tuples read through
the nested `e[0][k]` dynamic path**.

## Confirmed root cause

- The first bad commit is
  `570c816bbea429b81e672ccc2f9b9caed44ba33a`, which made `unionAnyRep` the
  native-string-lane default. `JS2WASM_UNION_ANYREP=0` restores all 20 focused
  tests, confirming the representation switch as the causal boundary.
- The inner `["a", 7]` literal is initially correct: its bare-`any` context
  activates the existing #2190b/#2106 widening and builds `__vec_externref`,
  with each element boxed according to its actual JS type.
- The outer literal instead resolves the inner expression's inferred
  `(string | number)[]` type under `unionAnyRep`, so it expects
  `__vec_ref_<AnyValue>`. Generic vec-to-vec coercion immediately copies the
  correct externref elements through `__any_box_extern_s1` into that different
  carrier.
- `__extern_get_idx` then matches the **correct** AnyValue-vec RTT arm; arm
  creation/test order is not the bug. Its generic GC-ref boxing returns an
  externref wrapping the `$AnyValue` struct rather than the JS payload. Numeric
  consumers therefore see an unrecognized wrapper and produce NaN, while
  native-string casts miss and null-deref.
- The implementation re-keys only this proven construction mismatch: when both
  nested literals are contextually `any`, the inferred carrier is specifically
  `Vec<AnyValue>`, and neither literal spreads, the outer carrier expects the
  canonical `Vec<externref>` that the inner writer actually emits. Typed unions,
  homogeneous matrices, flat arrays, spread construction, and the flag-off
  lane stay outside the predicate.

## Repro

```bash
npx vitest run tests/issue-2190.test.ts   # 5 failures in the #2190b block
```

Minimal shape: `var e: any = [["a", 7]]; e[0][1]` (NaN) / `e[0][0]` (trap).

## Acceptance criteria

- The 5 `#2190b` tests pass on `--target standalone`.
- No regressions in the passing siblings (boolean+number tuple, flat any[],
  pure nested number/string matrices) or the #3183 suite.
- Fix lands with a root-cause note: WHICH representation/arm divergence caused
  the per-kind misread (carrier registration vs reader test order), so the
  #3251 overlay work can build on a stable answer.
