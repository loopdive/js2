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

- **Module:** `src/ir/from-ast.ts`, at the two places where the value or call is
  built: the `RegularExpressionLiteral` arm of `lowerExprUnchecked` and
  `unadmittedObjectDefineProperty`. No new module; no try/catch.
- **Reuse:** the literal asks the selector's own rule through the existing
  `supportsBackendCapability` resolver query and `lowersAsNativeRegExp`; the
  define refusal uses the selector's code. The capability pair is named once,
  as `RegExpBuildCapability` in `src/ir/regexp-runtime-contract.ts`, next to the
  carrier ABI (the same `Extract<IrBackendTargetCapability, …>` pattern as
  `ObjectStaticCapability`).
- **Removed:** the stale "calls the `RegExp_new` host import" comment, and the
  invariant that called a reachable path a drift.
- **Quality criterion:** `from-ast.ts` does not grow; ordinary-pipeline bytes
  stay identical (default, standalone and linear).

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
