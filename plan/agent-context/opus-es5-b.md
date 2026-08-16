# Context summary — ttraenkler/opus-es5-b (2026-08-16)

Standing developer on the ES5-standalone gap. Model: Opus 5. Worktree:
`/workspace/.claude/worktrees/agent-ac56a86dbbedc1266`.

## Outcome

| | |
| --- | --- |
| PRs opened | #4629 (merged, then reverted forward by #4634), **#4635 (open, #4524)** |
| Issues claimed | #1888 (claimed → slice S8 → released), **#4524 (allocated + claimed, mine)** |
| Net measured effect | **+6 ES5-bucket test262 rows**, 0 regressions (from #4635) |

## What landed / is landing

**#4635 — #4524, open.** Two silent-wrong-answer defects in the standalone
object-shape escape pass (`src/codegen/declarations/object-shape-widening.ts`):

1. An **out-of-shape data descriptor define** on a closed-struct object literal
   was silently dropped — no trap, no diagnostic. Accessor defines and plain
   dynamic writes were already covered; the data define was the one hole, and
   the one real test262 code hits (the corpus is unannotated JavaScript, so its
   objects always take the closed-struct path).
2. **A read changed the representation.** `Object.prototype.hasOwnProperty
   .call(o, …)` anywhere in the module un-poisoned the escape and reverted the
   receiver to a closed struct, restoring defect 1. The consumer-safety guard's
   `isObjectMopCallArg` matched only the direct `Object.<mop>(o, …)` form; the
   borrowed idiom's callee is a property access whose base is another property
   access. Fixed with `isBorrowedMethodThisArg`, keyed on the type fact that
   `Function.prototype.call` declares `thisArg: any` — not on a builtin
   allow-list. Plain `f.call(o)` on a *user* function is deliberately excluded.

Measured: 38-file scoped set, standalone lane, real runner — **6 flips, 0
regressions, 13 unmeasurable (load compile-timeout), denominator 25 of 38.** All
6 flips classify edition 5.

**#4629 — #1888 slice S8, reverted.** The `Array.isArray` compile-time fast path
claimed every ref is an Array. The fix was correct in its directory (23/29 →
27/29) but the narrowed predicate answered FALSE for real arrays from two
carriers it did not enumerate; net +4/−42 per lane, caught in `merge_group`.
**Full re-land recipe, root cause, and required validation are written into
`plan/issues/1888-openany-dispatch.md` under "Slice S8".** The one-line version:
derive the static predicate from `collectStandaloneArrayCarrierTypeIdxs`'s own
three-source set so the two cannot diverge by construction.

## Findings a successor should not have to rediscover

**The briefing's error-class routing was wrong, measurably.** `'X.prototype.Y'
is not yet callable as a value` covers **0** of the census's 117
function-prototype + array-prototype ES5 rows, and `__get_builtin` covers 9.
Corpus-wide the two are real (133 and 115 rows) but live outside edition 5 —
the 133 classify `2015/2016/2019/2020/2022/2023/untagged`, **zero** edition 5.
Check the edition split of a candidate error class before planning around it.

**Instrument traps, all three hit in one session:**

- **An `: any` annotation on a probe receiver selects a different object
  lowering.** Three probes reported "spec-correct" against genuinely failing
  tests because they annotated the receiver to make it compile. A probe that
  does this has stopped testing the program under test. This is the single most
  expensive mistake I made.
- **The QuickJS eval provider cannot be built in this container** (no
  clang-18/cmake, no prebuilt artifact anywhere on the box). The runner fails
  loudly with "provider is not built", so eval-shaped rows are identifiable —
  exclude them, never count them as failures.
- **On a loaded box (this one ran at 17–26 on 8 cores all session) vitest hits
  its 35 s per-test timeout and test262 compiles hit theirs at 31–120 s.** Both
  present as failures. Every apparent failure must be re-verified solo, and a
  timeout is an *absence* of measurement, not a result. I discarded two whole
  measurement arms this way and both discards were correct.

**A fix can measure as zero because another defect disables it.** Defect 1
alone measured 0 flips across 38 files; with defect 2 also fixed, the same set
gave 6. If a well-understood fix moves nothing, suspect the harness path before
concluding the fix is worthless.

**Stale claims in `plan/issues/1888-openany-dispatch.md`, now corrected there:**
accessor descriptors (Slice 5) DO work end-to-end in standalone — the "not
reached end-to-end" comment was stale. Also `built-ins/Array/prototype/forEach/
15.4.4.18-4-2.js` passes on current main while the baseline still lists it as a
host-import leak.

## State on exit

- `#4524` claimed by me on `upstream/issue-assignments`; issue file `in-progress`
  with the full measurement recorded. **PR #4635 open, CI in flight.** If it
  needs attention: it was `BEHIND` at last check (main moves fast today) — merge
  main and push; do not enqueue.
- `#1888` claim **released**. The issue stays open with slice S8's re-land
  recipe. Remaining planned slices (3, 4, 6, 7) are untouched and still valid.
- Nothing suspended; no WIP outside the two branches, both pushed to `fork`.

## What I would do next

1. Re-land the isArray fix per the #1888 S8 recipe — the defect is real and the
   fix shape is now known, it just needs the carrier enumeration and a
   full-corpus both-lane validation.
2. The ES5 array-prototype cluster's remaining `every`/`forEach` group (8 files,
   "expected a TypeError, none thrown") — all use an accessor `length` getter on
   a plain object, and #4524 may already have moved some of them; re-measure
   before planning.
3. The `built-ins/Object` defineProperty-family cluster (86 files, a **ceiling**
   not an estimate) — my 25-file sample produced 0 flips with 10 rows
   unmeasured, so it needs its own root-cause pass, not an assumption that
   #4524 covers it.
