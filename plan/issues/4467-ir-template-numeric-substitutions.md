---
id: 4467
title: "IR: adopt NUMERIC template-literal substitutions (`\\`a${n}b\\``)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: s
feasibility: medium
task_type: feature
area: ir
language_feature: template-literals
goal: ir-full-coverage
related: [3518, 3583, 3912, 2955, 2856]
origin: "2026-08-15 #3583 adoption-matrix measurement — the `TemplateExpression` row's promotion criterion is 'Template substitutions support the remaining typed coercion families'; STRING claims, NUMERIC rejects."
# The seam itself (the per-lane provider) went into a NEW subsystem module,
# `src/ir/number-to-string-provider.ts`. What is left in the three god-files is
# irreducible: the claim predicate has to live in the selector's template arm,
# the conversion has to live in the lowerer's template arm, and the resolver's
# intrinsic dispatcher is one `else if` per symbol. integration.ts grows by the
# import + those two dispatcher lines only.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - src/ir/integration.ts
# The family predicate itself is extracted to a module-level
# `templateSubstitutionFamily`. What remains inside the dispatcher is one net
# line: the arm has to bind the family (the module-scalar guard below it
# compares against it) where it previously only had to test one boolean.
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
---

# #4467 — IR: numeric template-literal substitutions

## Problem

The IR front-end claims a template literal only when **every** substitution is
checker-proven `string`. Any numeric substitution rejects at
`template-substitution-unsupported` (`src/ir/select.ts`, the
`ts.isTemplateExpression` arm), so the whole enclosing function demotes to the
legacy AST→Wasm path.

`` `a${n}b` `` with `n: number` is the single most common template shape in real
code, so this one rejection reason keeps a large amount of otherwise-claimable
code on legacy. The adoption-matrix row (`plan/log/ir-adoption.md`,
`TemplateExpression`) names exactly this as its promotion criterion:

> Template substitutions support the remaining typed coercion families.

## Measurement (2026-08-15, base `9e17d34f`)

`.tmp/probe-4467.mts` — `compile(src, { experimentalIR: true, trackIrOutcomes: true })`,
reading the `test` unit's outcome per lane. `CLAIM` = `kind: "emitted"`.

| substitution                 | host                                | nativeStrings                       | standalone                          |
| ---------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| `` `a${s}b` `` (string)      | CLAIM                               | CLAIM                               | CLAIM                               |
| `` `a${n}b` `` (f64)         | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `a${n}b` `` (`i32` alias) | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `a${b}b` `` (boolean)     | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `${s}=${n}!` `` (mixed)   | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `v${3}` `` (num literal)  | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `a${n * 2}b` `` (num expr)| `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `a${n.toString()}b` ``    | CLAIM                               | `primitive-method-unsupported`      | `primitive-method-unsupported`      |

Two facts fall out of the last row and drive the design:

1. In the **host** lane the number→string result already composes with the
   existing string-concat chain — `${n.toString()}` claims today. So the host
   arm needs no new representation work, only the implicit conversion.
2. In the **native** lanes there is no IR-side number→string at all: the
   `<number>.toString()` arm demotes on `hasHostNumberToString() === false`.
   Since #3912 the legacy path has a **native** `number_toString`
   (`src/codegen/number-format-native.ts`) whose `externref` result is an
   `$AnyString` widened by `extern.convert_any` — recovering the native string
   carrier is `any.convert_extern` + `ref.cast $AnyString`, exactly what
   `emitNativeStringRefFromExternref` does in `src/codegen/string-ops.ts`.

## Acceptance criteria

1. A numeric (`number` / `i32`-alias) substitution is IR-claimed and lowers to
   spec-correct §7.1.17 `Number::toString` output in **all three** lanes (host,
   nativeStrings, standalone).
2. Mixed string+number templates claim.
3. Special values pin against node: `-0` → `"0"`, `NaN` → `"NaN"`,
   `Infinity`/`-Infinity`, integer vs decimal formatting, exponent forms.
4. Substitution families that are **not** lowered keep rejecting at
   `template-substitution-unsupported` — the selector arm admits exactly what
   the lowerer handles.
5. Legacy↔IR dual-run equality for every covered shape.
6. No `check:ir-fallbacks` growth; `gen-ir-adoption.mjs --check` clean;
   `check:ir-only` host lane holds at 37/37 and standalone floors do not
   regress.

## Design

- **Selector** (`src/ir/select.ts`): the template arm accepts a substitution
  whose declared family is `string` **or** `number`; every other family keeps
  the existing `template-substitution-unsupported` rejection.
- **Lowering** (`src/ir/from-ast.ts` `lowerTemplateExpression`): a substitution
  that lowers to an `f64`/`i32` value is routed through a shared
  number→string seam and then fed to the existing `emitStringConcat` chain.
- **The seam** is a single IR intrinsic (`IR_NUMBER_TO_STRING_FN`) resolved
  per-lane in `src/ir/integration.ts`, the same shape as `IR_STRING_CONCAT_FN` /
  `IR_STRING_CHAR_AT_FN`:
  - host: the `env.number_toString` `(f64) -> externref` import — externref IS
    the host lane's string carrier.
  - native: `emitNativeNumberFormat(ctx, {"number_toString"})` plus a minted
    `(f64) -> (ref $AnyString)` thunk that unboxes the formatter's widened
    result (`any.convert_extern` + `ref.cast`). Minting the thunk keeps the
    intrinsic's IR-visible signature representation-correct in both lanes, so
    from-ast never has to ask a mode question.
- **Boolean substitutions** are taken only if the same seam gives them for free
  with spec-correct `"true"`/`"false"`; otherwise they keep rejecting and the
  residual is recorded below.

## Test Results

(filled in by the implementation commit)
