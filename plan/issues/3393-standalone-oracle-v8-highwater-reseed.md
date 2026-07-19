---
id: 3393
title: "Re-seed the standalone high-water floor for the original-harness oracle v8"
status: done
created: 2026-07-17
completed: 2026-07-17
priority: critical
feasibility: trivial
task_type: ci-infra
area: test-infrastructure
goal: test-infrastructure
sprint: current
horizon: s
assignee: "loopdive/porffor-scrum"
related: [2097, 2961, 3288, 3370]
origin: "PR #3287's first merge-group run completed all 114 Test262 shards but exposed a stale pre-oracle-v8 standalone high-water mark: current=4508, mark=24946."
---

# #3393 - Re-seed the standalone floor after oracle v8

## Problem

Commit `d3eac416d4cb1df25c506dbed25d4cb3e9706e50` made the literal
upstream Test262 harness authoritative and bumped the verdict oracle to v8. Its
commit message explicitly requires an oracle rebaseline because passes that
depended on the synthetic wrapper are intentionally reclassified.

The rolling baseline understands forward oracle bumps, but the independent
#2097 absolute standalone floor does not. Its committed mark remained the
pre-v8 value of 24,946. The first full merge-group run after the policy change
therefore failed even though every one of the 114 shard jobs passed:

```text
[standalone-highwater] current pass=4508, mark=24946
STANDALONE host-free pass floor breached: 4508 < 24946 - 50
```

This is not caused by the Porffor backend in PR #3287. That PR's default Wasm
emission was verified byte-identical to its base, while the 20,438-count change
is the intended oracle-v8 reclassification already declared by #3370.

## Fix

Re-seed `benchmarks/results/test262-standalone-highwater.json` from the exact
merged standalone report produced by merge-group run `29614990626`, head
`92fa7da5b589a7c100156694f5c5ed0fdc14f013`:

| Scope       |  Pass |  Total |
| ----------- | ----: | -----: |
| Full corpus | 4,508 | 48,088 |
| Official    | 4,312 | 43,106 |

The report is uniformly oracle v8. Its `pass` and `host_free_pass` fields are
equal, preserving #2961's rule that a host-backed result is never a standalone
pass.

## Acceptance criteria

- [x] The committed floor uses the exact oracle-v8 merge-group measurement.
- [x] `pass` and `host_free_pass` remain identical.
- [x] The official count and total come from the same merged report.
- [x] `check-standalone-highwater.mjs` accepts that report with the standard
      tolerance.
- [x] No compiler or Porffor implementation code changes.

## Verification

- Test262 Sharded run `29614990626`: all 114 shard artifacts downloaded and
  merged; only the stale #2097 floor step failed.
- `test262-standalone-report-merged.json`: oracle v8, full 4,508 / 48,088,
  official 4,312 / 43,106.
- `node scripts/check-standalone-highwater.mjs --report
  test262-standalone-report-merged.json`: passes after this reseed.
