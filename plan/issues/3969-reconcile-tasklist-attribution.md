---
id: 3969
title: "reconcile-tasklist scored 0 true positives — read a stale local tree, and read any #N in a merged PR title as proof of closure"
status: done
sprint: 78
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: tooling
goal: maintainability
created: 2026-08-01
completed: 2026-08-01
assignee: ttraenkler/dev-budget-pick
---

# #3969 — `reconcile-tasklist.mjs` manufactured its findings

## Problem

A full audit of one 26-row run found **0 true positives**: 13 rows phantom, 13
real-but-misattributed. A tool with that rate trains everyone to ignore it,
which is worse than not having it.

Two **independent** causes — proven independent below by kill-switch attribution
(each half, reverted alone, fails a disjoint set of tests).

### Defect A — it read the LOCAL checkout

`ISSUES_DIR` came from `process.cwd()`. Agents work in worktrees, so the shared
checkout never advances on its own and rots behind `main`: measured at local
`5824539805` vs remote `b0a4047c`, which made **13 issues already `done` on
main** report as still open.

The failure is invisible by construction — a stale tree yields a confident,
well-formatted, wrong report.

### Defect B — any `#N` in a merged PR title counted as proof `#N` is done

Four distinct bugs rode on that single assumption:

1. **Slice PR read as closing its epic.** #2949 has **17 merged PRs and is open
   by design**.
2. **Incidental mention.** #3715 and #3746 were both attributed to the *same* PR
   #3729, which is the subject of neither.
3. **Filed-by counted as fixed-by.** #3775 was cited only by the PR that
   **discovered** it.
4. **Docs/diagnosis PR counted as a fix.** Three PRs **correcting** #3756's
   root-cause claim read as three fixes.

## Fix

### Defect A — read a verified-current tree, or refuse

Currency is established first (`ls-remote` is sub-second even where a fetch is
not), then issue files are read out of **that exact commit** via one `ls-tree` +
one batched `cat-file` (3,413 files; a subprocess per file would take minutes).
If `origin/main` is behind, a targeted single-branch fetch catches up; if
currency cannot be established at all, the tool **refuses** to present its
merged-PR verdicts as reliable and says so in every output shape — including the
`--quiet` hook line, which gains a leading `STALE-TREE (…) — counts unreliable`.
`--allow-stale-tree` is the explicit, recorded opt-out.

The fetch uses a **private ref**, not `FETCH_HEAD`: many agents share one object
store, so a concurrent fetch can clobber `FETCH_HEAD` between write and read.

### Defect B — claim vs mention, epic detection, acceptance criteria

- **Claimed, not mentioned.** Only an id in a PR's conventional-commit **scope**
  (`fix(#3934):`, `fix(#3909, #3910):`) or a trailing `(#N)` whose parentheses
  contain nothing else counts as a claim. That single rule kills bugs 2, 3 and 4
  — all three are mentions sitting in the summary rather than the subject. It
  also rejects `(unblocks #N)`, because the parens hold more than the ref.
  - The trailing `(#N)` form **is** a real issue reference here, not the
    PR-number/issue-id sequence collision: measured across 200 merged PRs,
    **18 of 19** trailing refs differ from the PR's own number. (I had assumed
    the opposite and checked before building on it.)
- **Epic detection.** An issue claimed by **more than one** merged PR is the
  slice-of-epic shape and is reported **unknown** — one slice landing says
  nothing about the epic being closed.
- **Acceptance criteria.** Three-way, never two-way:
  - any unchecked box ⇒ **rejected** (demonstrably not done);
  - boxes present and all checked ⇒ **done**;
  - **no boxes at all** ⇒ **unknown** — the signal is *absent*, not negative.
    This is the coordinator's "necessary but not sufficient" case, and 11 of the
    live candidates land here.

### The design rule

When the tool cannot tell slice-of-epic from closure, it reports **unknown**,
never **done**. Merely suppressing noisy rows would be the same bug with a
smaller symptom — a quieter tool that still guesses. `unknown` is therefore a
reported bucket with a per-row reason, not a rounding bucket.

Mention-only rows are also **counted** (`+ N open issue(s) were MENTIONED … but
never claimed`) so the mentioned-vs-claimed gap — where the old tool invented
most of its false rows — is visible rather than silently absorbed.

## Test Results

`tests/issue-3969.test.ts` — 12 hermetic tests (two local bare repos + a stubbed
`gh` on `PATH`; no network). All green. `tests/issue-3965.test.ts` still green:
29 tests across both suites.

**Positive control** — a genuinely-done issue is still reported: an issue with
all acceptance boxes checked, claimed by exactly one merged PR in its scope,
appears in the `DONE` bucket with `all 3 acceptance criteria checked`. Without
this, every other assertion here is satisfiable by a tool that reports nothing.

**Kill-switch attribution** — each half reverted alone, failing **disjoint**
tests, which is what makes them separate defects rather than one:

