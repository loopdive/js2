---
id: 4217
title: "npm-compat refresh publishes fresh data the site never serves — the `[skip ci]` artifact commit cannot trigger its own Pages rebuild"
status: done
completed: 2026-08-08
assignee: ttraenkler/lead
created: 2026-08-08
updated: 2026-08-08
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: ci
language_feature: n/a
goal: dogfood
related: [3988, 4130, 4132, 4140]
origin: "2026-08-08 stakeholder question 'why is npm-compat.html not showing the new numbers' — the artifact on main was 26 minutes fresher than the last Pages deploy"
---

# #4217 — npm-compat refresh never redeploys the page that serves it

## Problem

`npm-compat-refresh.yml` auto-commits the regenerated artifacts to main with
`[skip ci]` (by design — #3988's trigger-loop guard). But `[skip ci]` also
suppresses `deploy-pages.yml`, and `npm-compat.html` loads
`./benchmarks/results/npm-compat.json` from the **deployed build**, not from
raw main. So every refresh lands data the site cannot show until the NEXT
unrelated merge to main happens to rebuild Pages.

Observed 2026-08-08: artifact published 05:56Z, last Pages deploy 05:34Z on
the previous data; the page stayed stale until a manual
`gh workflow run deploy-pages.yml` at 06:22Z. On a quiet main (weekend, queue
pause) the gap is unbounded; the 6h refresh cron makes it worse, not better —
each cron run refreshes the invisible data again without ever deploying it.

This is the display-layer sibling of #4130 ("refresh reported success and
committed nothing") — there the data never landed; here it lands and is never
served.

## Fix (this issue's PR)

In `npm-compat-refresh.yml`:

1. `id: promote` on the promote step; it now emits `published=1` only on a
   real artifact push (not on the "already current" early exit, not on a
   deferred refresh).
2. A follow-up step dispatches `deploy-pages.yml --ref main` when
   `published == '1'`. `workflow_dispatch` is one of the two event types the
   `GITHUB_TOKEN` may create runs for, so `actions: write` on the job is
   sufficient — no PAT.
3. Best-effort: a failed dispatch is a `::warning`, not a job failure — the
   data is already safely on main and the next merge redeploys.

## Permanent repro

`tests/issue-4217-refresh-redeploys-pages.test.ts` — workflow-shape pin: the
`actions: write` grant, the `id: promote` / `published=1` real-push marker, and
the guarded `deploy-pages.yml` dispatch step must all survive refactors.

## Acceptance

- [x] A refresh run that publishes artifacts triggers a `deploy-pages` run
      within the same workflow execution.
- [x] A refresh run that finds artifacts already current dispatches nothing.
- [x] A deferred refresh (queue gate) dispatches nothing.
