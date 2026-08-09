---
name: reference_two_checks_share_a_name_head1_watcher_settles_on_a_stub
description: "Two CI checks can report under the SAME name (one a `skipping` stub) — a `gh pr checks | head -1` watcher then settles on the stub and declares finished while the real job is still pending"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-26T20:44:16.324Z
---

**A check name does not identify a check.** Measured 2026-07-26 on PR #3677:
two entries report under the identical name
`cheap gate (main-ancestor + lint)` — a stub workflow that always reports
`skipping`, and the real `test262-sharded.yml` job that does the work.

A watcher doing `gh pr checks <N> | grep "<name>" | head -1` took the **stub**
and emitted:

```
SETTLED: typecheck-control=skipping lint-control=skipping
```

which looks like a clean terminal result. It was an artifact — the real jobs
were still `pending`. Trusting it would have meant reporting CI controls that
never ran, i.e. reporting a *verification* that did not happen. Same family as
[[reference_silent_empty_is_indistinguishable_from_real]]: a proxy returning a
plausible value for a question it is not answering.

**Rules for any check watcher:**

- **Filter `skipping` rows out** before deciding anything. `skipping` is not a
  terminal state for your purposes — it means "this row has no opinion."
- **Settle only on a terminal `pass`/`fail`.** Never on "a row exists."
- **Never let `head -1` pick the row.** If a name can match more than once,
  aggregate: fail if ANY matching row failed, pending if ANY is pending.
- Prefer the run/job **URL or databaseId** over the name when you need to point
  at a specific job — that is the only stable identifier.

This is not specific to that one gate: `merge shard reports`,
`check for test262 regressions` and `cheap gate` all appear multiple times in
`gh pr checks` output on this repo (PR-level green no-op + the real
`merge_group` job — see [[reference_ci_status_feed_retired_use_required_checks]]),
so the same `head -1` bug can silently green-light any of them.

Related: [[reference_skipped_needs_if_pattern]] ·
[[reference_dropped_synchronize_only_cla_check_repush]]