| kill switch                                  | tests failed | which                                                    |
| -------------------------------------------- | ------------ | -------------------------------------------------------- |
| A — tree source disabled (read the worktree) | **1 of 12**  | `reads issue status from remote main`                    |
| B — scope-vs-mention disabled                | **4 of 12**  | bugs 2, 3, 4 and `(unblocks #N)`                         |
| C — acceptance-checkbox gate disabled        | **2 of 12**  | the reject/unknown split, and the three-way split report |
| all restored                                 | 12 / 12 pass | —                                                        |

**A bug the tests caught in this very fix**, worth recording because it is the
same family the fix is about: `execFileSync` rejects `encoding: "buffer"` with
`Unknown encoding: buffer`, so the batched `cat-file` threw on **every** call,
the `catch` turned that into a silent worktree fallback, and the report still
said `verified: true` — Defect A fully restored, invisibly. Making the fallback
**loud** surfaced the cause in one run. The fallback is now recorded in
`issue_source.note` and flips `verified` to false.

**Live effect** (verified tree @ `4fe0c008`, 3,413 issue files):

| run                       | rows                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| before                    | 24 flagged "fixed by merged PR", 0 true positives                          |
| after                     | 15 claimed → **1 done, 7 unknown, 7 rejected**                             |
| also reported             | + 5 mention-only, deliberately not flagged (counted, not hidden)           |
| Defect A alone accounts for | 4 rows that were open in the stale worktree and `done` on main            |

## Related fix carried in this PR

`docs/ci-policy.md` gains a short section on watching a PR's checks: **`pending
== 0` is not "settled"** when the required jobs have not been created yet — an
empty pending list means "nothing pending *that exists*". Observed live on PR
#3950, where a watcher declared CI settled about a minute after the push on a
rollup holding none of the required jobs. Two floors are required: floor the
required-check count by name, and pin the head sha (the API lags a push, so the
rollup can describe the previous head, whose checks may be complete and green).

## Known limitation, demonstrated live by this very issue

**Every signal here derives from the PR TITLE, and a title is mutable metadata.**
It can be edited after the merge, at which point it no longer describes what
landed.

This is not hypothetical. While fixing #3969 I misread PR #3950's frozen
`updated_at` as a dropped `synchronize` webhook when it was in fact the **merge
timestamp** — a merged PR's `head.sha` stops tracking the branch, which is why
four subsequent pushes never moved it. Acting on that wrong cause, I retitled
the **already-merged** PR to `fix(#3965, #3969): …` (title PATCH 09:24:09Z; merge
08:20:54Z, merge commit `6aa63eb4`). `main` then carried a merged PR claiming
#3969 in **scope position** whose merge commit contained none of that work — and
this tool would have reported #3969 **done**. The fix's own headline case,
reproduced by the fix's own PR.

The checkbox gate does not rescue it: #3969's acceptance boxes were written
checked, so the row would have passed every gate in this design.

The title has been restored to `fix(#3965): …` and the exposure is pinned by
`KNOWN LIMITATION: a title edited after merge still drives the verdict` in
`tests/issue-3969.test.ts`, which asserts the *current* (wrong-in-this-case)
verdict so that a future content-evidence cross-check has an obvious place to
flip.

Also worth recording, because it is the same lesson as the `encoding: "buffer"`
find: my full-length-sha check correctly ruled out the truncated-`head_sha`
trap, but I only tested against **that** alternative. Ruling out one cause is not
establishing another — the `state`/`merged_at` fields were one query away and
would have given the true cause immediately.

## Follow-ups (not in this PR)

- **Content evidence over title evidence.** The durable fix for the limitation
  above is to ask whether a merged PR's commit actually touches
  `plan/issues/<id>-…` (a closing PR nearly always sets `status: done` there).
  That is content, not mutable metadata, and it would have rejected the
  retitled #3950 outright. Not done here because `gh pr list` cannot return
  changed files, so it needs one API call per PR over a 200-PR window — a real
  cost that deserves its own measurement.
- **A merged PR's `head.sha` is frozen at merge.** Any watcher that pins an
  expected head sha will therefore poll forever against a merged PR. Watchers
  should check `state`/`merged` first and exit on `MERGED`; mine did not, and
  ran to exhaustion.

- The `unknown` bucket is dominated by "no acceptance checkboxes" (7 of 15).
  Issues without acceptance criteria cannot be adjudicated by any tool; the
  durable fix is upstream, in how issues are written.
- One live candidate had zero unchecked boxes and still was not done, because
  its criteria were headed "Slice 1" and one of them required an external matrix
  to still name it as live owner. Section-aware checkbox parsing would catch
  that class; whole-file counting cannot.
- `pre-dispatch-gate.mjs` reads the claim ref from the cached remote-tracking
  ref (carried over from #3965's follow-ups) and has the same stale-read shape
  as Defect A here.

## Acceptance criteria

- [x] issue status read from remote `main`, not the local checkout
- [x] a tree that cannot be verified current is refused loudly, in every output shape
- [x] a `#N` mention no longer counts as a closure claim
- [x] an issue claimed by multiple merged PRs reports `unknown`, not `done`
- [x] acceptance checkboxes gate the `done` verdict, three-way
- [x] mention-only rows are counted, not silently dropped
- [x] positive control: a genuinely-done issue is still reported
- [x] kill-switch attribution: each half fails a disjoint test set
