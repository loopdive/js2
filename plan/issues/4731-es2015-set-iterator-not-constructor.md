---
id: 4731
title: "ES2015 standalone Set iterator methods and non-constructor semantics"
status: in-progress
sprint: current
created: 2026-08-25
updated: 2026-08-25
assignee: codex/4731-es2015-set-iterator-not-constructor
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: es2015
language_feature: set-iterators
goal: standalone-mode
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/property-access.ts
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccess
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/property-access.ts
  - tests/issue-4731.test.ts
---

# #4731 — ES2015 standalone Set iterator methods and non-constructor semantics

## Scope and baseline

The authoritative source baseline is `upstream/main` at
`21d7d893dfd316caa8349c6e2b23bcf61cc6e6b5` (2026-08-25). The repository's
host artifact records the three Set iterator non-constructor rows as passing:

- `test/built-ins/Set/prototype/Symbol.iterator/not-a-constructor.js`
- `test/built-ins/Set/prototype/entries/not-a-constructor.js`
- `test/built-ins/Set/prototype/values/not-a-constructor.js`

That aggregate is insufficient for this standalone-only residual, so the exact
rows and nearby controls were rerun with `runTest262File` from this commit.
The measured matrix is:

| lane | Set Symbol.iterator | Set entries | Set values | Set keys identity | Map Symbol.iterator control | Map keys/values/entries controls |
| --- | --- | --- | --- | --- | --- | --- |
| host | pass | pass | pass | pass | pass | 3/3 pass |
| standalone | fail: `isConstructor invoked with a non-function value` | pass | pass | fail: `Set.prototype.keys` is not `Set.prototype.values` | fail: same non-function control | 3/3 pass |

The Set non-constructor cohort is therefore **2/3 standalone rows passing,
with only `Symbol.iterator` failing**. The adjacent `entries`/`values` rows
are must-pass controls, as are the Map method controls. `Set/prototype/keys/keys.js`
is the minimal identity control: the standalone Set `keys` property is not
aliased to the `values` function even though both methods produce Set values.
The Map `Symbol.iterator` failure is deliberately retained as a shared-path
control and is not silently counted as a Set-only fix.

## Implementation plan

1. Confirmed the standalone failure is a computed native-prototype value read:
   `Set.prototype[Symbol.iterator]` (and the matching Map control) fell through
   to `__extern_get` with a symbol key, which has no standalone `$NativeProto`
   symbol-key arm. The `isConstructor` assertion consequently received null,
   rather than a callable native-method closure.
2. Added one exact static-shape lowering in the built-in value-read subsystem:
   Set resolves the computed iterator to the identity-stable `values` closure;
   Map resolves it to `entries`. The existing Set `entries`/`values` and Map
   method paths remain untouched.
3. Confirmed the Set identity control was an independent registration seam and
   fixed it narrowly with the collection glue alias `keys` → `values`; both
   spellings remain in the own-member CSV for reflection.
4. Added focused tests that run all eight exact Test262 rows in both host and
   standalone lanes (16 assertions total), retaining the Set non-constructor,
   Set identity, and nearby Map controls.

## Risks and non-goals

- Do not change the generic `isConstructor` contract or unrelated Map
  iterator methods without a demonstrated regression.
- Do not treat a host pass as evidence that the standalone native collection
  path is correct; the two lanes exercise different built-in carriers.
- Keep production source changes at or below 180 lines.

## Acceptance criteria

- The exact Set `Symbol.iterator/not-a-constructor.js` row passes in
  standalone, while the Set `entries` and `values` controls remain passing.
- `Set/prototype/keys/keys.js` passes if and only if the confirmed shared
  method-registration seam is part of this fix; otherwise the issue records
  the independent residual explicitly.
- Host and Map controls remain passing, with no silent harness/provider error.
- Focused tests, TypeScript 5/7 checks, lint, format, and repository hooks pass.

## Test Results

- Baseline exact run on upstream `21d7d893d`: host **8/8 pass**; standalone
  **5/8 pass, 3 fail**. The three standalone failures were Set
  `Symbol.iterator/not-a-constructor.js`, Map
  `Symbol.iterator/not-a-constructor.js` (shared control), and Set
  `keys/keys.js` (identity control). Set `entries` and `values` exact rows
  passed in both lanes.
- Post-fix exact run on the same baseline plus this change: host **8/8 pass**;
  standalone **8/8 pass**. Focused Vitest lane test
  `tests/issue-4731.test.ts`: **16/16 pass** (8 host + 8 standalone).
- TypeScript 5 (`typescript/lib/tsc.js --noEmit`) and TypeScript 7
  (`typescript@7.0.2/lib/tsc.js --noEmit -p tsconfig.ts7.json`) both pass.
  Scoped Biome lint, Prettier format check, `git diff --check`, and the
  direct lint-staged hook pass. The wrapper's first attempt lacked `npx` in
  the runtime image; invoking the checked-in lint-staged binary produced the
  same staged-file checks. LOC/function budget hooks pass with the measured
  allowances above.
