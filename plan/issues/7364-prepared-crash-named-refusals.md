---
id: 7364
title: "Prepared path: RegExp literals and unadmitted Object.defineProperty refuse by name instead of crashing the compile"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: []
related: [7354, 7338, 7106, 3791]
# 2026-11-19 (review round 1): src/ir/from-ast.ts, the `unselected` option and its LowerCtx field, the
# regexp-literal-admission import, and `unadmittedObjectDefineProperty` over `refuseUnselected` (the rule itself
# lives in src/ir/regexp-literal-admission.ts and the helper beside `demoteToLegacy`).
# 2026-11-19 (review round 1): src/ir/integration.ts +1, the resolver's `nativeRegExpCompiles`, the selector's
# own answer, asked again where a static construction is built.
# 2026-11-19 (review round 1): src/ir/program-source.ts +1, `unselected: true`, the Prepared producer's fact.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/program-source.ts
# 2026-11-19 (review round 1): makeFromAstResolver +1, the `nativeRegExpCompiles` row beside the resolver's other
# native RegExp rows.
func-budget-allow:
  - src/ir/integration.ts::makeFromAstResolver
---

# #7364 — Prepared-path compile crashes become named refusals

## Problem

Lane S9's census on main `ee3fcdd610` (8,717 positive ES5 test262 files through
the strict Prepared entry, stand-in harness) found **495 files whose compile
throws** an invariant out of `compile()` instead of returning a named refusal.
The path's contract is to refuse by name at a defined stage, never to throw.

Re-measured here with S9's `scripts/ir-census/prepared-census.mts --harness
stand-in` on the same main (all 9,174 ES5 files): 495 crashes, the same split.

| class | files | where |
| --- | ---: | --- |
| `extern method call .exec` / `.test` / `property read .source` is capability-deferred | 259 | RegExp literal receiver |
| certified global eval lost an owning predicate | 196 | eval (lane S2, not this issue) |
| `Object.defineProperty` is not an admitted Object static | 26 | `Object` statics table |
| native string/value demands: missing complete owner population | 10 | a program with no executable unit |
| empty startup source … claims an executable body | 4 | a script of bare `var x;` declarations only |

Root cause of the first and third classes: the Prepared producer has no
selector. The ordinary pipeline's selector refuses a RegExp literal that no
provider can build (`regexp-constructor-unsupported`) and a define the `Object`
statics table did not admit (`call-resolution-unsupported`), so from-ast was
written to treat both as unreachable. On the Prepared path the literal lowered
to `extern.regex` anyway (its resolver answers no capability), and the first
member use on that extern receiver tripped the capability assert.

## Implementation Plan

- **One rule, two askers.** `src/ir/regexp-literal-admission.ts` holds the static RegExp construction rule
  (`regExpLiteralBuilt`, `nativeStaticRegExpBuilt`, `hostRegExpBuilt`): the host constructor, or the in-module
  engine when the pattern compiles there and its consumer is one the IR lowers. The selector (its
  `SELECTOR_REGEXP_LANE`) and from-ast (the resolver itself) both call it. An unanswered question builds nothing,
  in both; before, the selector read an absent seam as "host available" and from-ast as "no host", so the linear
  lane claimed a RegExp unit and then hit the capability assert (base) or withdrew it (round 0).
- **`unselected`, a producer fact.** The Prepared producer passes `unselected: true` to `lowerFunctionAstToIr`.
  `refuseUnselected` (beside `demoteToLegacy` in `ir-preparation-errors.ts`) is the one arm for a construct only
  the selector refuses: an invariant after a selector's claim, the selector's named refusal without one. The
  unadmitted `Object.defineProperty` and D1's two declines (value-position prefix `++`/`--`, dynamic `**`) use it.
- **Removed duplicate:** the selector's private `nativeStaticRegExp` (now the shared rule), from-ast's weaker
  `lowersAsNativeRegExp` (no consumer or compile check), and D1's unconditional declines.
- **Quality criterion:** no RegExp rule spelled twice; ordinary bytes identical on default, standalone and linear;
  no post-claim error for a RegExp unit on any ordinary lane.

## Result

- The 259 RegExp and 26 defineProperty files refuse by name
  (`regexp-constructor-unsupported`, `call-resolution-unsupported`). Census on
  the 495 base crashes: 285 refusals, 210 crashes left (196 eval, 14 other).
- Ordinary bytes: 100 files (70 random ES5, 30 of the affected files) × default,
  standalone and linear, identical to `origin/main`.
- Left open and reported to the lead: the 14 "other" crashes are compiler
  defects on valid programs (empty program; bare declarations only). They
  should compile, not refuse, and sit in the startup plan and the native
  string census, outside this change.
