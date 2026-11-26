---
id: 7545
title: "IR undefined-compare follow-ups: an unpeeled indexed operand, a shadowed `undefined` through a TS wrapper, and #7501's nits"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: ir
goal: core-semantics
depends_on: []
related: [7515]
origin: "2026-11-26 fresh-context review of PR #7501 (#7515), https://github.com/loopdive/js2/pull/7501#issuecomment-7192613570"
---

# #7545: follow-ups to #7515

[#7515](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7515-ir-void-zero-strict-equality-false) made the IR
read a compared `void 0` / `undefined` through `skipOuterExpressions`. Its reviewer found two pre-existing defects,
neither caused by #7515, and three nits.

## Defects

1. **`a[5]! === void 0` is false on the IR lane** (JS: true), on the base as on the head.
   - In `tryLowerUndefinedCompare` (`src/ir/from-ast.ts`), the unproven-index guard
     (`ts.isElementAccessExpression(other) && !isProvenInBoundsIr(...)`, which throws `nullish-value-unsupported`)
     reads the *other* operand without peeling it.
   - So `a[5]!` or `(a[5] as number)` skips the guard and folds false by its static type: the same wrapper defect, on
     the opposite operand.
   - Fix: the guard asks about `skipOuterExpressions(other)`.
2. **A shadowed `undefined` reached through a wrapper.**
   `function g(undefined: number) { return (undefined as any) === void 0; } g(5)` gives true on the IR and legacy
   lanes (JS: false). The unwrapped form is right on the IR lane, and the base answers the same as the head.
   - Find which path answers before the shadow check, on each lane.
   - Legacy is the JS-host lane being sunset, so fix it only if the shared code is the cause, and keep JS-env bytes
     identical otherwise.

## Nits (code quality, from the same review)

- The `isShadowed: (name, id)` callback of `isUndefinedCompareOperand` is half-used: every caller reads exactly one of
  the two arguments, and `name` is always `"undefined"`. It becomes `(id: ts.Identifier) => boolean`, and the
  name-based callers read `id.text`.
- `isGlobalUndefined` is now only ever called with an identifier. Its declared parameter type, in
  `static-predicates/lowering.ts` (~L64) and `static-predicates/selection.ts` (~L45), narrows to `ts.Identifier`.
- `staticPredicateLiteralFamily` (`static-predicates/lowering.ts`) still peels parentheses by hand. So `(null as any)`
  is not `nullish` there, while a wrapped `undefined` now is `undefined`. Peel once with `skipOuterExpressions` so the
  two branches agree.

## Done when

- `a[5]! === void 0` and `(a[5] as number) === void 0` agree with node on gc and standalone (default and legacy).
- The shadowed-through-`as` program agrees with node on the IR lane.
- The nits are applied.
- Ordinary bytes are identical on the 13 playground examples × default/standalone. `prepared-byte-identity.mts` is
  804/804, or every changed row is explained.
