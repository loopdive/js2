---
id: 3889
title: "A green PR sits unenqueued for up to 30 min when a NON-required workflow finishes last — auto-enqueue's trigger allowlist misses it"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: n/a
goal: n/a
sprint: current
horizon: s
es_edition: n/a
related: [3878, 2786, 1758]
---

# #3889 — a green PR can sit unenqueued because nothing triggered the sweep

## Lead with the real cost: this looks EXACTLY like a broken enqueue path

The delay itself is bounded — the ~30-minute cron recovers it, so unlike #3878
(a permanently red check, never recovered) nothing is stranded forever.

**But the user-visible symptom is identical**: a PR that is green, `CLEAN`,
unlabelled, not a draft, and simply not in the queue. That is precisely how
someone concludes *"the enqueue path is broken"* or *"#3878 didn't work"* and
starts hand-enqueuing again — which is the behaviour #2786 was built to end. The
confusion is more expensive than the wait.

## Mechanism

`auto-enqueue.yml` fires responsively via `workflow_run` on an **allowlist of
workflow names**:

```yaml
workflow_run:
  workflows: ["Test262 Sharded", "CI"]
  types: [completed]
```

Those two cover every **required** check. But `mergeStateStatus` is computed
from **all** checks, required or not. `measure-and-gate` lives in
**`Refresh Benchmarks`** (`.github/workflows/benchmark-refresh.yml`), which is
not in the list.

So when the benchmark workflow is the **last to finish**:

1. `CI` / `Test262 Sharded` complete → `auto-enqueue` fires → PR is `UNSTABLE`
   (benchmarks still running) → **correctly skipped**, since `ENQUEUEABLE` is
   `{CLEAN, HAS_HOOKS}`.
2. `Refresh Benchmarks` completes → PR flips **`UNSTABLE` → `CLEAN`** → **no
   `workflow_run` trigger fires**, because that workflow isn't in the allowlist.
3. The PR sits `CLEAN` and unenqueued until the ~30-minute cron.

## Measured, 2026-07-31 (PR #3882)

| time (UTC) | event |
| --- | --- |
| 08:43:55 | `Refresh Benchmarks` starts |
| 08:50:21 | `auto-enqueue` runs (triggered by `CI`/`Test262 Sharded`) — PR is `UNSTABLE`, correctly skipped |
| **09:00:41** | `Refresh Benchmarks` completes → PR becomes **`CLEAN`** |
| 09:00–09:16+ | **no `auto-enqueue` run at all**; last remains 08:50:21. PR sits `CLEAN`, queue empty |

## Why three sibling PRs looked instant and this one didn't

#3876, #3879 and #3880 were each picked up within ~2 minutes of `CLEAN`. Their
benchmark gate happened to finish **before** the required workflows, so the
**last** completion was a trigger workflow. The difference is **ordering**, not
flakiness — which is what makes this a diagnosis rather than "sometimes it's
slow".

## Fix — NARROW, deliberately

Add `Refresh Benchmarks` to the allowlist:

```yaml
workflows: ["Test262 Sharded", "CI", "Refresh Benchmarks"]
```

### Why NOT the general fix (and why that's a deferral, not a rejection)

The correct general fix is to trigger on **any** workflow completion and let the
script's existing `CLEAN`/`HAS_HOOKS` guard do the filtering — it already
refuses everything else, so no script change would be needed.

**Deferred on Actions-quota grounds only.** An any-completion trigger invokes
this workflow once per workflow per push. The repository currently carries a
large accumulated-artifact/quota problem, and burning additional Actions minutes
while the account is already strained is the wrong trade today.

### Known flaw in the narrow fix — record it, don't discover it later

> An allowlist that must be maintained **in lockstep** with the set of
> workflows whose checks influence `mergeStateStatus` is a **maintenance trap**.
> It breaks **silently** the next time a workflow adds a check — the same
> symptom, a new cause, and no signal anywhere.

Revisit the general fix once quota is healthy. The narrow fix buys correctness
today at the cost of a latent trap; that trade is deliberate and should not be
inherited as if it were a design.

## Acceptance criteria

- [ ] A PR whose **last-finishing** check belongs to a non-required workflow is
      enqueued responsively (within ~one workflow-startup of reaching `CLEAN`),
      not on the 30-minute cron.
- [ ] Reproduce by ensuring `Refresh Benchmarks` outlasts `CI` and
      `Test262 Sharded` on a PR, then confirming an `auto-enqueue` run exists
      with a `created_at` **after** the benchmark workflow's completion.
- [ ] The maintenance-trap note above survives in the workflow comment, so the
      next person hitting a new instance recognises the class.

## Notes

Found 2026-07-31 while verifying #3878's acceptance — #3882 (the follow-up PR
recording #3878's own findings) exhibited it. Distinct from #3878: that was a
permanently failing check driving `UNSTABLE`; this is a missing **trigger** on a
PR that is already green. Same symptom, different cause, different severity.
