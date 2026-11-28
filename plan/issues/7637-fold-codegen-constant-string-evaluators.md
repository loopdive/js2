---
id: 7637
title: "Fold the codegen constant-string evaluators (foldConstantString, staticConstStringValues) into key-values.ts"
status: backlog
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
goal: ir-full-coverage
depends_on: [7628]
related: [7628, 7350]
---

# #7637 — Fold the codegen constant-string evaluators into `key-values.ts`

## Problem

#7628 adds one shared value-set evaluator, `src/ir/key-values.ts`. It replaces
`literalOnlyComputedKeyValue` in `src/ir/class-accessor-safety.ts`, and the two were measured identical on 4.76 M
expressions. Two more evaluators of an overlapping grammar remain in legacy codegen:

| evaluator | where | grammar | names |
| --- | --- | --- | --- |
| `foldConstantString` | `src/codegen/class-static-metadata.ts` | string literals and `+` | none |
| `staticConstStringValues` | `src/codegen/analysis/static-string-values.ts` | literals, `const` names by checker symbol, `const` array elements, `.split` | checker symbols |

They stay out of #7628 because both are codegen (`backend-wasmgc` destination), whose gc output must stay
byte-identical, and folding them changes behaviour:

- `foldConstantString` is the string-only subset of `exactKey(keyValues(e))`. Folding it would turn `"a" + 1`
  from unknown into `"a1"`.
- `staticConstStringValues` resolves names by checker symbol and reads array elements and `.split`. The key domain
  has no use for either.

## To plan

- Measure each fold before choosing: gc and standalone bytes on the playground and emit-identity corpus, plus a
  test262 sample whose sources reach these evaluators.
- `foldConstantString` is the likely fold. Restrict `keyValues` to a string answer and keep `"a" + 1` unknown.
  Prove gc output byte-identical.
- For `staticConstStringValues`: either give `key-values.ts` an optional name resolver (checker symbol, array
  element) or justify keeping a separate evaluator.
- Layering: `key-values.ts` is `mixed-needs-split` with destination `frontend-ts`. A codegen caller must not add a
  forbidden edge (`scripts/compiler-boundaries.json`).

Depends on #7628, which creates `key-values.ts`.
