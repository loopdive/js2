---
id: 7146
title: "Native-first: compileArrayJoinNative uses the checker's vec type instead of the storage vec type (invalid wasm on for…in keys)"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [6899, 2787, 6708]
---

# #7146 — Native-first: compileArrayJoinNative uses the checker's vec type instead of the storage vec type (invalid wasm on for…in keys)

Surfaced by PR #6899 (S7-a): the differential-test harness had to drop its
`semanticProviders: "host-assisted"` pin, so `scripts/diff-test.ts` now measures
the default native-first profile and `control/12-for-in-object.js` went `match → compile_error — `Compiling function #57`
against the host-lane baseline. Reproduced on `origin/main` (96c5de84be) with the
pin removed: **pre-existing native-first gap, not S7-a code** (diagnosis
2026-10-25, PR #6899 review thread). Hidden since S6 (#6708) because the harness
pinned the host lane (#2787 note: "S7 owns removing or replacing this host-only
evidence").

## Observed

`control/12-for-in-object.js`: compile_error — `Compiling function #57:"__module_init" failed: local.tee[0] expected type (ref null 42), found ref.as_non_null of type (ref 2)`

## Cause (as diagnosed; verify before fixing)

`keys.sort().join(",")` on `const keys = []` filled by `for…in`: the storage vec is type 2 (externref elements); `__arr_sort_noop` (array-methods.ts ≈9113) keeps type 2; `compileArrayJoinNative` (array-methods.ts ≈5810, `__njoin_vec` local at ≈5875) takes the checker-derived `string[]` vec type 42, so `local.tee __njoin_vec` receives a `(ref 2)`.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with `const keys = []; for (const k in {b:1,a:2}) keys.push(k); console.log(keys.sort().join(","))` on gc native-first; dump WAT.
2. In `compileArrayJoinNative`, derive the vec type from the receiver's *lowered* value type (the same source `__arr_sort_noop` and `push` use — look for the evolving-array / element-evidence helper in `array-element-inference.ts`) instead of the checker's declared element type; if the two disagree, prefer storage and insert the element coercion at read time (string element read from externref storage).
3. Audit the sibling native array methods that take `__n*_vec` locals (`indexOf`, `includes`, `slice`, `concat`, `reverse`) for the same checker-vs-storage source and fix them in the same commit if the same helper is used; otherwise list them here as follow-ups.
4. Equivalence test with `for…in`-filled, `push`-grown and literal arrays joined; WAT assertion that the join's vec local type equals the storage type.

Acceptance: `npx tsx scripts/diff-test.ts` row for `control/12-for-in-object.js` is `match` on gc
native-first and standalone; the equivalence suite is byte-identical on every
program that does not reach the changed path (state the byte delta for those
that do, in the PR body); a test under `tests/issue-7146-*.test.ts` pins the
case on standalone and gc.
