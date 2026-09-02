---
id: 5275
title: "merge queue: a failed group's merge commit reaches main through the next skipped-shard group"
status: ready
sprint: current
created: 2026-09-02
priority: critical
horizon: m
feasibility: medium
task_type: infrastructure
area: tooling
language_feature: n/a
goal: ci-infrastructure
requested_by: claude/fable-ir-takeover
related: [2547, 3597, 2522, 3467, 5224, 5474]
---

# #5275 — a failed merge group's commit reaches `main` through the next skipped-shard group

## Problem

Twice on 2026-09-02 a PR whose own merge group **failed** `check for test262
regressions` — and which `auto-park` (#2547) correctly labelled `hold` —
nevertheless landed on `main`, carrying its regressions:

| parked PR | its group (failed) | the group that landed it | landed at |
| --- | --- | --- | --- |
| #5224 (ES2015 buffers) | run 33593621223, failed 05:32:22 UTC — 2 Atomics pass→fail, `illegal_cast` 28→35 | #5459 `chore(ci): refresh npm-compat artifacts`, head `gh-readonly-queue/main/pr-5459-5dd7a92169…` (its base IS #5224's merge commit `5dd7a92169`), run 33595116406, 05:32:56→05:34:04, shards skipped | 05:34:20 |
| #5474 (#3523 gap-6a) | run 33619016636, failed 10:42:26 — 76 pass→other, net −71, `oob` 14→29, `null_deref` 70→74 | #5475 `docs(#5270, #5271)`, head `gh-readonly-queue/main/pr-5475-48724f80f6…` (its base IS #5474's merge commit `48724f80f6`), run 33620860207, 10:42:38→10:43:47, shards skipped | 10:51 |
| #5472 (#3526 F2-S7; parked on #5474's collateral, not its own regression) | run 33621580290, failed 11:29:14 — the identical 76 rows, signature `742f2e587506a8a1` | #5477 (the revert of #5474), head `gh-readonly-queue/main/pr-5477-31f36c267b7b…` (its base IS #5472's merge commit `31f36c267b7b`), run 33624852723, full matrix green because the revert restores the floor | 11:51 |
| #5479 (#5194 ES2015 TypedArray r2) | run 33626922676, failed 12:15:14 — 1 host-lane row pass→fail (`language/statements/class/subclass/class-definition-null-proto-super.js`, `Maximum call stack size exceeded`); auto-parked 12:15:36 | #5478 `docs(#5275)` — this issue's own filing PR, released from a manual `hold` at 12:14 when the queue read empty; #5479 was enqueued in the same minute — head `gh-readonly-queue/main/pr-5478-0d1582f5dd…` (its base IS #5479's merge commit `0d1582f5dd`), run 33628910455, 12:15:19→12:16:23, shards skipped | 12:25 |

The third row is the same mechanism with a benign payload (F2-S7 is byte-neutral and its park was collateral), which is the point: whether the carried commit is harmful is luck, not policy.

The mechanism, from the queue's own run history: the merge queue builds
groups speculatively (`max_entries_to_build > 1`, #2522), so group N+1's merge
commit chain is built **on top of group N's merge commit**. Group N runs the
full ~20-minute shard matrix; group N+1 — an npm-compat refresh or a
docs-only PR — hits the `paths`-based "shards intentionally skipped" branch
of `test262-sharded.yml` and is green in about a minute. When group N's
verdict arrives, `auto-park` labels PR N and the queue removes it, but the
already-green group N+1 is merged as-is, and its history contains N's merge
commit. Every gate that exists to keep a regression off `main` — the #3467
per-SHA regression diff, the #3189 trap ratchet, `auto-park` — fired
correctly; the landing happened on a path none of them guards.

Both incidents cost the same afternoon: `main` carried the regressions, the
push-event `promote-baseline` refused on trap growth (#3189), and every
subsequent full-test262 group parked on the stale floor until a fix (#5469)
or a revert (#5477) landed. The revert of #5474 is `git revert -m 1
48724f80f6` (PR #5477); #5224 was fixed forward by #5469.

## Why the skip is the hole

The shard-skip decision (`detect test262-relevant changes` in
`test262-sharded.yml`) looks at the **PR's own diff**. In a merge group that
is the wrong question: the group's merged tree also contains every
predecessor in the queue, and if any predecessor is untested or failed, the
group's "no test262-relevant change" verdict is about a tree that was never
measured. A docs-only PR is only safe to skip when its group's base is a
`main` tip whose shards have passed.

## Acceptance criteria

1. A merge group whose base is **not** the current `main` tip (i.e. it stacks
   on another queued group) either runs the full shard matrix or waits for
   its predecessor's verdict before its required checks can go green — a
   docs-only or artifact-only PR can no longer be the vehicle that lands a
   failed predecessor. Measured on the queue: re-run the #5474/#5475 shape
   (a failing code PR followed by a docs PR) on a scratch base or a replay
   and show the docs group does not merge with the failed commit.
2. Until (1) lands, the queue's `max_entries_to_build` is set to **1** by an
   admin (re-raise only with (1) in place); record the setting change and its
   date here. #2522 documented the raise as a throughput lever — this issue
   is the cost side.
3. `auto-park` (#2547/#3597) posts, on the PR it parks, whether a later group
   already carried the parked commit onto `main` (compare the parked merge
   commit against `main`'s ancestry at park time), so the lead sees "already
   on main — revert needed" instead of discovering it from a merge notice.
4. `docs/ci-policy.md` gains the rule and the two incident records above.

## Notes for the implementer (Lane A — CI/infra)

- The group's base sha is `github.event.merge_group.base_sha`; the shard-skip
  job can compare it with the `main` tip and the per-SHA cache
  (`test262-group-<sha>` artifacts, #3467) to decide "predecessor measured
  and green".
- The fast path for docs-only PRs whose base IS a measured green `main` tip
  must stay — that is the whole point of #2519.
- `scripts/enqueue-green-prs.mjs` is not involved; the enqueue side is sound.
