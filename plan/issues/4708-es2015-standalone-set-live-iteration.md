---
id: 4708
title: "ES2015 standalone Set for-of observes live mutations"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen, standalone, conformance
es_edition: es2015
language_feature: for-of, Set
goal: spec-completeness
assignee: codex/4708-es2015-standalone-set-live-iteration
loc-budget-max-source: 180
loc-budget-allow:
  - src/codegen/statements/loops.ts
oracle-ratchet-allow:
  - src/codegen/statements/loops.ts
related: [4704, 4680, 4696, 4702]
files:
  - src/codegen/statements/loops.ts
---

# ES2015 standalone Set for-of observes live mutations

## Exact cohort and exclusions

This issue owns exactly these two standalone native Set rows:

- `test/language/statements/for-of/set-contract.js`
- `test/language/statements/for-of/set-expand.js`

The patch is limited to synchronous `for (var|let|const x of set)` iteration
over the native standalone `$Map` backing used for Set values. It must preserve
insertion order, skip a deleted-but-not-yet-visited entry, and visit a value
added during iteration at the new tail position.

The exact `set.js` row and `set-contract-expand.js` are excluded: #4704
identified their failures as the distinct dynamic-`any`/mutable-binding lane,
not Set storage. Host iteration, Map iteration, Set `entries` (#4680),
destructuring, async iteration, IteratorClose, and generic fresh-binding work
are also excluded.

## #4704 evidence and bounded experiment

Issue #4704 measured the current cohort on fresh host and standalone runs:
`set-contract.js` and `set-expand.js` passed on host but failed standalone
with `Expected SameValue(«1», «0»)` and `Expected SameValue(«1», «2»)`.
The native standalone path eagerly materialized the Set values into a vector
before entering the loop. Consequently deletion of a pending entry was not
observed and insertion during the loop was not visited.

The #4704 bounded experiment replaced that snapshot with a live `$Map` entry
walk. The two typed controls then passed in both lanes, directly confirming
the Set projection/iteration seam as the bounded fix. The experiment was
reverted because it was tested against the broader #4704 cohort, where the
excluded `set-contract-expand.js` dynamic-binding case did not terminate; that
result does not invalidate this standalone two-row slice.

## Passing controls

Before and after the source change, run fresh processes for the two exact rows
and these controls:

- ordinary array `for-of` mutation controls (existing passing rows);
- ordinary string `for-of` controls (existing passing rows);
- a non-mutating native standalone Set `for-of` control;
- the excluded rows only as negative-scope checks, recording that they remain
  outside this change rather than treating their known failures as acceptance.

The host lane is a control for no host-path change, not an acceptance target.

## Implementation plan

1. Reproduce the exact two rows on fresh host/standalone processes and inspect
   emitted WAT to confirm the eager vector is the first divergence.
2. Trace the native Set projection and the existing `$Map` tombstone layout;
   identify the narrowest loop seam that can advance an entry cursor while
   re-reading live `entryCount` and skipping tombstones.
3. Replace only the standalone Set-values snapshot path with that bounded live
   walk, leaving Map/default entries, Set entries, destructuring, and generic
   iterator lowering unchanged. Keep changed compiler/runtime source at or
   below 180 lines.
4. Re-run both exact rows plus the controls, TypeScript/format checks, and a
   host regression smoke test. Record results and inspect the diff before push.

## Acceptance criteria

- `set-contract.js` passes in standalone.
- `set-expand.js` passes in standalone.
- Array and string `for-of` controls remain passing.
- A non-mutating native standalone Set `for-of` remains passing.
- No source changes to host iterator behavior, Map, Set `entries`,
  destructuring, async, IteratorClose, or generic fresh-binding semantics.
- Changed compiler/runtime source remains at or below 180 lines.
- Targeted tests, TypeScript check, formatting, and diff review pass; no
  unrelated worktree changes are included.

## Test Results

Fresh post-fix runs on upstream `d455e14cc`:

| Check | Host | Standalone |
| --- | --- | --- |
| `set-contract.js` | pass | **pass** |
| `set-expand.js` | pass | **pass** |
| `array.js` | pass | pass |
| `array-contract.js` | pass | pass |
| `array-contract-expand.js` | pass | pass |
| `array-expand-contract.js` | pass | pass |
| `string-bmp.js` | pass | pass |
| `string-astral.js` | pass | pass |

The focused `tests/issue-4708.test.ts` run is **10/10**: the two exact
standalone rows, two host no-change controls, and six standalone array/string
controls. Four direct standalone probes also returned the spec counts: pending
deletion `1`, tail insertion `2`, delete/re-add at the tail `2`, and an
entry-array growth append `9`.

The excluded `set.js` and `set-contract-expand.js` remain failures in the
standalone lane with their known dynamic-any/mutable-binding signatures; no
code path for those cases was broadened by this issue.

## Implementation Summary

**What was done:** Bare native Set `for-of` with a simple binding now walks the
native `$Map` entry array directly. The cursor re-reads `entryCount` and the
current `entries` array on every step, advances before tombstone filtering,
and coerces each live entry value into the loop binding.

**What worked:** Reusing the existing `$Map` layout and loop-depth/shadow
helpers kept the fix to 101 compiler source lines and made deletions, appends,
delete/re-add, and backing-array growth observable.

**What did not change:** Eager projection remains for `.values()` and all
other collection consumers; Map, Set `entries`, host iteration, destructuring,
async, IteratorClose, and generic fresh-binding behavior stay outside this
slice.

**Files changed:** `src/codegen/statements/loops.ts`,
`tests/issue-4708.test.ts`.
