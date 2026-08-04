# Handoff — ≤ES5 goal window, suspended 2026-08-04

**Goal (stakeholder, restated 2026-08-01):** 95.4 % test262 standalone pass rate
on ES5 + untagged, **ex-dynamic-code** (the 317 dynamic-code files are out of
scope, not failures). Position at suspend: goal scope **6,644 / 8,650 = 76.8 %**,
gap ≈ 1,608 passes. Overall standalone 30,982 / 43,505 (71.2 %).

## First pulls of the next window, in order

1. **#4147 repair — `runTest262File` links no `js2wasm:runtime-eval` provider.**
   Promoted from "filed" to **gating**: it makes local standalone measurement of
   the entire propertyHelper population blind (two lanes independently burned
   effort on it; positive controls 0/11 and 0/36). It blocks every #4098
   successor stage's local control. Acceptance criterion that matters: an
   unlinkable provider must return `skip`/`error`, **never** `fail`.
2. **#4098 G1 stages 2–4** (the 124-file prize). Stage 1 shipped (PR #4100).
   Read the **G1 STAGE 1 addendum** in the issue file first. The one line a
   successor must not miss: stages 3/4 must **filter `bag[k] === bag`** when
   adding the instance arm to `__carrier_bag_of`, or the tombstone marker
   enumerates as a real own property. Stage order is fixed by #4010's ordering
   law (visibility must never outrun deletability): 2 = `__extern_set`
   closed-struct write arm, 3 = gOPD, 4 = keys/for-in via
   `ctx.classDeclarationMap`.
3. **#4119 G4** — `Object.prototype.toString` arm (76 rows, 72 of them the ES5
   driver). See its `## Suspended Work` section for the exact resume point.
4. **#3661 G2** (writable/configurable *enforcement*, ~111 rows — re-measure
   first, counts predate the store work) and the **G5** small bundle
   (#4095 / #4131 residual / #4116).

## Landed this window

| PR | What | Measured |
| --- | --- | --- |
| #4090 | `typeof` on reified builtin constructors (#4120) | +16 standalone, 0 regressions |
| #4091 | #4010 **S3** visibility + the −684 root cause | +4/−0, 729/729 stratum control |
| #4092 | #4119 re-scope (docs) | — |
| #4096 | #4061 §8.10.5 descriptor-argument validation | 16/17, 0/182 regressions |
| #4098 (PR) | #4147 + #4148 filings (docs) | — |
| #4101 | #4151 filing (docs) | — |
| #4102 | **pre-commit fast lane** | see "Process" below |
| #4100 | #4098 **G1 stage 1** — real `delete` on class instances | 0/124 by design; 5 probe cells fixed, 12/12 controls |

**The −684 was never the query widening.** Root cause: `__extern_set` had no
builtin-fn arm, so writes to a builtin's non-writable `name`/`length` were
deposited invisibly in the closure bag; `propertyHelper.isWritable` writes
before `isConfigurable` deletes, so every `configurable: true` assertion failed.
Fixed at source (§10.1.9 no-op), not at the query. Six-line repro in #4010.

## Issues filed this window (all unclaimed, dispatchable)

- **#4143** — first `defineProperty` over an inherited property on a
  carrier-less receiver is a **silent no-op**; the missing TypeError is a
  symptom. 14 files. Routes to #4098's population.
- **#4146** — host-lane `Object.create` applier never installs *or* validates an
  accessor, plus the mirror standalone `defineProperty` gap. Acceptance requires
  **calling** the accessor, never "did not throw".
- **#4147** — the measurement-blindness bug above (P1, gating).
- **#4148** — 31-row host-lane bare-identifier builtin value read. Analysis
  lives in **#4120's** file, not #4119's.
- **#4151** — `claim-issue --allocate` unusable where `gh` is absent.
- Two more recorded in #4098's file but **not yet filed** (deliberately, to
  avoid burning reservations at stand-down): `k in o` false while
  `hasOwnProperty` true for a declared instance field under a dynamic key; and
  `C[k]` not reading a `static` field under a dynamic key.

## Substrate findings worth more than their slices

