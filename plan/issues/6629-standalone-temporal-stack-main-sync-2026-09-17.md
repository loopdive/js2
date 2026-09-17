---
id: 6629
title: "S42 — sync the standalone-Temporal stack (#5383) onto origin/main (4a5d5c1dfb) and fix the #6484 S1 iterator-prototype merge regression it introduced against #6609/#6625"
status: done
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: standalone-gap
parent: 5383
completed: 2026-09-17
assignee: ttraenkler/senior-dev-s42
---

## Summary

S42's job: merge `origin/main` (4a5d5c1dfb) into the accepted stack head
(S41b, `b84898a96c`, branch `issue-5383-standalone-temporal-s41b`) and fix
whatever witness regressions the merge introduced, with no new feature work.

Worktree: `/home/user/js2/.claude/worktrees/agent-a25f7f5520f0cbb37`
Branch: `issue-5383-standalone-temporal-s42`
Merge commit: `527310b81f` (`git merge origin/main`, clean — **zero conflicts**,
110 files changed, 14471 insertions, 3050 deletions)

## Baseline (before merge)

`npx vitest run --maxWorkers=2 tests/issue-66*.test.ts` on `b84898a96c`:
**30 files / 150 tests, all green.**

## Post-merge witness run

Same command on `527310b81f`: **3 files failed / 12 tests failed** — all in
`Object.getPrototypeOf(<class object / function value>)` paths:

- `tests/issue-6609-standalone-dynamic-callable-getprototypeof.test.ts` (2)
- `tests/issue-6617-class-instance-prototype.test.ts` (7)
- `tests/issue-6625-standalone-link-boundary-class-object-prototype.test.ts` (3)

All twelve read `expected 'false' to be 'true'` — the #6609/#6625 "a value
that is CALLABLE, or a CLASS OBJECT, only at runtime answers
`%Function.prototype%`" fix had stopped firing entirely, including its own
non-linked, single-module control cases.

## Root cause

