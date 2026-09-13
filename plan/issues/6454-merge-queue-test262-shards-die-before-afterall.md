---
id: 6454
title: "A ~15-minute merge_group outage parked 3 PRs on evidence-free `hold`s — shards died before `afterAll`"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
goal: correctness
---

## Problem

Between roughly **05:08Z and 05:22Z on 2026-09-13**, every `merge_group`
re-validation failed `Test262 Sharded`, so `auto-park` `hold`-labelled each PR
in turn. The outage itself was transient — PR #5891's group passed at **05:45Z**
— but the `hold`s it left behind are not: `auto-enqueue` skips a held PR, so
each one strands until a human clears it.

**Exactly three PRs were parked by this outage**, and it is worth being precise
about that number. 18 open PRs currently carry a `hold`, which is the figure a
label query returns — but checking *when and by whom* each label was applied
(`gh api repos/loopdive/js2/issues/<n>/events`) shows only three were added by
`github-actions[bot]` inside the window. The other 15 are manual holds from
`ttraenkler` or bot parks from earlier days, and sweeping them as collateral of
this incident would silently re-admit work someone deliberately paused.

| PR | `hold` applied | by |
| --- | --- | --- |
| #5889 | 05:12:21Z | `github-actions[bot]` |
| #5885 | 05:15:57Z | `github-actions[bot]` |
| #5890 | 05:22:56Z | `github-actions[bot]` |

Observed on those three consecutive, unrelated PRs:

| PR | merge_group run | `Test262 Sharded` |
| --- | --- | --- |
| #5885 | 34739…544 (05:11Z), 05:15Z | failure |
| #5889 | 34739544544 (05:08Z) | failure |
| #5890 | 34739996390 (05:19Z), 05:22Z | failure |

**90 of 100 jobs fail, all with the same two lines:**

```
##[error]Test262 shard did not reach afterAll; refusing partial JSONL evidence
##[error]Process completed with exit code 2.
```

The shape says infra, not conformance:

- The vitest invocation lasts **~10 seconds** (05:21:11.85 → 05:21:21.61 on
  `test262 standalone shard 1/50`). A real shard is minutes.
- The **blob report is written** and vitest's exit code is accepted by the
  wrapper — so vitest ran and returned cleanly; it simply produced no
  `…​.shard-*.complete.json` completion marker, which is what the guard checks.
- Everything upstream of it is healthy in the log: the compiler and runtime
  bundles build (`18.0mb` / `17.8mb`, ~400 ms each), and the Temporal provider
  artifact downloads with a matching SHA256.
- Both the **js-host** and the **standalone** matrices fail, which rules out
  anything target-specific.

So the guard is doing its job — refusing partial evidence — and **no test262
verdict was ever produced.** Every `hold` it produced today is therefore
evidence-free: the park comments' own footer names exactly this case ("If it is
a setup/infra step rather than a verdict step, the verdict never ran and this
park may be spurious").

## Why this matters more than a normal red gate

A `hold` from `github-actions[bot]` is *supposed* to mean "a real regression the
PR-level checks could not catch", and the handling rules say never to remove one
without diagnosing it. That contract is what makes even three of these
expensive: each costs a full diagnosis to clear, and each reaches the same
conclusion — that no verdict was ever produced. A park carrying no evidence
devalues the parks that do.

It also makes the queue's held set harder to read. "18 PRs are held" invites
exactly the wrong inference; the actionable set here is three, and telling them
apart needs the label's *event history*, not the label.

## Acceptance criteria

1. Explain what made `tests/test262-chunk-dynamic.test.ts` return in ~10 s
   without reaching `afterAll` during that window, and why it stopped by 05:45Z
   on its own. A self-healing failure points at infrastructure (a runner image,
   an artifact/cache service, a rate limit) rather than at a commit — so check
   that before bisecting main.
2. The shard either runs to completion or fails with a message that says *why*
   collection produced nothing — a ten-second silent no-op that trips a
   downstream evidence guard is the expensive part of this incident.
3. #5885, #5889 and #5890 are re-admitted — the queue is already green again.
   Identify the set by **when the bot applied the label**, not by the label:
   `gh api repos/loopdive/js2/issues/<n>/events --jq '[.[]|select(.event=="labeled" and .label.name=="hold")]|last'`.
   The other 15 held PRs are manual or older parks and must be left alone.
4. Consider whether the completion-marker guard should distinguish "shard
   crashed" from "shard collected zero tests" — they need different responses,
   and today they produce the same message.

## Evidence

- Failing job log: <https://github.com/loopdive/js2/actions/runs/34739996390/job/103678140919>
- Same signature on an unrelated PR: <https://github.com/loopdive/js2/actions/runs/34739544544> (job 103676937051)
- The recovery, same query: `pr-5891-…` is `success` at 05:45:22Z.
- Enumerate the window:
  `gh api 'repos/loopdive/js2/actions/runs?event=merge_group&per_page=20' --jq '.workflow_runs[] | "\(.created_at) \(.conclusion) \(.name) \(.head_branch)"'`
