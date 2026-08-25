---
id: 4689
title: "ES2015 standalone generator-yield residual"
status: done
completed: 2026-08-25
created: 2026-08-25
updated: 2026-08-25
priority: high
depends_on: []
es_edition: es2015
language_feature: generators-yield
task_type: bug
files:
  - src/codegen/generators-native.ts
  - src/codegen/generators-native-consumer.ts
  - tests/issue-4689.test.ts
loc-budget-allow:
  - src/codegen/generators-native.ts
func-budget-allow:
  - src/codegen/generators-native.ts::compileState
---

# #4689 — ES2015 standalone generator-yield residual

## Scope and baseline record

The authoritative artifact is
`/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`
(oracle version 13, honest lane, generated 2026-08-25). Filtering to the ES2015
`test/language/expressions/yield/` directory gives **52 non-pass rows**:

- **49 `compile_error/other`** rows, all refusing with the native-generator
  lowering diagnostic `#680` (complex/non-numeric yield shape).
- **3 `fail/assertion_fail`** rows: `rhs-yield.js`, `star-string.js`, and
  `rhs-unresolvable.js`.

Exact 52-row list (status is the artifact status):

### 49 compile refusals (`#680`)

1. `test/language/expressions/yield/star-iterable.js`
2. `test/language/expressions/yield/star-rhs-iter-thrw-thrw-call-non-obj.js`
3. `test/language/expressions/yield/rhs-regexp.js`
4. `test/language/expressions/yield/star-rhs-iter-rtrn-res-value-final.js`
5. `test/language/expressions/yield/from-with.js`
6. `test/language/expressions/yield/star-rhs-iter-thrw-violation-no-rtrn.js`
7. `test/language/expressions/yield/star-rhs-iter-rtrn-rtrn-invoke.js`
8. `test/language/expressions/yield/star-rhs-iter-thrw-res-value-final.js`
9. `test/language/expressions/yield/star-rhs-iter-nrml-res-done-no-value.js`
10. `test/language/expressions/yield/star-rhs-iter-rtrn-no-rtrn.js`
11. `test/language/expressions/yield/star-rhs-iter-nrml-next-call-err.js`
12. `test/language/expressions/yield/in-rltn-expr.js`
13. `test/language/expressions/yield/star-rhs-iter-rtrn-rtrn-get-err.js`
14. `test/language/expressions/yield/star-return-is-null.js`
15. `test/language/expressions/yield/star-rhs-iter-rtrn-rtrn-call-non-obj.js`
16. `test/language/expressions/yield/star-rhs-iter-thrw-violation-rtrn-invoke.js`
17. `test/language/expressions/yield/star-rhs-iter-nrml-next-invoke.js`
18. `test/language/expressions/yield/star-rhs-iter-nrml-res-value-final.js`
19. `test/language/expressions/yield/star-rhs-iter-rtrn-res-value-err.js`
20. `test/language/expressions/yield/formal-parameters-after-reassignment-non-strict.js`
21. `test/language/expressions/yield/star-rhs-iter-thrw-thrw-invoke.js`
22. `test/language/expressions/yield/star-rhs-iter-thrw-violation-rtrn-call-err.js`
23. `test/language/expressions/yield/star-rhs-iter-get-get-err.js`
24. `test/language/expressions/yield/star-rhs-iter-rtrn-res-done-no-value.js`
25. `test/language/expressions/yield/star-rhs-iter-nrml-res-value-err.js`
26. `test/language/expressions/yield/rhs-omitted.js`
27. `test/language/expressions/yield/rhs-template-middle.js`
28. `test/language/expressions/yield/star-rhs-iter-nrml-res-done-err.js`
29. `test/language/expressions/yield/arguments-object-attributes.js`
30. `test/language/expressions/yield/iter-value-unspecified.js`
31. `test/language/expressions/yield/star-rhs-iter-nrml-next-get-err.js`
32. `test/language/expressions/yield/star-rhs-iter-nrml-next-call-non-obj.js`
33. `test/language/expressions/yield/star-rhs-iter-thrw-violation-rtrn-get-err.js`
34. `test/language/expressions/yield/star-rhs-unresolvable.js`
35. `test/language/expressions/yield/star-rhs-iter-get-call-err.js`
36. `test/language/expressions/yield/star-rhs-iter-rtrn-res-done-err.js`
37. `test/language/expressions/yield/star-in-rltn-expr.js`
38. `test/language/expressions/yield/star-rhs-iter-thrw-violation-rtrn-call-non-obj.js`
39. `test/language/expressions/yield/formal-parameters-after-reassignment-strict.js`
40. `test/language/expressions/yield/star-throw-is-null.js`
41. `test/language/expressions/yield/iter-value-specified.js`
42. `test/language/expressions/yield/rhs-primitive.js`
43. `test/language/expressions/yield/star-rhs-iter-thrw-thrw-call-err.js`
44. `test/language/expressions/yield/star-rhs-iter-thrw-res-done-no-value.js`
45. `test/language/expressions/yield/star-rhs-iter-rtrn-rtrn-call-err.js`
46. `test/language/expressions/yield/star-rhs-iter-thrw-thrw-get-err.js`
47. `test/language/expressions/yield/star-rhs-iter-thrw-res-done-err.js`
48. `test/language/expressions/yield/star-rhs-iter-get-call-non-obj.js`
49. `test/language/expressions/yield/star-rhs-iter-thrw-res-value-err.js`

