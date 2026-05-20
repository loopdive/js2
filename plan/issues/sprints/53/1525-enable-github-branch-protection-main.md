---
id: 1525
sprint: 53
title: "Enable GitHub branch protection on main with required status checks"
status: ready
created: 2026-05-20
priority: high
feasibility: easy
reasoning_effort: low
task_type: ops
area: ci, ops
goal: ci-hardening
related: [1391, 1393]
---

# #1525 — Enable GitHub branch protection on main with required status checks

## Problem

The repository has 16 CI workflows but **no GitHub branch protection rule
visible in `ci.yml` or the repo settings.** The actual merge authority is
the hook-based `dev-self-merge` skill, which reads
`.claude/ci-status/pr-<N>.json` and decides whether to invoke
`gh pr merge --admin`. Consequences:

- A PR can land on `main` without any required status check.
- `benchmark-refresh.yml` lines 101–115 explicitly say the regression gate
  "does NOT fail the workflow" — the gate is informational only.
- `test262-sharded.yml` and `test262-differential.yml` both run; the
  comment in the latter says it is "authoritative" and the former should
  be removed "after ≥3 PRs bake-in" — that note has lingered.
- Past incident: PR #294 saw 495 false-positive regressions from baseline
  drift (`plan/log/retrospectives/2026-04-11-ci-baseline-drift-investigation.md`).
  The escalation was advisory, never hard-blocking.

## Acceptance criteria

1. **Branch protection on `main`** with the following minimum set of
   required status checks:
   - `ci.yml` (lint, format, typecheck, IR fallback gate)
   - `test262-differential.yml` (or whichever is declared authoritative)
   - `benchmark-refresh.yml` regression gate (flipped to fail-on-regression
     for PRs, not just informational)
2. **Force-push to `main` is disabled** for all users (including admins
   in normal flow; allow only via explicit override).
3. **Required reviewers**: at least one CODEOWNERS approval, or the
   `[skip-review]` label for documented exception classes (ci-status
   bot commits, planning artifact regen).
4. **Linear history is preserved** — `merge-commit` and `squash-and-merge`
   are allowed, `rebase-and-merge` is disabled to keep the merge graph
   readable.
5. **Dual-gate decision recorded**: either retire `test262-sharded.yml`
   in favor of `test262-differential.yml` (preferred), or document why
   both must run as required checks.

## Implementation notes

- This is largely a repo-settings change, not a code change. Document the
  configured ruleset in `docs/ci-policy.md` (new) so future changes are
  audit-trail-able.
- Coordinate with `dev-self-merge` skill — once GitHub enforces the
  checks, the skill's manual JSON-file gate becomes redundant for the
  hard-block decision. It can still serve as the agent-friendly summary
  channel.
- Keep `.claude/ci-status/pr-<N>.json` written by the feed workflow, but
  treat it as a UX layer for agents, not the merge authority. (See #1391
  for the staleness escalation work that this issue subsumes for the
  hard-block case.)
