---
id: 3543
title: "standalone: heterogeneous inner-tuple (anytuple) nested reads broken — numbers read back NaN, strings trap 'dereferencing a null pointer' (5 red tests on main)"
status: ready
created: 2026-07-23
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays, tuples, any
es_edition: es5
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2190, 2873, 3497]
origin: "Red-suite triage 2026-07-23 (fable-exposed): 5 tests in tests/issue-2190.test.ts (#2190b block) fail on clean origin/main; bisect (tech lead) shows identical failures at aa203fdc5b7b3b, the commit BEFORE #3497 — long-standing, not caused by anything landed 2026-07-23."
---

# #3543 — standalone heterogeneous anytuple nested reads: NaN / null-deref traps

## Confirmed symptom (vitest, red on clean `origin/main` today)

`npx vitest run tests/issue-2190.test.ts` — the 5 failures in the
`#2190b heterogeneous inner-tuple read-back` block:

| test | expected | actual |
| --- | --- | --- |
| `[["a", 7]]` — `e[0][1]` reads the number | 7 | **NaN** |
| `[["a", 7]]` — `e[0][0]` still reads the string | "a" | **trap: dereferencing a null pointer** |
| `[[7, "ab"]]` — `e[0][1]` reads the string | "ab" | **trap: dereferencing a null pointer** |
| `[[7, "ab"]]` — `e[0][0]` still reads the number | 7 | **NaN** |
| three-element mixed `[string, number, string]` | — | **trap: dereferencing a null pointer** |

The sibling cases in the same block PASS: boolean+number heterogeneous tuple,
flat `any[]` `[0, "last"]`, pure `number[][]` nested, pure `string[]`. So the
break is specific to **string⊕number heterogeneous INNER tuples read through
the nested `e[0][k]` dynamic path**.

## Diagnosis (triage-level, verbatim from the red-suite investigation)

- This is a **trap-class** failure (NaN garbage / null-pointer deref), NOT a
  miss-value-class one — do not confuse it with the two (now re-pinned)
  `issue-3183` miss-value expectations in the same triage batch.
- Numbers reading back **NaN** + strings **null-deref** through the same path
  smells like the inner tuple's element representation and the reader's
  expected representation diverging per element kind — i.e. the nested read
  unboxes with the WRONG per-kind arm (a number slot read as a ref → null →
  deref trap; a ref slot read as a number → NaN).
- Plausibly value-rep / RTT-creation-order territory: cf.
  `reference_2873_funcref_wrapper_chain_rtt_order` (wrapper RTT identity is
  creation-ORDER-dependent) and the #2379 boxed-any element-rep notes
  (`reference_2379_new_array_n_boxed_any_elem_rep`). The heterogeneous literal
  path may register/choose a `__vec_<kind>` carrier whose runtime `ref.test`
  ordering in `__extern_get_idx`'s spliced vec arms
  (`fillExternGetIdxVecArms`, src/codegen/object-runtime.ts ~5317) resolves a
  DIFFERENT carrier than the one the literal actually built.
- Long-standing: identical 7-failure state (these 5 + the 2 since-re-pinned
  #3183 ones) at `aa203fdc5b7b3b` (pre-#3497). #3497 and #3506/#3537 are both
  exonerated (verified by running the suite against clean main src and against
  the #3537 branch — identical failures on both).

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