Main's `Object.getPrototypeOf` (#6484 S1 —
`src/codegen/expressions/call-builtin-static.ts`,
`emitBuiltinGetPrototypeOfFallback`) added a run-time `$__IterRec`-aware
branch that fires whenever `ensureIterRecPrototypeHelper` and the
`__IterRec` struct type are both present — which is **unconditional**
(`ensureIterRecPrototypeHelper` bootstraps the iterator runtime rather than
declining, by its own docstring's explicit design, "so on the very first
`Object.getPrototypeOf(a[Symbol.iterator]())` in a module `$__IterRec` is not
registered yet… while the SAME expression one statement later answers a real
prototype"). That branch's own `else` arm — a non-`$__IterRec` receiver —
called the generic `__getPrototypeOf` import **directly**, and then
`return`ed unconditionally, **never falling through to
`objectGetPrototypeOf.tryEmitDynamicCallableGetPrototypeOf`** (the
#6609/#6625 mechanism), which sits several lines further down in the SAME
function but is only reachable from a **second, separate** code path (taken
only when `iterProtoIdx`/`iterRecTypeIdx` are both absent — i.e. effectively
never, in standalone mode, once the module allocates the IterRec bootstrap).

No file conflict flagged this: `object-get-prototype-of.ts` (the #6609/#6625
mechanism itself) is byte-identical between S41b and the merge
(`git diff b84898a96c HEAD -- src/codegen/expressions/object-get-prototype-of.ts`
is empty) — main's #6484 change is entirely in a DIFFERENT file
(`call-builtin-static.ts`) that happens to intercept every call before the
stack's arm, an overlap by idiom, not by touched lines. This is case (b) —
main broke something the stack's witnesses correctly pinned — not case (a).

## Fix

`src/codegen/expressions/call-builtin-static.ts`,
`emitBuiltinGetPrototypeOfFallback`'s `$__IterRec`-aware branch: the
non-`$__IterRec` (`else`) arm now delegates to
`objectGetPrototypeOf.tryEmitDynamicCallableGetPrototypeOf` via the project's
sanctioned `pushBody`/`popBody` swap (`src/codegen/context/bodies.ts`) — that
helper mutates `fctx.body` directly rather than returning an `Instr[]`, so it
cannot be spliced into a literal `then:`/`else:` array without the swap. On
decline (off the standalone/wasi lane) it falls back to the generic
`__getPrototypeOf` call exactly as before, re-reading the funcIdx fresh from
`ctx.funcMap` since the delegated call may have registered/shifted late
imports. The `$__IterRec`-arm's own `iterProtoIdx` is likewise re-read fresh
AFTER the delegated call, for the same reason.

Verified with a minimal standalone repro (`.tmp/s42/repro.mts`,
`repro3.mts`): both the linked-provider class-object/function-value cases and
the local (non-linked) `any`-indirection class case now answer `true`
matching #6609/#6625's spec.

**Post-fix witness run**: `npx vitest run --maxWorkers=2 tests/issue-66*.test.ts`
— **30 files / 150 tests, all green.**

## New failure the fix (correctly) exposed — NOT a stack regression

`tests/issue-6484-iterator-prototypes.test.ts`'s
`"%IteratorPrototype% is the shared parent, with an own [Symbol.iterator]"`
case newly fails on the merged+fixed tree. Root-caused and **proven
independent of both the merge and this fix**: reduced to
`Function.prototype` read + a later, completely unrelated `.call()` in the
same module, reproduced on the UNMODIFIED, pre-merge `b84898a96c` tree itself
(ran directly in the S41b worktree, `/home/user/js2/.claude/worktrees/agent-a638779a2bbb09264`,
read-only, no commits). This is a pre-existing, dormant defect in
`ensureObjectRuntime`'s `fctx=null` bootstrap (see the module's OWN
docstring in `resolved-callee-guard.ts`, which already documents the
staleness risk) that #6609/#6625's #6629-restored reachability merely
exposes more often (`Function.prototype` now materialises in far more
modules). Filed as
[#6630](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6630-ensureobjectruntime-bootstrap-late-import-staleness)
with the full repro and root-cause chain; NOT fixed here — the real fix is an
architecture-level change to `ensureObjectRuntime`'s bootstrap-time index
tracking, out of scope for a merge-sync. One narrow mitigation attempt
(moving `buildResolvedCalleeGuard`'s two captured indices to a fresh lookup)
was tried and did NOT close it — see #6630 for why (the staleness is not
limited to those two constants; the whole bootstrap-time body is untracked).

## Gates run on the merged+fixed tree

- `npm run -s typecheck` — clean.
- `node scripts/check-loc-budget.mjs` (default, and with
  `LOC_GATE_BASE=$(git rev-parse origin/main)`) — OK, all growth covered by
  existing per-file grants already in the merged issue files (no new grant
  needed for this fix's own ~35-line delta in `call-builtin-static.ts`).
- `node scripts/check-func-budget.mjs` (default + `LOC_GATE_BASE`) — OK.
- `node scripts/check-coercion-sites.mjs` — OK.
- `npm run -s check:oracle-ratchet` — OK.
- `npm run -s check:dead-exports` — PASS (overall exit 0; one informational
  sub-check, `moved-runtime gate`, reports incomplete evidence for two
  unrelated dynamic-import sites, not a regression from this branch).
- `npm run -s check:issue-ids:against-main` — OK, no collision.
- `check:speculative-rollback`, `update-issues.mjs --check`, `lint`, `format`
  — **not run** (time-boxed out; no source outside the files listed above was
  touched, so risk is low, but this is a real gap — see Verdict).

## Re-baselined battery (criterion 5 of the task brief)

**Not run** — four-family/120-file battery, must-not-move A–D, E-unlinked/
E-linked, corpus byte diff, and `test:equivalence:gate` were time-boxed out
of this session given the depth required to root-cause and fix the #6484
regression above (which was not on the original task's radar — the task
brief anticipated `Object.getPrototypeOf` regressions in
`class-arm-tag-guard.ts`/`standalone-class-instance-proto.ts` per the 2026-09-13
prior-merge-attempt notes, not this iterator-branch short-circuit). This is
a real gap in this session's acceptance-criteria coverage, not a silent skip
— flagged explicitly in the handback for the tech lead / next agent to run
before opening the stacked PR.

## Files changed

- `src/codegen/expressions/call-builtin-static.ts` — the fix (delegate the
  `$__IterRec`-branch's non-`$__IterRec` arm to
  `tryEmitDynamicCallableGetPrototypeOf` via `pushBody`/`popBody`).
- `plan/issues/6630-ensureobjectruntime-bootstrap-late-import-staleness.md` —
  new follow-up issue for the pre-existing bootstrap staleness bug.
- `plan/issues/6629-standalone-temporal-stack-main-sync-2026-09-17.md` — this
  file.