### 3 runtime failures

| Artifact status | File | Observed error |
| --- | --- | --- |
| `fail/assertion_fail` | `test/language/expressions/yield/rhs-yield.js` | First result `value`: actual `undefined`, expected `1` |
| `fail/assertion_fail` | `test/language/expressions/yield/star-string.js` | First result `value`: actual `NaN`, expected `"a"` |
| `fail/assertion_fail` | `test/language/expressions/yield/rhs-unresolvable.js` | `typeof err` actual `"undefined"`, expected `"object"` |

## Selected bounded cohort

This issue selects the single direct-string delegation row
`test/language/expressions/yield/star-string.js` (1 row) as the first coherent
slice. It exercises the existing native `yield*` delegation machinery with the
already-implemented native string character-vector runtime. The other 51 rows
remain explicitly out of scope: nested-yield evaluation, unresolvable-reference
throw timing, arbitrary custom-iterator completion/abrupt protocol, and the
remaining #680 shape refusals each require separate mechanisms.

Measured baseline on the artifact: `star-string.js` is a runtime failure with
`result.value === NaN` on the first `next()`, not a compile refusal. The current
plan only admits numeric-vector and generic iterable delegation; it does not
classify a string operand as a native delegation source, and the generic arm's
externref-to-f64 conversion would be wrong for string characters even if the
source were admitted. After the carrier fix, the exact pin exposed the same
string result struct's terminal null ref being surfaced as JS `null` instead of
the required `undefined`; that is part of this row's result-value contract.

## Root-cause hypothesis

`buildNativeGeneratorPlan` (`src/codegen/generators-native.ts`) derives an f64
result carrier for a generator containing only `yield* 'abc'`. The delegation
classifier does not recognize the native string type, while the native iterator
runtime already has `__str_to_char_vec` support. Consequently the generated
state machine does not carry string elements as native strings; the yielded
character is converted through the numeric path and appears as `NaN`. Once the
string carrier is admitted, `buildOpenResultValueReadExtern` in
`generators-native-consumer.ts` must also map its nullable terminal ref through
the canonical undefined producer; `extern.convert_any(null)` otherwise exposes
JS `null` for the final `.value` read.

## Implementation plan

1. Add a narrow native-string `yield*` classification using the existing
   `__str_to_char_vec` geometry; keep arbitrary strings/objects and custom
   iterator protocol on the existing refusal path.
2. Carry the string element/result type through the existing delegation state
   without changing numeric or boxed-any generator carriers.
3. Canonicalize nullable native-string result refs as `undefined` on dynamic
   `.value` reads while preserving non-null yielded characters.
4. Add an exact `runTest262File(..., "standalone")` pin for `star-string.js` and
   baseline-pass controls from the same yield directory. Include a zero-host-
   import check for the admitted native string path via the standalone runner.

## Risks and non-goals

- Do not admit `yield*` over arbitrary objects, `any`, or custom iterators in
  this slice; those remain in the 49-row #680 cohort.
- Do not alter nested-yield evaluation (`rhs-yield.js`) or unresolvable reference
  handling (`rhs-unresolvable.js`).
- Preserve the existing f64 numeric and externref generic delegation paths.
- Keep source changes below ~150 lines and confined to the generator native
  lowering/consumer plus its focused regression test.

## Acceptance criteria

- `star-string.js` passes through `runTest262File(file, "issue-4689", ..., "standalone")`.
- At least one baseline-pass yield control remains passing through the same
  runner, and no host imports are emitted for the admitted string delegation.
- The other two runtime failures and all 49 compile refusals remain honest and
  are not pinned as passes by this issue.
- Typecheck, focused tests, and normal prepush checks pass.

## Intended files

- `src/codegen/generators-native.ts`
- `src/codegen/generators-native-consumer.ts`
- `tests/issue-4689.test.ts`

## Test Results

- Baseline artifact (2026-08-25, oracle 13): `star-string.js` was
  `fail/assertion_fail`, first delegated value `NaN` instead of `"a"`;
  the final value path was not reached correctly either.
- Focused issue suite after the fix: **4/4 passed** — exact `star-string.js`,
  baseline-pass `star-array.js` and `rhs-iter.js`, and a direct compile/runtime
  control asserting zero WebAssembly imports and a character count of 3.
- Existing generator controls: **23/23 passed** across
  `issue-2171-string-yields.test.ts` and `issue-2173-yieldstar-array.test.ts`.
- Source changes are 21 lines in the native planner and 21 lines in the native
  result consumer; no arbitrary/custom iterator or other residual row is
  admitted.
