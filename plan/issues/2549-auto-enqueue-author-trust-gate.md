---
id: 2549
title: "Author-trust gate for auto-enqueue: never auto-merge external PRs"
status: done
sprint: 64
created: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: low
task_type: infrastructure
area: tooling
language_feature: n/a
goal: correctness
related: [2547, 2531, 1758]
assignee: "ttraenkler/dev-sd3"
---

# #2549 — author-trust gate for auto-enqueue

## Problem

We just decided (Option 1) that dev agents stop self-enqueuing their PRs;
`auto-enqueue.yml` (running `scripts/enqueue-green-prs.mjs` with an App token)
is now the **primary** enqueuer of green PRs. That makes auto-enqueue's trust
boundary load-bearing.

Before this change, `enqueue-green-prs.mjs` enqueued **any** open, non-draft,
all-checks-green, non-`hold` PR — it did **not** filter by author. Strangers are
normally blocked because arbitrary forks' CI does not run without a maintainer
approving the workflow run (`approve-fork-runs.yml` only auto-approves the
trusted `ttraenkler/js2` fork). But there is a real gap: **if a maintainer
manually approves a stranger's CI run** — the normal way to *review* an external
PR — **and it passes, auto-enqueue would then enqueue it → auto-merge.**
"Approve CI to review" must NOT mean "approve merge."

## Fix

Add an **author-trust gate** to `scripts/enqueue-green-prs.mjs`: only auto-enqueue
PRs whose `authorAssociation` is in `TRUSTED_AUTHOR_ASSOCIATIONS`
(`OWNER` / `MEMBER` / `COLLABORATOR`). Everything else
(`FIRST_TIME_CONTRIBUTOR` / `NONE` / `CONTRIBUTOR`-without-membership /
`MANNEQUIN` / unknown) is **skipped** with a logged reason
`untrusted-author:<assoc>`. So an external PR ALWAYS requires a deliberate human
enqueue, no matter how green.

Implementation notes:
- `gh pr list --json authorAssociation` is **not supported** in the container's
  gh (2.23 — errors `Unknown JSON field: "authorAssociation"`). The script
  therefore fetches `authorAssociation` for all open PRs in one GraphQL page via
  a new `authorAssociations()` helper that reuses the script's existing
  `graphql()` wrapper, returning a `{ prNumber -> assoc }` map.
- The gate **fails closed**: a PR missing from the map (assoc unknown) is treated
  as untrusted and never enqueued.
- It is an **additional** gate, layered after the existing
  draft / hold-label / already-queued / `ENQUEUEABLE` checks and before the
  expensive `visibleCheckState` / `greenSince` calls — so the green / grace /
  back-off / CLA logic is untouched.
- `cla-check` (a real merge gate now) remains the separate, deeper second line
  of defense for external contributions; the author gate is the first line. Both
  are referenced in the new code comments.

## Acceptance criteria

- [x] `enqueue-green-prs.mjs` skips any PR whose `authorAssociation` is not
  `OWNER`/`MEMBER`/`COLLABORATOR`, with reason `untrusted-author:<assoc>`.
- [x] `authorAssociation` is fetched via GraphQL (gh-json field unsupported).
- [x] Trusted set is a clearly-named constant with the
  "approve-CI ≠ approve-merge" rationale comment, and mentions `cla-check`.
- [x] Existing green/hold/draft/grace-window/back-off logic unchanged.
- [x] `node scripts/enqueue-green-prs.mjs --dry-run` runs without crashing and
  trusted PRs still pass the gate.

## Test results

`node --check` passes. `--dry-run` against live open PRs runs clean (7 open, all
skipped on prior-stage label/draft/state guards). A direct simulation of the
gate against the live association map shows all `MEMBER` PRs as trusted
(would-proceed) and synthetic `FIRST_TIME_CONTRIBUTOR` / `NONE` / `CONTRIBUTOR` /
`MANNEQUIN` / unknown associations all rejected with `untrusted-author:<assoc>`.
Prettier `--check` clean.
