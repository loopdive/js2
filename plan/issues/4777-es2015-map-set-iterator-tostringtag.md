---
id: 4777
title: "ES2015 standalone Map/Set iterator prototype Symbol.toStringTag"
status: in-progress
sprint: current
created: 2026-08-27
updated: 2026-08-27
assignee: codex/es6-next-bounded-fix-2
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: es2015
language_feature: map-set-iterator-prototype
goal: host-and-standalone
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
  - tests/test262-restore-builtins.ts
func-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
files:
  - src/codegen/expressions/call-builtin-static.ts
  - tests/test262-restore-builtins.ts
  - tests/issue-4777.test.ts
---

# #4777 — ES2015 Map/Set iterator prototype `Symbol.toStringTag`

## Scope and baseline

The authoritative source baseline is `upstream/main` at
`03ebf325013a241d5609a457fbdfea78bdf48ee2` (2026-08-27), with Test262
submodule revision `b363f29d3c43c626dc852744ad64a0b48a003693` and oracle
version 13. The exact official two-row cohort is:

- `test/built-ins/MapIteratorPrototype/Symbol.toStringTag.js`
- `test/built-ins/SetIteratorPrototype/Symbol.toStringTag.js`

The fresh standalone JSONL baseline rows were timestamped 2026-08-27 at
13:03 (the fetch began at 12:49) and report both rows as `fail` with a
`TypeError: Cannot access property on null or undefined` at the first tag
read. A direct `runTest262File` baseline rerun from this clean worktree
measured host **0/2 pass** and standalone **0/2 pass**:

| lane | Map iterator tag | Set iterator tag |
| --- | --- | --- |
| host | fail in strict rerun: actual inherited `"Iterator"` after the configurable tag was deleted | fail in strict rerun: actual inherited `"Iterator"` after the configurable tag was deleted |
| standalone | fail: `Object.getPrototypeOf` result has no readable tag carrier | fail: `Object.getPrototypeOf` result has no readable tag carrier |

The host failures are an in-process runner realm-restoration gap: Test262's
`verifyProperty` intentionally deletes the configurable own property during
the sloppy variant, and the local host realm snapshot did not include the
Map/Set iterator prototypes. The standalone failures are the product gap:
native Map/Set iterators have checker types `MapIterator`/`SetIterator`, but
the `Object.getPrototypeOf` lowering only recognizes Array and String
iterator carriers and therefore cannot return the existing iterator singleton
with its seeded descriptor.

## Specification basis

