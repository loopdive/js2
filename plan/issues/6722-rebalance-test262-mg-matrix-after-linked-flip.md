---
id: 6722
title: "CI: rebalance the merge_group test262 matrix to 20 js-host / 82 standalone — the linked-harness flip made js-host ~4x cheaper and left standalone the long pole by ~11 min"
status: done
completed: 2026-09-28
sprint: current
priority: high
horizon: s
goal: maintainability
reasoning_effort: high
requested_by: ttraenkler/opus-lead
created: 2026-09-28
related: [3431, 4441, 3451, 5407]
---

## Problem

The merge_group matrix splits 102 runners between the two test262 lanes by
their measured work ratio (`scripts/gen-test262-mg-matrix.mjs`). The split
was last derived on 2026-08-15 at a 1.03:1 ratio and set to 52 js-host / 50
standalone.

The #3451 slice 6 flip (2026-09-17) moved the js-host lane onto the linked
harness oracle: the harness prefix compiles once per include-set instead of
once per row. js-host work fell about 4x. Standalone still compiles the whole
assembly per row, so its work did not move. The split was not re-derived.

Measured `Run shard` step totals across six consecutive green merge_group runs
at 52/50 (2026-09-28):

| run | js-host rs | js-host mean / max | standalone rs | standalone mean / max |
|---|---:|---|---:|---|
| 36375344400 | 8,294 | 160 s / 229 s | 40,189 | 804 s / 938 s |
| 36373666471 | 8,570 | 165 s / 210 s | 40,285 | 806 s / 1,210 s |
| 36372049678 | 8,968 | 172 s / 237 s | 39,451 | 789 s / 918 s |
| 36371437444 | 8,505 | 164 s / 223 s | 38,702 | 774 s / 935 s |
| 36370111071 | 8,538 | 164 s / 222 s | 40,059 | 801 s / 909 s |
| 36368683255 | 8,401 | 162 s / 226 s | 38,434 | 769 s / 920 s |

Work ratio js-host:standalone is 0.21-0.23. js-host shards finish in about
4 min and then sit idle while standalone shards run for 15.

## Change

- `scripts/gen-test262-mg-matrix.mjs`: `JS_HOST_CHUNKS` 52 → 20,
  `STANDALONE_CHUNKS` 50 → 82. Same 102-runner budget; capacity constants
  untouched. The exact balance is about 18/84; 20/82 leaves room for the
  js-host lane's higher max/mean skew (~1.38 vs ~1.17).
- `.github/workflows/test262-sharded.yml`: the merge_group completeness
  validators now expect 20 js-host and 82 standalone shard manifests.
- `tests/issue-3431-mg-matrix.test.ts`: ratio pin updated to 20/82.

Projected per-shard means: js-host ~425 s, standalone ~485 s. Standalone's
slowest shard drops from ~920 s to ~570 s, about 6 min off every merge group.

## Not in scope

The per-row lever is a standalone linked-harness oracle (compile the prefix
once into a standalone provider module and link each body against it). It
needs #5407's cross-module link cost fixed first and an oracle-version bump.
This change is the ratio correction only; re-derive the split again when that
lands.
