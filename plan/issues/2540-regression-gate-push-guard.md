---
id: 2540
renumbered_from: 2379
title: "CI: test262-sharded regression-gate hard-fails every push-to-main run on baseline-drift 'regressions' (HW/baseline reporting frozen)"
status: done
assignee: ttraenkler/sdev-harvest2
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: high
feasibility: easy
reasoning_effort: high
task_type: infra
area: ci
language_feature: n/a
goal: ci-health
related: [1668, 1235, 1528, 2096]
origin: "2026-06-19 — read-only diagnosis of 7+ consecutive failing push-to-main test262-sharded runs"
---

## Problem

Every `push`-to-main run of `test262-sharded.yml` has been failing (7+
consecutive), freezing the high-water / baseline reporting pipeline so the
landed +234 value-read flips (and everyone else's) aren't reflected.

## Root cause

The failing job is **`regression-gate` → step `Fail on regressions`**
(`test262-sharded.yml:1251`), `exit 1`. NOT `promote-baseline` (that job
SUCCEEDS — the HW/baseline IS promoted).

The diff on a representative failing run (27797604295, a push event) shows a
**net IMPROVEMENT** being hard-failed:

```
pass            29587 → 32818   (+3231)
fail            16965 → 14031   (−2934)
compile_error    1340 →  1042   (−298)
Improvements (other→pass): 3931
Regressions (pass→other):   695   ← gate exit 1 on this
```

The 695 "regressions" are **baselines-repo serialization-lag drift**: the
`js2wasm-baselines` JSONL the gate diffs against is several merges behind main
HEAD, so tests that flipped on main since the last baseline refresh read as
PR-regressions (classic #1235/#1668 drift) even though no PR caused them.

Two compounding bugs:

1. **`Fail on regressions` (line 1251) has no event guard** — it runs on
   `push`-to-main and hard-fails on any regression count > 0. On a push-to-main
   run the merge already happened, so this fine-grained gate cannot block
   anything; it only freezes the post-merge reporting. Push-to-main is already
   protected against a genuine codegen break by the **#1668 Catastrophic guard**
   (threshold 200, inside the required `merge shard reports` check) — which
   correctly PASSED (695 < 200-threshold path is the wrong frame; the
   catastrophic guard only counts wasm-change pass→fail and stayed under its
   bar).
2. **`Check baseline staleness` step (line 1119) is gated to
   `pull_request || merge_group` only** — so on `push`, `steps.staleness` never
   runs, `stale_minutes` is empty, `STALE_M` falls back to `'0'`, and the
   drift-warning footer (`if STALE_M ≥ 30`) never renders. That is why no one
   saw the "these are drift, not real" warning on the failing runs.

## Fix (workflow-only, surgical)

`.github/workflows/test262-sharded.yml`:
- Add `&& github.event_name != 'push'` to the `Fail on regressions` step `if:`
  — keep the gate for `pull_request` / `merge_group` (where pre-merge gating is
  the point), exempt only `push`.
- Widen the `Check baseline staleness` step `if:` to also include
  `github.event_name == 'push'`, so the drift footer renders on push-to-main
  runs.

No behaviour change for PRs (the per-PR `regression-gate` still runs on
`pull_request` and blocks real regressions). The required merge-queue checks
(`cheap gate`, `merge shard reports` incl. the #1668 Catastrophic guard,
`quality`) are untouched, so real-regression protection on push is preserved.

## Verification

- YAML structure: surgical `if:` edits + comments at correct step indent.
- The per-PR path is unchanged: this very PR's own `regression-gate` runs under
  `pull_request` and must pass normally.
- Post-merge, push-to-main runs stop hard-failing on drift; the HW/baseline
  reporting unfreezes.
