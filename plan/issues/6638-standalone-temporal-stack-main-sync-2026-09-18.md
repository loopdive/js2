---
id: 6638
title: "Standalone Temporal stack (#5383): S54 main sync — merge origin/main into the S13-S54 branch ahead of PR #5978"
status: done
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
owner: sendev-s54
assignee: ttraenkler/sendev-s54
completed: 2026-09-18
---

# #6638 — S54: sync the standalone-Temporal stack with `origin/main`

Origin: dispatched as the S54 lane of #5383 (standalone Temporal). The
accepted stack head (S53b2, `d1803a8bd2`, branch
`issue-5383-standalone-temporal-s53b2` — PR #5978's head) was ~112 commits
behind `origin/main`. This issue tracks the sync.

## What was done

Branched `issue-5383-standalone-temporal-s54` from `d1803a8bd2`, merged
`origin/main` (merge-base `4a5d5c1dfba16493166de7c90e0b6a74a4b05186`, main tip
at merge time `7b5fff8ae14570c4d12436c90af30059d7438cad`).

### The one real conflict

`src/codegen/array-object-proto.ts` — main's #6493 S1
(`function-proto-call-apply.ts`, first-class `Function.prototype.call/apply`)
and the stack's #6630 (`function-proto-invokers.ts`, `call`/`apply`/`bind`
surviving `%Function.prototype%` materialization) both wired bodies for the
same Function-family member ladder in `makeGlue`'s `emitMemberBody`.

**Resolution: kept the stack's `function-proto-invokers.ts` as the single
implementation.** It is a strict superset of main's file — it covers `bind`,
which main's file never implemented — so keeping main's file as well (with its
`??`-ladder entry running first) would have left the stack's `call`/`apply`
bodies as unreachable dead code for those two members while `bind` fell
through to the stack's body regardless. Deleted
`src/codegen/function-proto-call-apply.ts` and its wiring. Main's unrelated
addition in the same commit — the `[[ErrorData]]` class-tag arm in
`src/codegen/object-proto-tostring.ts` (§20.1.3.6 step 8, an Error receiver
answering `[object Error]`) — has no overlap with the Function-family ladder
and merged clean.

**Follow-up fix (separate commit, `7bee4f3268`):** the first re-run of main's
own witness, `tests/issue-6493-first-class-builtin-method-values.test.ts`,
caught a real gap in the "kept stack's file" choice: main's apply body
implemented §20.2.3.1 step 3 (`CreateListFromArrayLike` throws a TypeError for
a primitive, non-nullish `argArray`) and the stack's never did — it forwarded
straight to `__apply_closure`, which reads a primitive `argArray`'s
length/indexed-get generically and would silently degrade to a zero-argument
call instead of throwing. Ported the guard into
`function-proto-invokers.ts::emitFunctionProtoApplyBody` as
`pushApplyArgArrayGuard`, adapted from main's `emitApplyArgList`. Re-run after
the fix: `tests/issue-6493-*.test.ts` (11/11) and
`tests/issue-6630-function-prototype-call-after-bootstrap.test.ts` (6/6) both
green against the one merged implementation.

### `scripts/compiler-boundaries.json` reclassification

Renamed the `function-proto-call-apply.ts` entry to `function-proto-invokers.ts`
(the file that now exists) and added an entry for main's new
`src/codegen/interface-class-implementer.ts` (from main's #6634, unrelated to
this conflict, no overlap). `check:compiler-boundaries` now reports only the
pre-existing `inventory-valid-architecture-incomplete` red
(`inventoryValid: true`) — the same one the dispatch brief named as
"inherited, known" — not the `unclassified-module`/`stale-classification`
reds the merge introduced before this fix.

**One process note**: while investigating this file's post-merge state, an
intermediate `git checkout HEAD -- scripts/compiler-boundaries.json` (run
before the merge was committed, so `HEAD` was still the pre-merge stack tip)
clobbered git's auto-merged result back to the pre-merge version, silently
dropping every one of main's ~90 lines of additions to that file.
Reconstructed the correct 3-way merge with `git merge-file` against the actual
merge-base blob, then re-applied the two classification edits. Caught before
committing by diffing against `origin/main` and confirming the expected ~90
lines of diff remained.

### The `#6637` stranded `func-budget-allow` grant

`plan/issues/6637-cross-module-proxy-trap-route.md` carried a grant for
`src/codegen/object-proto-tostring.ts::emitObjectProtoToStringClassifier`,
explicitly noted in its own text as needed only until "the stack rebases past
main's ceiling-moving commit `0bf2914353`". That commit is now an ancestor of
this branch (via the merge), and a fresh
`LOC_GATE_BASE=$(git rev-parse origin/main) node scripts/check-func-budget.mjs`
run confirms no unallowed growth is reported for that function without the
grant. Dropped it per the grant's own instructions.

## Gates (merged tree, both commits `abc4c6dc79` merge + `7bee4f3268` fix)

All green: `typecheck`, `check-loc-budget` (both `merge-base(origin)` and
`LOC_GATE_BASE=origin/main`), `check-func-budget` (both bases),
`check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`,
`check:speculative-rollback`, `check:issue-ids:against-main`,
`update-issues.mjs --check`, `lint`, `format` (no diff). `check:compiler-boundaries`
reports only the pre-existing `inventory-valid-architecture-incomplete` red.

## Witness re-run (merged + fixed tree)

Baseline BEFORE merging, on `d1803a8bd2`:
`tests/issue-66*.test.ts tests/issue-6484-*.test.ts` — 38 files / 240 tests, 0
failed.

Full union `tests/issue-64*.test.ts tests/issue-65*.test.ts
tests/issue-66*.test.ts tests/issue-6484-*.test.ts` (115 files, run batched
— each vitest fork is capped at 512MB by `vitest.config.ts`'s
`VITEST_FORK_MAX_OLD_SPACE_SIZE` default and a single large batch OOMs;
raised to 3072MB for these runs): **all green** except the one #6493
`apply`-step-3 gap above, fixed in `7bee4f3268` and re-verified green.

## Re-baselined battery vs the pre-merge S53b2 numbers

See "### S54 findings" in #5383 for the full per-family table and
`equivalence:gate` comparison, and the handoff doc's new
"Stack state 2026-09-18 (post-S54)" section for the numbers the next lane
should treat as base.

## Verdict

**Acceptable as PR #5978's new head.** Full re-baseline (3,684 real-provider
test262 rows across four Temporal families + the A–F must-not-move battery,
plus 115 unit witness files, plus the 1,742-case equivalence gate) found
exactly one `pass→fail`, and it is attributable to main's own commit
`06dbc8d88f` (#6491) in a file (`src/compiler/early-errors/module-rules.ts`)
the stack never touches — not caused by this sync. 11 tests moved
`fail→pass` for free from main's own improvements. See #5383's "### S54
findings" for the full per-family table and root-cause writeup.
