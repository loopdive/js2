---
id: 6487
title: "Implicit-any parameter body-inferred to f64 on a function that escapes as a value (linked provider export alias) — external string args arrive as NaN"
status: done
sprint: current
created: 2026-09-16
updated: 2026-09-16
completed: 2026-09-16
loc-budget-allow:
  # 2026-09-16 (#6487): +14 lines in the file that owns the rule — the
  # escape withdrawal is one `if` plus the comment recording WHY it sits
  # below the .d.ts seed and above the body route. Moving three lines to a
  # new module would split the precedence chain across files.
  - src/codegen/declarations/param-return-inference.ts
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


## Implementation Notes (2026-09-16, Opus lane)

**Change** — one gate in `inferImplicitAnyParamType`
(`src/codegen/declarations/param-return-inference.ts`): `if
(callSites.escapesAsValue) return null;` immediately before
`inferParamTypeFromBody`.

**Placement is the whole decision.** The plan sketched folding the escape into
the existing `sawCallSite || functionNameIsStringReplacement(…)` guard, which
sits ABOVE the `.d.ts` seed (#743). That would have made an escape outrank a
declared type. A declared type is a contract about exactly the unseen callers
the escape heuristic is worried about, so the gate goes BELOW the seed: seeded
positions keep their declared ABI, only unseeded ones fall back to dynamic.

**`export { f }` deliberately NOT treated as an escape.** `valueReferencedNames`
excludes export specifiers, so `export { f }` behaves like `export function f`
— the #743 truly-uncalled exported entrypoint, where the export boundary itself
coerces (ToNumber for f64) and body inference is the sanctioned signal. The
alias form (`export const g = f`) is different because the value travels the
internal `__call_fn_N` dispatcher, which has no such coercion. Pinned by a test
so a future widening is deliberate.

**Measurements** (A/B by rebuilding `scripts/compiler-bundle.mjs` on each side —
the smoke script imports the BUNDLE, not `src/`, so reverting the source alone
measures nothing; the first base run was contaminated exactly that way. The
provider cache key is NOT keyed on the compiler, so `.tmp/linked-smoke` was
deleted before every run.)

| Measurement | before | after |
| --- | --- | --- |
| `.tmp/p6477/cases2` `plainval.js`, linked | fail: `Expected obj[foo] to equal NaN, actually abcd` | **pass** |
| `built-ins/Object/defineProperty/15.2.3.6-4-540-8.js`, linked | fail: `Expected obj[0] to equal NaN, actually data` | **pass** |
| `built-ins/Object/defineProperty` first 60, linked | 59/60 pass | 59/60 pass (verdicts byte-identical) |
| propertyHelper provider size | 193,776 B | 192,454 B |
| `node scripts/equivalence-gate.mjs` | — | 22 failing / 1720 passing, all 22 in baseline; no new regressions |

Honest-lane effect: **none observed.** Both flipped files still FAIL honest
(`plainval` a `WebAssembly.Exception`, `15.2.3.6-4-540-8` `wasm closure
dispatcher __call_fn_`), identically before and after — pre-existing,
unrelated, and the reason smoke agreement READS worse after the fix (the linked
lane is now right where the honest lane is still wrong). The honest lane is
structurally insulated: it compiles harness+body as one module, so
`verifyEqualTo` has a call site and never reached the body route. The 60-row
defineProperty sweep shows no honest or linked verdict moving in either
direction.

Suites re-run green: `issue-3471`, `issue-2867-s2-value-escape-inference`,
`issue-3451-*`, `issue-647*`, `issue-6482*`, `issue-6486*` (133 passed).

## Acceptance

- [x] `plainval` (#6477 body) and `15.2.3.6-4-540-8.js` pass in the linked lane.
- [x] Unit test for the escape rule (`tests/issue-6487-escaping-param-body-inference.test.ts`);
      honest control verdict-identical for a non-escaping function (still f64).
- [x] Equivalence gate clean; issue-3451/6474–6477 suites green.
