---
id: 4058
title: "`sync-workspace-main.sh` fires the full `.husky/pre-push` chain on every fork-main fast-forward with no mutual exclusion — 14 processes observed, one stuck 69 min"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
---
# `sync-workspace-main.sh` fires the full `.husky/pre-push` chain on every fork-main fast-forward with no mutual exclusion — 14 processes observed, one stuck 69 min

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Diagnosed 2026-08-01 by s78-dev3, independently corroborated (12 processes counted at a second sampling, oldest 5,863 s).

**Mechanism — line 56 of `scripts/sync-workspace-main.sh`:**

```
git -C /workspace push origin <sha>:refs/heads/main --quiet
  └─ git remote-https origin https://github.com/ttraenkler/js2
     └─ .husky/pre-push origin ...
```

Fast-forwarding the **fork's** `main` is a real `git push`, so it triggers the full `.husky/pre-push` chain: typecheck + lint + IR-parity tests. Every invocation pays it.

**Two defects compound:**

1. **No mutual exclusion.** Instances are spawned by hooks across agents with nothing serialising them. Observed at peak: **14 processes / 4 concurrent script instances**, ages 400 s → 4,599 s, all blocked in the same push. A second sampling found 12 processes / 6 invocations, oldest **5,863 s (98 min)**. They pile up because the script takes longer than the interval that re-invokes it.

2. **The gate chain is mispriced for this call site.** The SHA being pushed is an **already-CI-validated upstream commit** — it passed the full required-check set and the `merge_group` re-validation before landing on `upstream/main`. Re-running typecheck/lint/IR-parity locally against it proves nothing that CI has not already proven.

**Why this matters beyond tidiness:** the box has been at load 15–28 all session, and reported load runs far above actual CPU (15.27 load vs 3.8 of 8 cores busy) because these processes are I/O-blocked on the bind mount. That contention has measurably corrupted work this sprint — it killed one agent's interpreter arm mid-run, forced another to re-run at a 180 s timeout after 9 phantom `compile_error` rows appeared at load 19.7, and produced a `with`-directory file that timed out at 31.2 s in parallel and passed when re-run alone. **These processes are a significant contributor to that load, not merely a victim of it.**

**Third-order effect:** by the time one instance was stopped, the SHA it was pushing was already ~70 min stale — so even a successful completion would not have reached current main. The work is not just expensive, it is often obsolete on arrival.

**Two candidate fixes (either would do; both are small):**

- **`flock`/lockfile** around the sync, matching the pattern the test262 runner already uses. Serialises the pile-up and is the more conservative option.
- **`--no-verify` on this specific fork-main fast-forward.** Justified precisely because the pushed SHA is already CI-validated upstream; this is a mirror update, not new work. Narrow the flag to this one call site — do **not** blanket-disable the pre-push hook.

Prefer doing both: the lock stops the pile-up, `--no-verify` stops each instance being expensive.

**Verify with a positive control:** after the fix, confirm the pre-push gate still fires for an ordinary branch push (i.e. that `--no-verify` did not leak beyond this call site). A gate that silently stops running everywhere would be a far worse outcome than the current waste.
