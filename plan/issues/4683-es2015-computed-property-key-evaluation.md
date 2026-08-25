---
id: 4683
title: "ES2015 object-literal computed property key evaluation order"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
feasibility: easy
reasoning_effort: low
goal: test262-conformance
sprint: current
es_edition: es2015
language_feature: computed-property-names
task_type: bug
cohort: es6-language-tail-wave4b
files:
  - src/codegen/literals.ts
  - src/codegen/expressions/call-receiver-method.ts
  - tests/issue-4683.test.ts
loc-budget-allow:
  - src/codegen/literals.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
trap-growth-allow:
  count: 1
  reason: "The open-object dispatch repair advances computed-property-names/object/method/number.js from its baseline assertion failure (named methods returned null) into the pre-existing native closure-dispatch illegal_cast. The merge-group gate verified the baseline row was already fail, so this is a bounded fail-to-trap reclassification rather than a passing-test regression; the exact row is named per #3596."
  tests:
    - test/language/computed-property-names/object/method/number.js
---

# #4683 — ES2015 object-literal computed property key evaluation order

## Cohort and bounded plan

This is the wave-4b standalone ES2015 language-semantics cohort. It is a
distinct, narrow object-literal expressions slice: runtime computed method
keys whose `ToPropertyKey` conversion has observable `toString`/`valueOf`
side effects. Class, switch, let/const, arrow, generator, async, Promise,
reflection, TypedArray, RegExp, and built-in Object/Function/String prototype
families are outside this issue.

Plan:

1. Reproduce the two standalone residual tests from the supplied baseline:
   `computed-property-names/to-name-side-effects/{object,numbers-object}.js`.
2. Trace the object-literal lowering and preserve key conversion/evaluation
   order without widening unrelated object representations.
3. Add focused equivalence coverage and run the two Test262 probes plus the
   repository's scoped type/build checks.

## Baseline evidence

The supplied `test262-standalone-current.jsonl` snapshot (timestamp
2026-08-25 04:31:12, oracle version 13) reports both files as runtime
assertion failures: the key object's conversion callback observes `counter`
as `0` instead of running in source order. The sibling class variants are
explicitly out of scope for this issue.

## Test Results

Baseline (supplied `test262-standalone-current.jsonl`, oracle 13,
2026-08-25 04:31:12): 0/2 passing. Both
`computed-property-names/to-name-side-effects/{object,numbers-object}.js`
failed because the runtime object bridge evaluated each object key's
`toString`/`valueOf` callback twice rather than once in source order.

After the fix: 2/2 passing in standalone Test262.

- `object.js`: PASS, wasm SHA `a7a7e533fb54`
- `numbers-object.js`: PASS, wasm SHA `754b044cb2b3`

Post-sync revalidation after merging current `upstream/main`: 2/2 still pass
(`object.js` SHA `7f162a35abf1`; `numbers-object.js` SHA
`34b543d141c5`), and the focused Vitest remains 2/2.

Focused Vitest: `tests/issue-4683.test.ts` — 2/2 tests passed.

Zero-loss controls (all were baseline PASS rows): 3/3 passed after the
change — `computed-property-names/basics/{number,string}.js` and
`computed-property-names/object/property/number-duplicates.js`.
The related `computed-property-names/object/method/string.js` also passes
after the change.

Merge-group follow-up fixed two unintended pass regressions: large numeric
computed keys retain their full f64 value and a function returning `undefined`
still creates the `"undefined"` property. The existing
`computed-property-names/object/method/number.js` baseline failure now reaches
a native closure-dispatch `illegal_cast` instead of returning null; the named
`trap-growth-allow` above records that one fail-to-trap reclassification.

Scoped gates: TypeScript 5 and TypeScript 7 typechecks passed; targeted
Prettier and Biome checks passed; `git diff --check` passed. Full Test262 and
the repository-wide test suite were not run.

## Implementation

Runtime computed keys now preserve nominal object values until one explicit
`__to_property_key` conversion before `__extern_set`; this prevents the open
object bridge from invoking user conversion callbacks twice. Setter and
accessor helper indices are resolved after each property/method compilation so
late helper registration cannot leave stale function indices. Method calls on
variables tagged for the open-object representation use dynamic dispatch even
when TypeScript inferred a closed object shape, avoiding a null receiver cast.
