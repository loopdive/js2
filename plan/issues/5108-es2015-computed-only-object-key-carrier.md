---
id: 5108
title: "ES2015 computed-only object literals lose statically folded keys in standalone"
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
pr: 5116
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
without the leading `test/` is indexed at value `2`, and
`editions[2]` is exactly `ES2015`.

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

1. Add one narrow, syntax-driven predicate for a computed-only object literal
   whose arithmetic keys all resolve statically. This is the exact selected
   shape whose checker type has no named properties, without adding a raw
   checker query in codegen.
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

## Implementation and validation checkpoint

Implemented in `src/codegen/literals.ts` by adding a standalone-only,
syntax-driven predicate for data-only computed literals whose arithmetic keys
all fold. The existing `objectLiteralForcesHostPath` consumers then keep the
literal and its local/module binding on the same open-object `externref`
carrier. Mixed named/computed literals, non-arithmetic computed keys, and
unresolved runtime keys continue using their existing paths. The predicate
does not add a raw TypeScript checker query. Net source growth remains within
the 45-LOC budget; no trap-growth or oracle-ratchet allowance is used.

Against the current upstream baseline commit recorded above:

- authoritative host probes: 4/4 pass;
- authoritative standalone probes: 4/4 pass;
- a second standalone repeat: 4/4 pass with identical per-row Wasm hashes;
- focused `tests/issue-5108.test.ts` with corpus present: 8/8 pass;
- real no-corpus shape (this worktree's `test262` symlinks hidden) with
  `--maxWorkers=2 --minWorkers=1`: 4/4 mandatory controls pass and 4 optional
  corpus tests skip;
- related `tests/issue-computed-props.test.ts` and
  `tests/issue-4683.test.ts`: 12/12 pass;
- out-of-cohort standalone controls (numeric/string basics, duplicate numeric
  keys, identifier key, runtime function key, and literal key): 7/7 pass;
- TypeScript 5 and TypeScript 7 typechecks, Prettier, Biome, and `git diff
  --check`: pass.

The focused test imports the Test262 runner dynamically inside the
corpus-guarded block, so mandatory controls remain runnable when the corpus is
absent and do not depend on a hidden fixture.

## Final synchronized validation

The one final upstream sync fetched `upstream/main` at
`70e8e3c1ca` (2026-08-28) and rebased this branch cleanly on that commit.
Post-sync validation remained green:

- `tests/issue-5108.test.ts` with the corpus present: 8/8 pass using
  `--maxWorkers=2 --minWorkers=1`;
- final authoritative probes: 4/4 host pass and 4/4 standalone pass;
- final standalone repeat set: 4/4 pass, with the same hashes as the first
  post-sync probe (`add bcd97e934248`, `subtract 84ce90bbb5ff`, and
  `div/mult b32352f9c09e`);
- final no-corpus shape after the sync: 4/4 mandatory controls pass and the
  4 optional Test262 rows skip;
- the first publication pre-push correctly rejected one new raw
  `ctx.checker.getTypeAtLocation` site. The implementation was narrowed to a
  syntax-driven arithmetic predicate, the direct checker query was removed,
  `check:oracle-ratchet` now reports `getTypeAtLocation +0` and
  `ctx.checker +0`, and no allowance was added. The corrected focused suite
  remains 8/8, including all four exact standalone rows;
- the worktree is clean and the branch is directly based on current
  `upstream/main` (no merge conflicts or unresolved files).

The completed non-draft upstream review is
[PR #5116](https://github.com/loopdive/js2/pull/5116), targeting
`loopdive/js2:main` from `ttraenkler/js2` branch
`codex/5108-es2015-computed-key-carrier`.

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
- 2026-08-28: final implementation and validation checkpoints are complete;
  the oracle-safe head was pushed and opened upstream as PR #5116.
