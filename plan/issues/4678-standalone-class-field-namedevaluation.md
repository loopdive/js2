---
id: 4678
title: "ES2015 standalone: private class-field NamedEvaluation loses the initializer function name"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: classes
goal: standalone-gap
related: [4450, 4857]
origin: "Bounded residual from #4450 after #4857 landed: static class-field NamedEvaluation/name-binding rows, excluding generators, reflection, destructuring, computed-key work, and derived primitive-return work."
loc-budget-allow:
  - src/codegen/function-instance-meta.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  - src/codegen/function-instance-meta.ts::fnInstanceNameOf
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
---

# #4678 — standalone class-field NamedEvaluation

## Scope

Fix the shared NamedEvaluation path for anonymous function/arrow initializers
in standalone class fields. The measured residual is the private static field
case: `static #field = () => {}` must expose `"#field"` through the function's
`name` property. The public-field and class-expression variants are included
as regression guards because they use the same metadata path.

This slice deliberately excludes generator rows (#2864), reflection rows
(#2175), destructuring rows (#4447), computed-key rows already covered by
#4857, and derived-constructor primitive-return rows already covered by #4857.

## Plan

1. Pin the two generated static-field anonymous-name rows on upstream/main and
   record their current assertion failure.
2. Trace the field initializer's TypeScript parent through NamedEvaluation;
   make the smallest key-name representation fix, preserving computed-key
   narrowing and all non-class function-name behavior.
3. Add focused issue tests for public/private static and instance field
   initializers, including class declarations and expressions.
4. Re-run the focused conformance rows, issue tests, nearby class-field guards,
   and a bounded zero-loss sweep. Record exact before/after results and the
   compile/test budget in this issue.

## Baseline (upstream/main `a1e65f5b1`, 2026-08-25)

The fresh upstream base was compiled with `target: "standalone"` through the
test262 wrapper. Compile errors were reported separately; a runtime failure is
reported as a positive assertion index (assertion numbering starts at `2`).

| row | baseline | observed root |
| --- | ---: | --- |
| `language/statements/class/elements/static-field-anonymous-function-name.js` | `2` | private `#field` arrow name is not `"#field"` |
| `language/expressions/class/elements/static-field-anonymous-function-name.js` | `2` | same private-field NamedEvaluation miss in a class expression |

The public `static field = function () {}` assertion in each row is a guard
for the existing identifier-key path and is not the failing arm.

## Root cause and fix

The closure metadata emitter already handled identifier, string, and numeric
field keys, but it declined a `PrivateIdentifier`; the private class-field
layout's internal `__priv_…` key therefore never became the observable
`#field` function name. Adding the private key's source spelling to
`fnInstanceNameOf` keeps the metadata value spec-correct.

The `.name` static peephole also treated the class method's call result as an
anonymous checker function and folded it to `""`. A call signature identifies
only the return type, not the function instance returned by that method. The
peephole now recognizes the narrow `return this.<field>` shape when that field
has an anonymous function/arrow initializer and declines only that read, so the
runtime metadata reader observes the actual NamedEvaluation result. Direct
identifier/property reads and method-return calls retain their existing
zero-cost folds.

## Test Results (2026-08-25)

Scoped command budget: direct test262 runner (2 exact rows + 4 length guards)
and one Vitest file (3 tests, one worker); no full class filter or full test262
run was attempted because that exceeds the bounded slice and the repository's
test262 process is memory-heavy.

| check | before | after |
| --- | ---: | ---: |
| `statements/class/elements/static-field-anonymous-function-name.js` | `2` (first assertion failure) | `1` (pass) |
| `expressions/class/elements/static-field-anonymous-function-name.js` | `2` (first assertion failure) | `1` (pass) |
| 4 anonymous-field `length` declaration/expression/static/instance guards | `1` | `1` |
| `private-static-method-name.js` declaration/expression guards | not rerun before | `1`, `1` |
| `tests/issue-4678.test.ts` | not present | 3/3 pass |
| `expressions/function/name.js`, `statements/function/name.js` | not rerun before | `1`, `1` |

`tsc --noEmit` passes under both the TypeScript 5 and TypeScript 7 project
configs, and the scoped Biome lint passes for both codegen files and the issue
test.

The source delta is 59 added lines and 3 removed lines in the two allowed
codegen files; no new imports, runtime helpers, or CI/test-budget ratchets are
needed. Computed-key, generator, reflection, destructuring, and derived-return
rows remain explicitly out of scope.
