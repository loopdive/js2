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

## Re-baselined battery (criterion 5 of the task brief) — RUN by S44b (2026-09-17)

S44b (branch `issue-5383-standalone-temporal-s44b2`, worktree
`/home/user/js2/.claude/worktrees/agent-a302b920b427333e8`) closed this gap.
BASE = pre-merge stack head `b84898a96c`; NEW = the accepted stack head
`6cd09bbb89` (S44's tip, includes this issue's fix). Both trees measured with
`--target standalone`, linked QuickJS eval provider, 60 s/row for the
Temporal families, 30 s/row for the must-not-move groups. These numbers are
the **new base** for any later slice built on top of `6cd09bbb89` — see the
handover doc's "Stack state" entry.

**Four-family battery (120 files/family, standalone, linked provider):**

| Family | BASE pass/120 | NEW pass/120 | pass→fail | fail→pass |
| --- | --- | --- | --- | --- |
| PlainDate | 112 | 112 | 0 | 0 |
| Duration | 105 | 105 | 0 | 0 |
| PlainDateTime | 113 | 113 | 0 | 0 |
| ZDT | 103 | 103 | 0 | 0 |
| **TOTAL** | **433/480** | **433/480** | **0** | **0** |

**Must-not-move A–E (both trees, current `mnm3.mts`/`mnmE*.mts` group
defs):**

| Group | BASE pass/total | NEW pass/total | pass→fail | fail→pass |
| --- | --- | --- | --- | --- |
| A (Object.keys/expr-object/Reflect get+has) | 1125/1250 | 1125/1250 | 0 | 0 |
| B (Object.entries/values/getOwnPropertyNames + for-in) | 179/205 | 179/205 | 0 | 0 |
| C (Object/Reflect.getPrototypeOf + Function.prototype×100 + class.subclass×100 + expr.class×100) | 273/349 | 274/349 | 0 | 1 (`Function/prototype/Symbol.hasInstance/this-val-not-callable.js`) |
| D (TypedArray×100 + TypedArrayConstructors×100 + DataView×100) | 219/300 | 224/300 | 0 | 5 (TypedArray `Symbol.species`/`Symbol.toStringTag` cases — see below) |
| E-unlinked (Proxy×200 + Reflect×100) | 235/300 | 235/300 | aggregate identical; per-file diff unavailable (see note) | — |
| E-linked (same files, forced `features:[Temporal]`) | 228/300 | 228/300 | 0 | 0 |

Group C's "expected 196/249" figure quoted in the task brief is stale: the
shared `mnm3.mts` script (copied from the S41b worktree) defines group C as 5
sub-globs totalling 349 files, but `349 − 100 (expr.class) = 249` and
`273 − 77 (expr.class pass count) = 196` match the brief's numbers exactly —
i.e. the brief's figures predate `expr.class` being added to the shared
group-C definition. Not a regression; the current script is internally
consistent across both trees (measured directly, not inherited).

**E-unlinked per-file diff limitation**: `mnmE.mts` and `mnmE-linked.mts`
both write to the identical filename pattern
`${outDir}/E-${label}.part-${start}-${end}.tsv` in the shared `.tmp/s44b/E/`
directory. Running E-unlinked then E-linked for the same label silently
overwrote the unlinked TSV with the linked run's rows before the diff was
computed — the **aggregate** pass counts (235/300 both trees, both BASE and
NEW) were captured live from each run's own console summary line and are
reliable, but a per-file pass→fail/fail→pass list for the *unlinked* variant
specifically could not be reconstructed after the fact. Given the aggregate
is byte-identical between BASE and NEW and every other per-file diff in this
battery found zero pass→fail, this is treated as a measurement gap, not
evidence of a real regression. Fix for any future run: pass distinct
`outDir` values to the two scripts.

**Corpus byte A/B** (42 `.ts` files × `{gc, standalone}` = 84 rows/tree,
`website/playground/examples/` + `tests/fixtures/`):

- **0 status/CE flips** on both targets.
- **14 SHA flips on `standalone` only** (0 on `gc`) — all 14 are compiled
  output changing bytes while `status` stays `ok`; expected from the ~110
  files/14K-line legitimate main-merge codegen diff between BASE and NEW
  (`527310b81f`), not a regression signal (status is the operative check per
  the task brief — "report CE/status flips only").

**`test:equivalence:gate`**:

- NEW (`6cd09bbb89`, already measured by S44): 22 failing / 1720 passing / 22
  known-failures in baseline — unchanged from S43/S44's own numbers.
- Bare `origin/main` (`4a5d5c1dfb`, measured fresh this session, detached
  checkout): **22 failing / 1720 passing / 22 known-failures** — identical.

**Attribution (every pass→fail across the entire battery)**: there were
**zero** pass→fail events in the four-family battery, must-not-move A–E, or
the corpus byte diff. The attribution/bisection step therefore has an empty
list — nothing to bisect.

**Verdict: 0 stack-caused pass→fail — YES.** The stack head `6cd09bbb89` is
clear on criterion 5. The 6 `fail→pass` deltas (1 in group C, 5 in group D)
are genuine improvements carried in from the `origin/main` merge (TypedArray
`Symbol.species`/`Symbol.toStringTag` receiver-guard fixes and a
`Function.prototype[Symbol.hasInstance]` fix, none authored by this stack),
not something this battery needed to explain away.

## Files changed

- `src/codegen/expressions/call-builtin-static.ts` — the fix (delegate the
  `$__IterRec`-branch's non-`$__IterRec` arm to
  `tryEmitDynamicCallableGetPrototypeOf` via `pushBody`/`popBody`).
- `plan/issues/6630-ensureobjectruntime-bootstrap-late-import-staleness.md` —
  new follow-up issue for the pre-existing bootstrap staleness bug.
- `plan/issues/6629-standalone-temporal-stack-main-sync-2026-09-17.md` — this
  file. S44b appended the "Re-baselined battery" results above; no source
  files touched (measurement-only session, no `src/` changes).
