---
id: 6823
title: "ci: residue from #6786/#6796/#6799 — coalesce the direct-main pushers into one scheduled promotion (design), `baseline-summary-sync.yml` runs without `pnpm install`, `.claude/settings.json` still watches the deleted ci-status directory, the edition-ratchet docs describe only the standalone lane, and auto-park parks collateral PRs of a failed speculative group"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: tooling
language_feature: n/a
goal: maintainability
related: [6799, 6796, 6786, 6797, 2547]
requested_by: ttraenkler/claude-review
origin: "carve-outs recorded by the #6786, #6796, #6797 and #6799 implementations (2026-10-02) plus the #6431 collateral park observed by the filer (run 36982213641)"
---
# #6823 — CI/process residue

1. **Coalesce the direct-`main` pushers.** `benchmark-refresh.yml`,
   `refresh-baseline.yml` and `baseline-summary-sync.yml` still push to `main`
   directly (`[skip ci]` commits rebuild every in-flight merge group; 67 of
   281 first-parent commits on 2026-10-02 were bot pushes per the #6799
   measurement). #6799 made the queue gate fail closed but left the cadence
   redesign without an issue: one scheduled promotion PR on a reused branch,
   the `npm-compat-refresh.yml` pattern. Needs a design decision (how many
   artifacts, which cadence, which gate skips) before implementation.
2. **`baseline-summary-sync.yml` has no install step** (reported by #6797): a
   script step needing `node_modules` fails or silently no-ops there. Add the
   cached `pnpm install --frozen-lockfile` step the other workflows use, or
   restrict the job to dependency-free scripts and say so.
3. **`.claude/settings.json`** still registers a hook watching the
   `.claude/ci-status` directory that #6796 deleted. Remove the hook entry.
4. **Edition ratchet docs**: CLAUDE.md's "Per-edition conformance ratchet"
   section describes the standalone floor only; #6786 added the host-lane
   per-row gate (`--host-lane` in `scripts/test262-edition-ratchet.ts`) and the
   host baseline lags main by one promote cycle. Document both lanes and the
   lag.
5. **Collateral parks.** The queue builds speculative groups (a group's base
   is the merge of the PRs ahead of it). When a predecessor fails, every
   later group fails the same step and `auto-park` holds all of them with the
   same comment: PR 6431 (a one-line CLAUDE.md change) was parked at 08:18 UTC
   for the import-cycle growth of PR 5883 ahead of it (run 36982213641). The
   bot should re-run the failing step against the PR's own base before
   parking, or at least say in the comment that the group had predecessors
   and name them, so the hold can be lifted without a manual diagnosis.

## Acceptance

- One PR per numbered item (item 1 after its design is agreed); each with the
  test or workflow assertion that proves it.
