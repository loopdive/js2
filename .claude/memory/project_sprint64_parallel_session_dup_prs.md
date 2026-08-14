---
name: project_sprint64_parallel_session_dup_prs
description: Sprint 64 had a second agent team in a parallel session sharing the ttraenkler fork — caused duplicate PRs and shared branches; check open PRs before committing
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

During sprint 64 (2026-06-21) a SECOND agent team ran in a parallel session on
the same `ttraenkler/js2` fork. All agents share the `ttraenkler` GitHub
identity, so `gh pr list --author @me` shows every team's PRs.

Concrete collisions I hit:
- **Duplicate toLocaleString PRs**: I opened #1806 (`issue-2160-string-number-coercion`);
  the parallel session opened #1809 (`issue-2160-wrapper-method-dispatch`) for the
  SAME `Number.prototype.toLocaleString` standalone fix.
- **Shared branch**: `issue-2160-string-raw-standalone` — I claimed it and started
  the generic-tagged-template `array.new_fixed` externref-lift fix, but the parallel
  session had already committed `ab9c3464a` (String.raw short-circuit + the same
  generic lift) AND pushed it AND opened PR #1812. My working-tree edits were
  byte-identical to what was already committed → zero new work.

**Root cause clarified (later):** it's not separate "teams" — it's co-agents
(dev-bruno=me, dev-anita, dev-carla) who ALL pass the SAME git-lock handle
`ttraenkler/dev-agent` to `scripts/claim-issue.mjs`. A shared handle means
claim-first canNOT deconflict us: two agents "own" the same lock simultaneously,
so we independently rebuild + open the same fix. Second incident: #1825 (mine)
and #1826 (dev-anita) were byte-identical String.raw-subst PRs created 4s apart,
both enqueued — dev-anita closed #1826 as the dup. **Fix: each agent needs a
DISTINCT handle** (`ttraenkler/dev-bruno` / `dev-anita` / `dev-carla`). Ask the
tech lead to standardize this; until then, treat claim-first as advisory and
always `gh pr list` + probe before opening.

**How to apply:** before committing/​pushing a slice, run
`gh pr list -R loopdive/js2wasm --state open --search "<feature> standalone"` AND
`git log --oneline origin/<branch>` to check the branch isn't already committed/
PR'd by another session. Mirrors the [[project_2203_already_landed_duplicate]]
lesson. CI not triggering on fork PRs (only cla-check ran, required
pull_request workflows stalled ~30 min) compounded it — left the whole batch
DIRTY/UNKNOWN; that's pr-maintainer/infra scope, escalate rather than babysit.
