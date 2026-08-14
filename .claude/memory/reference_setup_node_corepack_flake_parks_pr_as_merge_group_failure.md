---
name: reference_setup_node_corepack_flake_parks_pr_as_merge_group_failure
description: "A merge_group test262 shard that fails at the 'Setup Node' / 'Setup pnpm via Corepack' step is an INFRA FLAKE (no tests ran) — auto-parks the PR as a merge-group-failure, but is a safe single re-admit, not a real regression"
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

The `auto-park-bot:merge-group-failure` fires whenever ANY required check fails
in the `merge_group` — including when a `test262 js-host shard N` job dies at an
**infrastructure setup step** (`Setup Node`, or `Setup pnpm via Corepack` →
`registry.npmjs.org` network error) BEFORE any test runs. When setup fails,
steps 5-7 (Install deps / Build compiler / Run shard) are all **skipped**, so the
shard executes **zero tests** → there is no pass→fail delta → it is NOT a real
regression.

**Confirmed twice (2026-07-05/06):**
- #2738 (B3 write-through): `js-host shard 6` died at "Setup pnpm via Corepack".
- #2748 (delete +1): `js-host shard 3` died at "Setup Node".
Both were front-end/byte-inert-off-path changes; both re-admitted once and merged.

**How to diagnose (do this BEFORE removing a bot-park hold):**
```
RUN=$(gh run list -R loopdive/js2wasm --workflow test262-sharded.yml --limit 25 \
  --json databaseId,event,conclusion \
  --jq '[.[]|select(.event=="merge_group" and .conclusion=="failure")][0].databaseId')
gh run view $RUN -R loopdive/js2wasm --json jobs \
  --jq '.jobs[]|select(.name|test("js-host shard N"))|{conclusion,steps:[.steps[]|select(.conclusion=="failure")|.name]}'
```
If the failed step is `Setup Node` / `Setup pnpm via Corepack` / any setup step
(not "Run … shard") → **infra flake, safe single re-admit** (remove hold, one-shot
enqueue, comment the diagnosis). If the failed step is the actual test run →
real regression, fix on branch, do NOT re-admit.

Contrast with [[reference_gh_json_jobs_truncates_30_masks_merge_group_failure]]:
there the aggregator genuinely failed the standalone floor (real). Here the shard
never ran. Always read the failed STEP name, not just the job conclusion.
