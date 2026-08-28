---
id: 5104
title: "fix(standalone): preserve Boolean prototype Symbol.toStringTag"
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: boolean-wrapper
es_edition: 2015
goal: spec-completeness
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
assignee: "ttraenkler/es2015-next-lane-b2"
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/standalone-primitive-tail.ts
  - tests/issue-5104-boolean-prototype-tostringtag.test.ts
  - plan/issues/5104-boolean-prototype-tostringtag.md
---

# Boolean prototype `Symbol.toStringTag`

## Scope and baseline

This plan owns exactly these two official Test262 rows:

```text
test/built-ins/Boolean/prototype/S15.6.3.1_A1.js
test/built-ins/Boolean/S15.6.2.1_A4.js
```

On clean source `caeaa2e1cf2aa225297c53076d27f97c8449a527`, the assembled
official harness reports host `2/2` and standalone `0/2`. Both rows delete the
own `Boolean.prototype.toString` method and then rely on
`Object.prototype.toString`; standalone observes `"false"` instead of the
required `"[object Boolean]"`. Structural controls report one required pass
and one required failure in both lanes, and the standalone repeat is stable.

The cohort is file-disjoint from the active iterator, Set, BigInt, yield-star,
isNaN, and WeakCollection work. It changes no constructor, wrapper unboxing,
or generic `Object.prototype.toString` behavior.

## Root-cause theory

The `loc-budget-allow` and `func-budget-allow` entries are limited to the
existing call-receiver dispatcher because that is the one dispatch seam that
orders the standalone primitive tails; the eight added lines only pass the
deleted-Boolean callback through to the subsystem helper. The helper
implementation itself lives in `standalone-primitive-tail.ts`, keeping the
behavioral code out of the dispatcher.

Standalone Boolean wrapper prototypes are represented by the shared native
prototype companion. Boolean glue registered only the string-named `toString`
and `valueOf` members, without the required own `Symbol.toStringTag` data
property. The first metadata-only probe confirmed that this omission was one
part of the defect: the descriptor was absent in standalone output.

The exact rows still failed after that metadata change. A direct standalone
probe showed that deleting `Boolean.prototype.toString` left the tag present
and made an explicit `Object.prototype.toString.call(proto)` return
`"[object Boolean]"`, but the normal `proto.toString()` call returned
`"false"`. The specialized `tryCompileStandaloneBooleanToString` fast path
ran before the deleted-method fallback and recovered the internal Boolean
slot even though the own method had been removed.

The final fix therefore has two narrow pieces: pass the existing glue
registration the tag string `"Boolean"` so the companion seeder installs the
standard descriptor, then route only deleted standalone Boolean `toString`
calls through the inherited `Object.prototype.toString` path before that fast
path. Host output and all unrelated Boolean method/boxing paths remain
unchanged.

## Implementation plan

1. Seed the Boolean native-prototype companion with its existing `symbolTag`
   metadata argument.
2. Add a deleted-Boolean-only standalone dispatch guard that borrows
   `Object.prototype.toString` after the own method is removed; leave generic
   call dispatch and Boolean wrapper conversion untouched.
3. Add a focused regression with one corpus-backed test per exact row in both
   lanes, plus mandatory descriptor and ordinary-object controls. Guard only
   the optional corpus-backed cases when `test262` is absent.
4. Re-run the exact rows with pass/fail controls and determinism in both lanes,
   using no more than two workers, then run focused and repository gates.

## Acceptance criteria

- Both exact rows pass in host and standalone, with no control loss or new hard
  error; repeats report zero nondeterminism.
- Standalone `Boolean.prototype[Symbol.toStringTag]` is exactly `"Boolean"`
  with the standard non-writable, non-enumerable, configurable descriptor;
  the host control records the host realm's intentional absence of an own
  tag while both host exact rows remain green.
- The source diff remains confined to Boolean native-prototype glue and the
  deleted-Boolean standalone call-dispatch seam plus the regression test; no
  host imports or iterator/collection paths are touched.
- Typecheck, lint, format, budget, ratchet, issue-integrity, and normal
  pre-push gates pass.

## Validation evidence

- Baseline at `caeaa2e1cf2aa225297c53076d27f97c8449a527`: host `2/2`, standalone
  `0/2`; structural must-pass/must-fail controls were intact and deterministic.
- Final authoritative repeat 1: host `2/2`, standalone `2/2`; each run's
  controls reported one pass and one expected failure, totals summed, and
  nondeterminism was `0`.
- Final authoritative repeat 2: host `2/2`, standalone `2/2`; the same
  controls and `nondeterministic: 0` were observed with
  `COMPILER_POOL_SIZE=2`.
- Focused Vitest with the corpus: `6 passed` (two exact-row cases and four
  mandatory controls). Simulated changed-root packaging without the corpus
  (`JS2_TEST262_AVAILABLE=0`): `4 passed | 2 skipped`; controls remained
  mandatory and green.
- Hermetic packaging copy with both `test262` and `.test262-cache` absent (and
  only the dependency install symlinked): `4 passed | 2 skipped` with no
  environment override; the copy was removed after the run and the source
  worktree's provisioned corpus wrapper is intact.
- Required gates observed locally: TypeScript 7 typecheck, Biome lint,
  Prettier check, LOC/function budgets (the two documented dispatch allowances),
  oracle ratchet, coercion-site ratchet, and issue integrity all passed.
- The optional TypeScript 5 compatibility command emitted no diagnostics but
  did not finish after several minutes and was interrupted; it is not part of
  the normal pre-push hook.
- After syncing current `upstream/main` at `4c2bc1de6a`, merge commit
  `7a95daac74` reproduced host `2/2` and standalone `2/2` with intact controls
  and `nondeterministic: 0`; focused coverage remained `6 passed`, and the
  no-corpus override remained `4 passed | 2 skipped`.

## Handoff

The atomic assignment reservation for this plan is held on the upstream
assignment registry as `5104`; no external issue is used for tracking. The
implementation checkpoint is `2141c7852b`, and the current-main sync merge is
`7a95daac74` (upstream `4c2bc1de6a`). The final handoff is ready for one
upstream PR from this branch. PR `#5113`
(`https://github.com/loopdive/js2/pull/5113`) is published non-draft from
`ffc3a6e5cc2a3fc73fd58b130d871dff2f648f53`; the initial snapshot reported
`MERGEABLE` with GitHub's `BEHIND` status while its fresh checks were queued or
running (CLA already green). No hold or merge-queue mutation was made.
