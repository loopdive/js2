---
id: 3776
title: "ES5 Object.isFrozen intrinsic objects through IR"
status: ready
assignee: ttraenkler/codex-es5-isfrozen-residual
created: 2026-07-28
updated: 2026-07-28
sprint: current
goal: es5
priority: high
task_type: bug
area: ir
es_edition: ES5
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
  - src/ir/from-ast.ts::lowerMethodCall
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
---

# ES5 Object.isFrozen intrinsic objects through IR

## Scope

Recognize the ES5 initial-realm invariant that intrinsic constructor objects,
namespace objects, and their prototypes are initially extensible and therefore
not frozen. The classifier must be shadow-safe and must refuse the static result
when the source can mutate object integrity.

The semantic decision belongs to `src/ir/object-integrity.ts` and is consumed by
the IR selector and AST-to-IR lowerer. Test262's original top-level harness is
not currently IR-claimed, so legacy module initialization may use only a thin
adapter to that shared IR-owned classifier.

## Baseline

Measured locally on `origin/main@b3450a4f3176bc` across all 56 Test262 files in
`built-ins/Object/isFrozen` carrying an `es5id`:

- host: 54/56
- standalone: 33/56

The largest non-overlapping intrinsic residual is 14 standalone cases.
`EvalError` and `URIError` add two host failures.

## Acceptance

- Exact intrinsic calls lower through IR in host and standalone, with
  `irCompiledFuncs` proof and no post-claim errors.
- Shadowed `Object` or intrinsic roots do not take the fold.
- Sources mentioning `freeze`, `seal`, or `preventExtensions` retain runtime
  observation.
- Original-harness Test262 cases pass through the compatibility adapter.
- The complete 56-file ES5 family is remeasured in both lanes on the same SHA.

## Result

Same-SHA measurement on `b3450a4f3176bc`:

- host: 54/56 → 56/56
- standalone: 33/56 → 47/56
- transitions: 16 fail → pass
- regressions: 0
