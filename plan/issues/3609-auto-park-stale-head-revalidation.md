---
id: 3609
title: "auto-park bot judges a stale head — re-validate against the PR's current head before applying `hold`"
status: ready
sprint: Backlog
created: 2026-07-25
updated: 2026-07-25
priority: medium
horizon: s
feasibility: medium
task_type: ci
area: ci, merge-queue
goal: release-pipeline
related: [2547, 3598]
origin: "Split out of #3598 (Collision D) — deliberately kept out of the PR-level gate's scope."
---

# #3609 — auto-park re-validation: don't park a PR the branch has already fixed

## Problem

Collision D of #3598: PR #3589 was auto-parked (`hold` label) by the
`merge_group` duplicate-id gate for a collision whose **renumber had already
landed on the branch** — the merge-group run had started _before_ that push, so
the queue validated a **stale head** and parked a PR that was already correct.

A PR-level gate structurally cannot fix this (#3598 covers the PR-vs-PR
collision itself): the stale-head case is by construction the queue evaluating
an older commit than the branch has. The fix belongs where the park is raised
or acted on — the auto-park bot (#2547).

## Proposed fix (either or both)

1. **Re-evaluate before parking.** When the bot is about to apply `hold` for a
   `merge_group` failure, compare the SHA the failed run validated against the
   PR's _current_ head. If the head has advanced, skip the park (the queue will
   re-validate the new head anyway) or downgrade to a comment.
2. **Record the judged SHA.** At minimum, the park comment should state the SHA
   the verdict was formed on, so a shepherd reading the park can immediately see
   it is stale instead of re-diagnosing (per the #3598 auto-park handling rules,
   a bot park-hold must be diagnosed before removal — make that diagnosis cheap).

## Acceptance criteria

1. A PR whose head advanced after the failed `merge_group` run started is not
   parked (or its park comment clearly states the stale judged SHA).
2. Existing park behaviour for genuinely-failing current heads is unchanged.
3. The park comment names the failing run, the judged SHA, and the current head
   SHA at comment time.