- The **#3468 carrier bag is keyed by `eqref` identity, not closure type** —
  `__closure_bag_lookup`/`_ensure` already work on a class instance unchanged.
  #4098 needs a *predicate and arms*, not a new side table.
- **`ctx.classDeclarationMap` IS the user-declared-vs-builtin struct predicate**
  that #4071 records as "does not exist yet" and whose deferred −5 revert is
  blocked on it; #4086 records `startsWith("__")` as unsafe for the same job.
- A real `FLAG_TOMBSTONE` bit is **undetectable** — `__obj_find`,
  `__obj_ordered` and `__obj_ordered_all` all skip it; hence the
  self-referential bag entry (`bag[k] === bag`).
- Descriptor-field reads use own-only `__desc_has_own` where
  ToPropertyDescriptor specifies proto-inclusive `[[Get]]` — that one mechanism
  explains two non-flip buckets (42 + 69 rows) and belongs to the store family.

## Process lessons banked

- **`--no-verify` is no longer sanctioned for commits** (PR #4102). The full
  pre-commit chain exceeded agent tool timeouts, so agents skipped *everything*
  including the 2-second prettier gate — that is how #4100 shipped an
  unformatted file. Use `SKIP_SLOW_PRECOMMIT=1 git commit …`.
- **`prettier --check` on a `.tmp/` path checks ZERO files and prints success.**
  `.tmp/` is prettierignored and is also the sanctioned scratch dir, so the trap
  is built into the patch-handoff workflow. Use `--ignore-path /dev/null`.
- **Agent harness worktrees seed from the FORK tip** (non-ancestor of
  upstream/main, ~16 unlanded files). Check
  `git merge-base --is-ancestor HEAD upstream/main` before any branch. Escape
  that works: `git checkout -b <branch> <verified-upstream-SHA>` inside your own
  worktree (the classifier permits it); patch-handoff to the lead also works.
- **`git push` can print "Everything up-to-date" while the server lacks your
  commit.** Verify with `ls-remote`; an explicit refspec push clears it.
- A **spurious bot park** looks like: shard dying at "Setup Node and pnpm
  (cached)" — an infra step, so the verdict never ran. The bot comment's own
  footer flags this case. Diagnose the cited run before touching any `hold`.
- **`UNSTABLE` from a pending `measure-and-gate` is UNFINISHED, not FAILED.**
  Two PRs read `UNSTABLE` purely because that non-required job (~15 min) was
  still in progress; both settled to CLEAN unaided. Re-running would have been
  wrong. Distinguish pending from failed before acting.
- **`auto-enqueue.yml` needed no help all window** — every PR that reached
  CLEAN (#4100, #4104, #4105, #4106) was picked up within a sweep or two; the
  shepherd used zero of its one-shot backstops. Reach for a manual enqueue only
  after the ~30-min cron has demonstrably passed the PR by.
- **`quality` fails fast**: the gates after the failing one are *skipped*, not
  passed. A first-round failure means later gates have never run on that PR —
  expect a possible second round (#4100's post-R-FUNC tail ran only on round 2).

## Open at suspend

- **PR #4100** (G1 stage 1) — reached CLEAN and **auto-enqueue took it: merge
  queue position 1, `merge_group` re-validation running** at stand-down.
  **First action next session: verify it merged by CONTENT on upstream/main**
  (`src/codegen/instance-tombstones.ts` present) — not by PR field. If it was
  parked instead, read the cited run before touching the `hold`.
- **PR #4109** (`issue-4119-ladder-build`, head `bf8dfeb5c`) — D-g4-build's
  `fix(#4119): runtime Object.prototype.toString classifier for standalone
  (arm 1)`. Opened one minute before stand-down, `BEHIND`, full CI just
  started. **Nothing diagnosed — it needs a fresh watch next session.**
- **#4098 and #4119 claims remain HELD** (`ttraenkler/dev-4098-g1`,
  `ttraenkler/dev-4119-g4`) so the work is marked as resumable, not abandoned.
  Release or re-claim deliberately.
- Other lanes' PRs left untouched: #4104, #4105 (both queued), #4106, #4107
  (checks pending), #4079 (DIRTY + pre-existing hold).
