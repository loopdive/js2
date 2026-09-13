---
id: 6454
title: "A shard that collects ZERO tests reports only `did not reach afterAll`, and docs-only PRs keep `main` green while it happens"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
goal: correctness
---

## The incident is already fixed — this issue is the two things it exposed

Between roughly **03:28Z and 05:55Z on 2026-09-13** every `merge_group` run that
actually executed shards died in ~10–15 s with 102 empty shard results and

```
##[error]Test262 shard did not reach afterAll; refusing partial JSONL evidence
```

**Root cause, found and fixed by another lane while this issue was being
written** — `7871adcc79`, "restore the `test262` submodule gitlink that a lane
grounding commit replaced with a symlink": since `dfecafa7e9` (the S6 lane's
grounding commit, landed on main inside #5875) the tree carried `test262` as a
**symlink to `/home/user/js2/test262`**, a path that exists only on one dev box.
On a runner, `actions/checkout` registers no submodule, `TEST262_ROOT` resolves
to a dangling link, and `findTestFiles` throws `ENOENT` at collection.

So the outage itself needs nothing further. What it exposed does.

## Finding 1 — a zero-collection shard is indistinguishable from a crashed one

The only signal the run surfaced was `did not reach afterAll`, which is the
*downstream evidence guard* firing, not the cause. Nothing in 90 failing job logs
named the dangling `test262` path or the `ENOENT`. That is why the failure was
readable as a conformance regression: `auto-park` `hold`-labelled each affected
PR, and a bot park means "a real regression the PR-level checks could not catch",
which each owner is then required to diagnose from scratch.

The guard should distinguish **"the shard crashed"** from **"the shard found zero
test files"**, and the latter should print the corpus root it resolved and why it
was empty. A ten-second silent no-op that surfaces only as a downstream guard
tripping is the expensive part of this incident.

## Finding 2 — `main` looked green throughout, because docs-only PRs skip the matrix

The shard matrix is skipped for PRs that touch no test262-relevant paths, so
docs-only merges went green for **two and a half hours** while every
shard-executing group died. `main` being green was not evidence the gate was
working; it was evidence nothing had asked it to work.

**This is a live trap for a reader, and it caught me.** I took PR #5891's
`merge_group` passing at 05:45:22Z as proof the queue had recovered, and said so
on PR #5890. #5891 touches only `plan/` and `tests/dogfood/` — its matrix was
skipped, so its success said nothing at all. The real recovery was `7871adcc79`
at 05:55Z, ten minutes later. A green `merge_group` whose matrix was skipped
should not be readable as a green gate.

## Stranded parks

Three PRs carry an evidence-free bot `hold` from this window. The set is
identified by **when and by whom the label was applied**, never by the label:

| PR | `hold` applied | by |
| --- | --- | --- |
| #5889 | 05:12:21Z | `github-actions[bot]` |
| #5885 | 05:15:57Z | `github-actions[bot]` |
| #5890 | 05:22:56Z | `github-actions[bot]` (cleared — see that PR) |

18 open PRs carry a `hold` in total; the other 15 are manual holds from
`ttraenkler` (mostly 2026-09-09) or bot parks from earlier days. Sweeping by
label alone would silently re-admit work someone deliberately paused.

```bash
gh api repos/loopdive/js2/issues/<n>/events \
  --jq '[.[]|select(.event=="labeled" and .label.name=="hold")]|last'
```

## Acceptance criteria

1. A shard that resolves its corpus root to nothing fails with a message naming
   **that** — the resolved `TEST262_ROOT`, and that zero test files were found —
   rather than only the downstream `did not reach afterAll`.
2. A `merge_group` whose shard matrix was **skipped** is not reportable as a
   green test262 gate: someone asking "did the queue recover?" can tell the two
   apart without opening the run's file list.
3. #5885 and #5889 are re-admitted, checking each one's cited run against the
   signature above before clearing its label.
4. Consider a cheap guard against the underlying class: a committed `test262`
   path that is a symlink rather than a gitlink is never correct, and
   `git ls-files -s test262` gives that check in one line.

## Evidence

- The fix: `7871adcc79` (mode `120000 → 160000`, gitlink restored at `b363f29d3c`).
- A failing job log: <https://github.com/loopdive/js2/actions/runs/34739996390/job/103678140919>
- Same signature on an unrelated PR: <https://github.com/loopdive/js2/actions/runs/34739544544> (job 103676937051)
- Affected groups, per `7871adcc79`: #5875, #5882, #5871, #5885 ×2, #5889, #5890 ×2.
