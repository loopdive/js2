---
name: reference-park-diagnosis-check-runs-on-sha-not-run-jobs
description: Park/merge_group diagnosis must list check-runs on the commit SHA; gh run view --json jobs silently truncates to 30 jobs and hides the failing aggregator
metadata: 
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

When diagnosing a merge_group failure (auto-park), do NOT rely on
`gh run view <run-id> --json jobs` — it silently truncates to the first
~30 jobs of a large run (test262-sharded has 119+), which can omit the
actual failing aggregator job ("merge shard reports", "check for test262
regressions"). A diagnosis based on the truncated list falsely reads as
"all jobs green → must be collateral".

**Reliable path**: list check-runs on the queue ref's commit SHA:

```bash
gh api "repos/loopdive/js2wasm/commits/<sha-of-gh-readonly-queue-ref>/check-runs" \
  --paginate --jq '.check_runs[] | .name + " " + .conclusion'
```

Found by pr-shepherd-2 on 2026-07-17 diagnosing PR #3176's park — it
almost declared the park collateral off the truncated job list.

Related: [[reference-gh-remove-label-rest-not-pr-edit]] (gh CLI silent-failure family).
