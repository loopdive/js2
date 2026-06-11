---
id: 1944
title: "CI cost: build the compiler bundle once per run and cache pnpm — ~120-170 wasted runner-minutes per test262 run"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: n/a
goal: maintainability
---
# #1944 — CI cost: bundle-once artifact + pnpm cache

## Problem

Every one of the **114 test262 shard jobs** (57 chunks × 2 targets,
`test262-sharded.yml:294-365`) independently runs `actions/setup-node`
(without `cache: pnpm`), `pnpm install --frozen-lockfile`, and a compiler
bundle build (`test262-sharded.yml:417-421`). At ~60-90s of setup each,
that's **~120-170 runner-minutes of pure overhead per run** — and the full
matrix runs both at PR time and again in merge_group
(`test262-sharded.yml:4`), roughly doubling it. The 8 equivalence shards
(ci.yml:144-195) repeat the same pattern at smaller scale.

## Proposed approach

1. **Bundle once**: the cheap-gate job (already runs first,
   `test262-sharded.yml:282-285`) builds the compiler bundle and uploads it
   as an artifact; shard jobs download instead of building. (Bundle is
   deterministic per commit — also enables cross-job byte-identity checks.)
2. **pnpm store cache**: add `cache: pnpm` to `actions/setup-node` (or
   `actions/cache` on the pnpm store keyed by lockfile hash) in all
   workflows; measure — typical savings 30-60s/job.
3. Evaluate (separate decision with the user/PO, not bundled in this PR):
   PR-time = reduced smoke matrix (e.g. 8 representative shards), full
   114-job matrix in merge_group only — the bot-refresh skip
   (`test262-sharded.yml:479`) shows the conditional-matrix pattern already
   exists. The merge queue remains the hard gate, so coverage at merge is
   unchanged.
4. Also: delete or revive the vestigial `.test262-cache` actions/cache step
   (`test262-sharded.yml:396-414`) — the runner disabled result caching
   ("stale cache entries caused false baselines", `test262-shared.ts:763`),
   so 114 jobs save/restore mostly-dead state every run.

## Acceptance criteria

- Shard job setup time (pre-test) drops below ~30s p50 (compare run
  timings before/after).
- Bundle byte-identity asserted across ≥2 shards in one run.
- Vestigial cache step removed or re-justified in a comment.

## Source

Compiler quality review 2026-06.
