---
id: 5108
title: "ES2015 computed-only object literals lose statically folded keys in standalone"
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: medium
goal: standalone-mode
sprint: current
es_edition: es2015
language_feature: computed-property-names
task_type: bugfix
cohort: es6-language-tail-wave
files:
  - src/codegen/literals.ts
  - src/codegen/statements/variables.ts
  - src/codegen/declarations.ts
  - tests/issue-5108.test.ts
loc-budget-allow:
  - src/codegen/literals.ts
  - src/codegen/statements/variables.ts
  - src/codegen/declarations.ts
func-budget-allow:
  - src/codegen/literals.ts::objectLiteralForcesHostPath
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/declarations.ts::moduleGlobalWasmType
trap-growth-allow:
  count: 0
---

# #5108 — ES2015 computed-only object literals lose statically folded keys in standalone

## Allocation and scope

This is the canonical local issue record for the bounded ES2015 standalone
cohort. No GitHub issue is being created. The selected cohort is exactly four
ES2015 Test262 object-literal rows with arithmetic computed keys:

- `test/language/expressions/object/cpn-obj-lit-computed-property-name-from-additive-expression-add.js`
- `test/language/expressions/object/cpn-obj-lit-computed-property-name-from-additive-expression-subtract.js`
- `test/language/expressions/object/cpn-obj-lit-computed-property-name-from-multiplicative-expression-div.js`
- `test/language/expressions/object/cpn-obj-lit-computed-property-name-from-multiplicative-expression-mult.js`

The adjacent `...from-identifier.js` row has the same representation symptom,
but is deliberately outside this four-row arithmetic cohort. Runtime-key,
class-member, Symbol-key, accessor, spread, and reflective object families are
out of scope.

## Baseline evidence

The supplied snapshot `/private/tmp/js2-baseline-standalone-current-20260828.jsonl`
(oracle version 13, snapshot run on 2026-08-28) reports all four selected rows
as standalone `fail` with assertion signatures showing `undefined` where the
computed property value should be present:

| Test262 row | Snapshot row time | Standalone result |
| --- | --- | --- |
| `...from-additive-expression-add.js` | `28.8.2026, 01:46:30` | `Expected SameValue(«undefined», «2») to be true` |
| `...from-additive-expression-subtract.js` | `28.8.2026, 01:47:56` | `Expected SameValue(«undefined», «0») to be true` |
| `...from-multiplicative-expression-div.js` | `28.8.2026, 01:45:46` | `Expected SameValue(«undefined», «1») to be true` |
| `...from-multiplicative-expression-mult.js` | `28.8.2026, 01:51:20` | `Expected SameValue(«undefined», «1») to be true` |

The edition classification is verified through
`website/public/benchmarks/results/test262-file-editions.json`: each path
without the leading `test/` is indexed under `ES2015`.

Fresh probes against `upstream/main` at `18785a67c6682b9fc41d3a220a6b88f3f42dc59e`
on 2026-08-28 confirm the required differential: the host lane passes all
four rows, while standalone fails all four with the same `undefined` read:

- host: 4/4 pass (`3021f09dc202`, `7377f9d2e7ac`, `fdfc2adea18c`,
  `fdfc2adea18c` respectively)
- standalone: 0/4 pass (`2b7fe757b2e3`, `86af73e74c62`, `739252d6c68f`,
  `739252d6c68f` respectively)

## Root-cause hypothesis

`resolveComputedKeyExpression` already folds these arithmetic expressions to
the string keys `"2"`, `"0"`, `"1"`, and `"1"`. The object-literal emitter
therefore creates a closed WasmGC struct and `ensureComputedPropertyFields`
adds the folded field. TypeScript nevertheless describes a computed-only
object literal as a numeric-index-signature type with no named properties;
the standalone variable/local type mapping consequently chooses an
`externref` carrier. The value is then a struct converted to externref, while
the read uses the dynamic `$Object` lookup path. That lookup cannot see a
closed struct, so it returns `undefined`.

This is a carrier-alignment residual, distinct from the completed #212/#230
constant-folding work and from #3024's genuinely runtime-key module-global
guard. Mixed named-plus-computed literals already receive a closed struct
carrier and are not part of this issue.

## Implementation plan

1. Add one narrow predicate for a computed-only object literal whose computed
   keys all resolve statically and whose checker type has no named properties.
2. Route exactly that shape through the existing open-object construction path
   in standalone, so key expressions are evaluated once and the receiving
   local/module slot remains `externref`. Keep mixed named/computed literals,
   unresolved runtime keys, Symbol-key protocol objects, and host mode on their
   existing paths.
3. Add focused standalone equivalence tests for the four selected arithmetic
   rows plus mandatory self-contained controls covering a named literal,
   numeric literal key, and an unresolved runtime-key object. Any Test262
   assertions are corpus-guarded; the controls must run without `test262/`.
4. Re-run each selected row in host and standalone, repeat standalone probes,
   run the focused test, and validate a real no-corpus worktree shape with at
   most two workers. At the end, refresh from current `upstream/main` once,
   update this record with final evidence, and verify the branch is mergeable.

## Acceptance criteria

- The four selected Test262 rows pass in standalone on the final branch.
- The same four rows remain host-pass and no selected row flips on repeated
  standalone probes.
- Mandatory controls pass in a worktree with no `test262/` corpus present.
- Runtime-key, mixed named/computed, Symbol-key, and host-mode controls retain
  their baseline behavior; no trap-growth is accepted.
- The implementation stays within 3 source files and 45 net source LOC; the
  focused test stays within 1 test file and 140 LOC.
- This record contains the final commands/results, branch/head, and PR handoff.

## Budgets and handoff

- Source budget: `src/codegen/literals.ts`, `src/codegen/statements/variables.ts`,
  and `src/codegen/declarations.ts`, at most 45 net LOC total.
- Test budget: `tests/issue-5108.test.ts`, at most 140 LOC.
- No runtime substrate, class-member, Symbol, spread, or broad Test262 filter
  changes are authorized by this issue.
- Handoff target: one non-draft PR against `loopdive/js2:main`, with this
  tracking path called out explicitly, authored by Thomas Tränkler and with
  the Codex co-author trailer.

## Handoff log

- 2026-08-28: allocated #5108 through the upstream assignment log as
  `ttraenkler/es2015-next-lane-d`; plan checkpoint is being prepared on
  `codex/5108-es2015-computed-key-carrier`.
