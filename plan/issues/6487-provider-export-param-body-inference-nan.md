---
id: 6487
title: "Implicit-any parameter body-inferred to f64 on a function that escapes as a value (linked provider export alias) — external string args arrive as NaN"
status: in-progress
sprint: current
created: 2026-09-16
updated: 2026-09-16
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: functions
goal: test262-conformance
depends_on: [3451]
related: [3451, 3471, 6482, 6486]
---

# #6487 — body-inferred f64 param on an escaping function

## Problem (measured 2026-09-16)

`verifyEqualTo(obj, "foo", "abcd")` from a linked test262 body fails in the
provider with `Expected obj[foo] to equal NaN, actually abcd`: the provider's
compiled `verifyEqualTo` has signature `(externref, externref, f64)`
(wasm-dis of the propertyHelper provider), so the consumer's string crosses the
`__call_fn_3` dispatcher and is coerced to NaN. Same class:
`built-ins/Object/defineProperty/15.2.3.6-4-540-8.js` (`… to equal NaN,
actually data`) and every harness helper whose implicit-any parameter is used
numerically in its body.

Mechanism (`src/codegen/declarations/param-return-inference.ts`
`inferImplicitAnyParamType`, ~L1055): the function has no internal call site,
so the "truly-uncalled exported entrypoint" fallback runs
`inferParamTypeFromBody`, which narrows to f64 on a numeric use. The harness
provider exports every helper through an alias (`export const __h_x = fn`,
`materializeHarnessProject`), i.e. the function **escapes as a value** —
`callSites.escapesAsValue` is already computed and already withdraws the
native-string route for exactly this reason (#2867 S2), but the f64 body route
ignores it.

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

1. In `inferImplicitAnyParamType`, treat an escaping function like an
   inconclusive call site for the body route too:
   `if (callSites.sawCallSite || callSites.escapesAsValue || functionNameIsStringReplacement(…)) return null;`
   Keep the `.d.ts` seed route (#743) ahead of it only if the seed is a
   declared type — read the code; declared types outrank heuristics, an escape
   does not outrank a declaration.
2. Confirm `escapesAsValue` is true for the alias form
   (`export const __h_x = verifyEqualTo;`) and for a plain `export { fn }` —
   add a unit test on a two-function source: uncalled `function f(v) { return
   v * 2 }` + `export const g = f;` must keep `v` externref; the same `f`
   without the export keeps f64 (byte-identity control for the honest path).
3. Measure: the four #6477 minimal bodies via the smoke script (`plainval`
   must flip to pass), `15.2.3.6-4-540-8.js`, and the equivalence gate. Expect
   a small corpus-wide effect on the honest lane wherever an uncalled function
   that escapes as a value was body-narrowed — that is the #3471 NaN bug
   class, so flips should be fail→pass; report any pass→fail.
4. Provider parity: rebuild the harness providers (cache key includes the
   compiler bundle hash — verify a rebuild happens, else bump it) and rerun
   `scripts/test262-linked-harness-smoke.mts` on `.tmp/p6477/cases2` and
   `built-ins/Object/defineProperty` (first 60).

## Acceptance

- [ ] `plainval` (#6477 body) and `15.2.3.6-4-540-8.js` pass in the linked lane.
- [ ] Unit test for the escape rule; honest control byte-identical for a
      non-escaping function.
- [ ] Equivalence gate clean; issue-3451/6474–6477 suites green.
