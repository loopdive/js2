---
id: 3597
title: "auto-park bot is step-blind — infra failures park PRs indistinguishably from real regressions"
status: done
completed: 2026-07-25
sprint: 77
priority: high
horizon: s
goal: ci-infrastructure
feasibility: medium
created: 2026-07-25
assignee: ttraenkler/dev-guard-tests
---

# #3597 — give the auto-park bot step awareness

## Problem

On **2026-07-24** the merge queue produced **two** parks whose comments were
textually identical:

```
Failed checks:
- check for test262 regressions
```

No run URL. No step name. The two situations were opposite:

| PR | what actually happened | correct action |
| --- | --- | --- |
| **#3566** | the shard-artifact download **403'd**, so the verdict step never ran; the PR merged cleanly once unparked | **should NOT have parked** |
| **#3563** | the verdict step ran and caught a real uncatchable-trap regression | **park was correct** |

Because the comment carried neither the failing **step** nor a **run URL**, each
one cost a full manual investigation to tell apart. A park is also not cheap:
`enqueue-green-prs.mjs` **skips** held PRs, so a wrongly-parked PR **strands**
until a human notices.

`scripts/auto-park-merge-group-failure.mjs` already distinguishes *cancellation*
(0 failed jobs) from *failure* — but at **job** granularity only. Job-level
`conclusion: "failure"` is identical for "the artifact download died" and "the
regression verdict fired".

## Fix (delivered)

The Actions jobs API already returns `steps[]` with a per-step `conclusion`; the
script was throwing that away (`--jq '.jobs[] | {name, conclusion}'`).

1. **Report the step + the URL.** `fetchJobs` now selects
   `{name, conclusion, html_url, steps}`, and the park comment renders
   `- <job> — failing step: <step> ([job log](<url>))` plus a `Run: <url>` line.
   This alone would have made 2026-07-24's two parks distinguishable at a glance.
2. **Do not park on infra-only failures.** `classifyRun` gains
   `infraOnly` / `unclassifiable` / `shouldPark`. When **every** failed step
   across **every** failed job matches a recognised setup/infra step
   (`Set up job`, `Checkout`, `Post *`, `Set up node|pnpm|…`, `Download/Upload …
   artifact(s)`, container init/stop), the verdict never ran → **do not park**.
   The run is still red, so the queue ejects and `auto-enqueue` re-adds it —
   which is the correct response to a transient infra failure.

### Directionality — the load-bearing invariant

Being wrong in the **permissive** direction lets a real regression into `main`;
being wrong in the **strict** direction costs one label removal. So the default
is **park**, and we skip parking only on *positive* evidence:

- a failed job whose failing step cannot be identified (`steps` absent/empty) is
  `unclassifiable` → **parks**;
- any single non-infra failed step anywhere → **parks**;
- `INFRA_STEP_PATTERNS` is deliberately **tight**. Widening it makes the bot
  park *less*, which is the dangerous direction — when in doubt, leave a pattern
  out.

## Tests

- `scripts/auto-park-merge-group-failure.mjs --self-check` — 23 pure-logic
  checks, no network (extended from 10).
- `tests/issue-3597-auto-park-step-aware.test.ts` — **30 cases**, 3 ms, covering
  both motivating shapes explicitly (#3566 must NOT park, #3563 MUST park), all
  conservative-default paths, the unchanged #2547 cancellation invariant, and
  the comment rendering. Added to `tests/guard-suite.json` so a future edit to
  the bot cannot silently un-do the classification.

## Follow-up (not in this change)

**Retry the artifact download before concluding failure.** The #3566 403 was
transient; a retry in the `Download shard artifacts` step of
`test262-sharded.yml` would remove the failure at the source rather than
classifying it after the fact. That is a workflow-level change with its own
validation needs, so it is intentionally left out here — this change makes the
failure *legible and non-parking*, which is the part that was costing manual
investigations.