ECMA-262 (June 2020) §23.1.5.2.2,
[`%MapIteratorPrototype%[@@toStringTag]`](https://tc39.es/ecma262/2020/#sec-mapiteratorprototype-tostringtag),
requires the initial value `"Map Iterator"` with
`{ [[Writable]]: false, [[Enumerable]]: false, [[Configurable]]: true }`.
Section 23.2.5.2.2,
[`%SetIteratorPrototype%[@@toStringTag]`](https://tc39.es/ecma262/2020/#sec-setiteratorprototype-tostringtag),
requires the corresponding `"Set Iterator"` value and attributes.

## Implementation plan

1. In the standalone/WASI `Object.getPrototypeOf` path, recognize only
   checker-proven `MapIterator` and `SetIterator` arguments, compile and drop
   the argument for source-order evaluation, and return the matching
   identity-stable iterator prototype singleton. The singleton already seeds
   the exact own `Symbol.toStringTag` descriptor used by Array and String
   iterator fixes.
2. Add `%MapIteratorPrototype%` and `%SetIteratorPrototype%` to the in-process
   host realm snapshots. This restores the native configurable tag after
   `verifyProperty`'s destructive probe before the strict rerun, matching the
   sharded worker's fresh-realm inventory.
3. Add focused tests for both exact rows in host and standalone plus controls
   for identity, values, descriptor flags, and Map/Set prototype separation.

## Risks and non-goals

- Do not change Map/Set iterator production, `next()`, or method aliases; the
  exact cohort only observes the intrinsic prototype and its own tag.
- Do not route arbitrary iterator-like values: the new arm is keyed only on
  the TypeScript checker symbols `MapIterator` and `SetIterator`.
- Keep host code generation on its existing dynamic `Object.getPrototypeOf`
  path; the host snapshot addition is test-runner state hygiene only.

## Acceptance criteria

- Both exact Test262 rows pass in host and standalone lanes.
- Each returned iterator prototype is identity-stable within its family,
  distinct across Map and Set, and owns the required value/descriptor.
- Focused controls, TypeScript 5/7, lint, format, issue checks, budgets, and
  repository hooks pass.

## Test Results

The post-fix focused run used the real Test262 checkout at
`b363f29d3c43c626dc852744ad64a0b48a003693` and Vitest `v3.2.4`, capped at two
workers:

- `tests/issue-4777.test.ts`: **6/6 passed** in 22.83s.
- Exact host cohort: **2/2 passed** (`MapIteratorPrototype` and
  `SetIteratorPrototype` tag rows).
- Exact standalone cohort: **2/2 passed** (the same two official rows).
- Focused controls: **2/2 passed**, covering identity stability within each
  iterator family, Map/Set separation, tag values, and the required own
  descriptor flags.

Static and change-scoped checks passed:

- TypeScript 5 (`node node_modules/typescript/lib/tsc.js --noEmit`).
- TypeScript 7 (`node node_modules/typescript7/lib/tsc.js --noEmit -p
  tsconfig.ts7.json`).
- `biome lint` on the three changed TypeScript files.
- Prettier check on all four changed files.
- `check:issues`, `check:loc-budget`, `check:func-budget`, staged issue-ID
  uniqueness, and issue-spec coverage.
- `git diff --check`.

## Evidence and handoff

The implementation is isolated to the Map/Set `Object.getPrototypeOf`
lowering, the in-process host intrinsic snapshot, and this issue's focused
regression test. No iterator construction, `next()`, method alias, or
unrelated builtin behavior changed. The branch is
`codex/es6-next-bounded-fix-2` in worktree
`/private/tmp/js2-es6-next-bounded-fix-2`; the source/test checkpoint is
`5e7b2f12d28971c1a5ac8061e0b68ecabff25c65` and was authored by Thomas
Tränkler with the required Codex trailer. The requested push to
`ttraenkler/js2` was blocked before network execution by the sandbox's
sensitive-egress policy; no remote SHA or PR URL exists yet. Retry the push
and create the draft upstream PR only after that external-write approval is
granted.

## Post-#5065 current-main verification

The branch merged upstream tip
`2a7548ca819248df332986cde2cff81e65042bff` without rewriting history at
`440e00835644d90076201157d21e8a05220ff142`. The exact cohort remains host
**2/2 pass** and standalone **2/2 pass**, and focused coverage remains **6/6
pass** with at most two workers. Final artifacts are:

- host `.tmp/4777-final-post5065-host.jsonl` (SHA-256
  `3e2ff9993be821949f979d5ef46a155ee99980ada0480c860241e53b14dceda2`)
- standalone `.tmp/4777-final-post5065-standalone.jsonl` (SHA-256
  `c20e1a8d569e3a03a51beff1e2b6bebb9d676d6fc3cfc7ea86f719ca2b4a5e39`)

PR #5069 remains draft with `hold` and a null merge-queue entry until the
evidence checkpoint passes normal hooks and refreshed upstream CI is CLEAN and
mergeable.

## Merge-group regression guard handoff — 2026-08-27

The first merge-group attempt compiled and executed all 48,735 host Test262
rows plus the full standalone matrix. Ordinary CI and differential testing
passed, every shard completed, and the aggregate guard reported exactly one
host transition:

- `test/built-ins/TypedArray/prototype/map/return-new-typedarray-conversion-operation-consistent-nan.js`
  (`pass -> fail`, bucket signature `ca79065c32d815d4`)

This row is outside the Map/Set iterator-prototype change and is demonstrably
nondeterministic. The maintained harness' `--check-determinism` probe produced
the identical **fail then pass** sequence on both the PR branch and a detached
current-main control at `7edc857f10b47bcdee8990fbe0dec79b8b6c3d41`.
Therefore the captured transition is not a #4777 regression; it is a pre-existing
TypedArray NaN-consistency flake that the merge-group artifact happened to
sample on its failing side. No product or quarantine change is bundled here.

After the guard failure, the branch non-rewriting-merged that current upstream
tip. Fresh focused verification remains **6/6 pass** with at most two workers:
the exact host cohort is **2/2**, exact standalone is **2/2**, and the two
identity/descriptor controls pass. The next delivery step is to push this
current-main checkpoint, retain `hold` until refreshed PR checks are green, and
re-enter the merge queue for a new full-matrix sample.
