---
id: 5124
title: "ES2015 Map and Set zero-argument prototype method length metadata"
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES2015
language_feature: builtin-prototype-function-metadata
goal: standalone-mode
assignee: "ttraenkler/codex-5124-es2015-prototype-method-zero-arity"
branch: codex/5124-es2015-prototype-method-zero-arity
pr: 5139
files:
  - src/codegen/array-object-proto.ts
  - tests/issue-5124-es2015-prototype-method-zero-arity.test.ts
  - plan/issues/5124-es2015-prototype-method-zero-arity.md
loc-budget-allow:
  - src/codegen/array-object-proto.ts
---

# #5124 — ES2015 Map/Set zero-argument method `length` metadata

## Scope and ownership

This markdown issue owns exactly these seven official ES2015 host-pass,
standalone-fail Test262 rows:

- `test/built-ins/Map/prototype/clear/length.js`
- `test/built-ins/Map/prototype/entries/length.js`
- `test/built-ins/Map/prototype/keys/length.js`
- `test/built-ins/Map/prototype/values/length.js`
- `test/built-ins/Set/prototype/clear/length.js`
- `test/built-ins/Set/prototype/entries/length.js`
- `test/built-ins/Set/prototype/values/length.js`

Issue ID 5124 was atomically reserved with
`node scripts/claim-issue.mjs --allocate`, then claimed for this branch on
`upstream/issue-assignments`. This file is the canonical tracker; do not create
a GitHub issue. GitHub pull request #5124 is an unrelated object in GitHub's
shared issue/PR number space and is not this tracker.

The three analogous Array iterator-method rows are deliberately sibling
controls rather than part of the ES2015 count because the maintained edition
map classifies them as `Unclassified (untagged)`:

- `test/built-ins/Array/prototype/entries/length.js`
- `test/built-ins/Array/prototype/keys/length.js`
- `test/built-ins/Array/prototype/values/length.js`

## Current-main baseline evidence

The dedicated branch starts from current `upstream/main` at
`1d110ec6bda80a1303f73df96944ef892e91d71f`. The authoritative snapshots are:

- standalone: `/private/tmp/js2-baseline-standalone-current-20260828.jsonl`
  (SHA256 `260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`);
- host: `/private/tmp/js2-baseline-host-current-20260828.jsonl`
  (SHA256 `a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`).

All seven owned rows pass in the host snapshot. All seven standalone rows
reach the test and fail with `assertion_fail`:
`length descriptor value should be 0; length value should be 0`. None is a
compile error, timeout, host-import leak, or skip. The three Array sibling rows
have the same host-pass/standalone-fail signature. TypedArray
`entries`/`keys`/`values` metadata already passes in both lanes and is a
required non-regression control.

## Root cause

`src/codegen/array-object-proto.ts` owns the shared
`PROTO_METHOD_LENGTH` metadata used by direct prototype-method reads and by
the reflective standalone builtin-function metadata carrier. The table omits
`clear`, `entries`, `keys`, and `values`, so `makeCollectionGlue` and the
generic prototype glue use the shared fallback arity `1`.

These four methods are zero-argument builtins: `Map.prototype.clear`, all
Array/Map/Set `entries`/`keys`/`values` methods, and the corresponding
reflective function values must report `length === 0` with a non-writable,
non-enumerable, configurable own descriptor. The TypedArray family has a
separate `TYPED_ARRAY_PROTO_METHOD_LENGTH` table that already records its
iterator methods as zero-arity.

## Implementation plan

1. Add the four missing zero arities to the null-prototyped shared
   `PROTO_METHOD_LENGTH` table. Keep the change at the canonical metadata seam;
   do not add Map/Set-specific property-read folds or special cases in the
   Test262 harness.
2. Confirm the shared table feeds both direct reads and reflective/dynamic
   metadata carriers without altering closure identity, call lowering, method
   bodies, or descriptor mutability/deletion semantics. Preserve non-zero
   siblings such as `Map.prototype.set.length === 2`,
   `Set.prototype.add.length === 1`, and callback-taking methods.
3. Add `tests/issue-5124-es2015-prototype-method-zero-arity.test.ts` with
   mandatory host and standalone compiler controls independent of the Test262
   checkout. Cover all seven owned Map/Set reads, the three Array sibling
   controls, dynamic/aliased function-value reads, exact descriptors and
   names, positive non-zero siblings, TypedArray non-regression, callable
   behavior, and zero standalone imports.
4. Existence-guard the exact corpus rows and give every Vitest wrapper around
   the 120-second authoritative runner an explicit outer timeout above 120
   seconds. Run fresh exact host/standalone A/B after the fix and record counts
   and error details in this file.
5. Run the focused suite with at most two workers, TypeScript 5/7, lint,
   Prettier, LOC/function budgets, oracle/coercion ratchets, issue integrity,
   numeric-local parity, and the complete pre-push hook. Integrate current
   upstream non-destructively before handoff and push every verified checkpoint
   to `ttraenkler/js2` without rewriting history.

## Acceptance

- All seven owned ES2015 rows pass in host and standalone lanes.
- The three Array sibling rows and existing TypedArray iterator metadata remain
  correct.
- Direct and reflective reads report `length === 0`, `name` is unchanged, and
  the standard `length` descriptor remains non-writable, non-enumerable, and
  configurable.
- Non-zero sibling arities and actual method calls remain unchanged.
- Focused standalone modules emit zero host imports.
- Focused/exact tests, TypeScript 5/7, lint, format, budgets, ratchets, issue
  integrity, numeric-local parity, and full pre-push pass.
- This markdown issue records final evidence, final SHA, handoff, and the
  single non-draft upstream PR URL; no GitHub issue is created.

## Handoff

Work only in
`/private/tmp/js2-es2015-prototype-method-zero-arity-20260828` on branch
`codex/5124-es2015-prototype-method-zero-arity`. Push checkpoints to the fork
without force. Do not open the PR from the worker; root will review the final
clean branch and open exactly one non-draft PR against `loopdive/js2:main` when
it is mergeable.

## Implementation Summary

The shared null-prototyped `PROTO_METHOD_LENGTH` table now records the four
omitted zero arities: `clear`, `entries`, `keys`, and `values`. This keeps
direct and reflective/dynamic Map, Set, and Array prototype metadata on the
same canonical carrier; no harness special case, method-body change, or
property-read fold was added. `Set.prototype.keys` remains the intrinsic alias
of `Set.prototype.values`, including its canonical function name.

The regression suite adds mandatory host and standalone controls independent
of corpus availability. It checks all seven owned Map/Set rows, three Array
sibling rows, dynamic aliases, function and prototype descriptors, names,
non-zero siblings, actual `clear()` calls, TypedArray iterator metadata, and
the standalone zero-import boundary. The exact Test262 rows are existence
guarded and each `runTest262File(..., 120_000)` wrapper has an outer
180-second timeout.

## Validation Evidence

- Focused pinned run: `22/22` tests passed (`2` controls plus `20` exact
  host/standalone rows), with
  `JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`
  and one worker (within the two-worker maximum).
- Both mandatory controls passed; the standalone control compiled with zero
  WebAssembly imports. All seven owned rows and all three Array sibling rows
  passed in both lanes.
- TypeScript 5 and TypeScript 7 typechecks, Biome lint, and Prettier checks
  passed. LOC/function budgets, oracle/coercion ratchets, issue IDs and
  integrity, conformance-number sync, verdict-oracle, spec-coverage, and
  numeric-local parity also passed. Spec-coverage emitted only pre-existing
  warnings for unrelated ready issues; no gated done-flip was missing a
  probe/test reference.
- The complete `.husky/pre-push` hook passed end-to-end with an empty ref
  stream: typecheck/lint, format, ratchets, numeric-local parity, conformance
  sync, and issue-integrity stages all passed. No remote mutation was made.
- Current-upstream reconciliation was then performed as a clean non-fast-
  forward merge of local `upstream/main` at `59ab7c0e6627a1d200e406aa0454fc99d5147615`;
  the corrected merge commit preserved both parents and all three owned files.
  The post-merge pinned focused rerun again passed `22/22` tests.

## Handoff Evidence

Only the three owned files are changed. No GitHub issue was created. Root
verified the fork at exact pre-PR head
`5689dc8591104f3aeb1f898ee07261cb903cbb56` and opened the single non-draft
upstream PR: https://github.com/loopdive/js2/pull/5139. The implementation
checkpoint (parent of the documentation-only handoff) is
`621de07f7c9a36c1fb1735465debf2ebd5ed8fdd`; the final branch SHA is reported
above. The corrected upstream merge checkpoint (parent of the post-merge
documentation update) is `0098c6cbed`; the worktree was clean at publication.
