---
id: 4511
title: "Session-start usage-limit monitor: per-minute window check, suspend sentinel at ≥99%, agent-spawn deny hook"
status: done
completed: 2026-08-16
sprint: 78
created: 2026-08-16
updated: 2026-08-18
assignee: ttraenkler/fable-lead
priority: high
horizon: s
feasibility: medium
task_type: infra
area: ci, process
goal: ir-full-coverage
origin: "user directive 2026-08-16 — 'at the beginning of every session a background job should be scheduled that every minute reads the usage limits and if one is close should suspend work for itself and the whole team … ideally set up as a hook when the session starts'"
related: []
---

# #4511 — Session-start usage-limit monitor (hook + daemon + sentinel)

## Problem

The suspend-at-99% rule (`feedback_5h_window_pause_resume`,
`feedback_5h_window_99pct_schedule_wakeup`) had no automated detector: the
5-hour window percentage was in the statusline's stdin payload but was never
persisted, so the fleet only learned the window was exhausted when agents
died mid-turn with limit errors (it happened twice on 2026-08-15/16 — both
recoveries were clean only because of push-early discipline).

## What landed

1. **`.claude/statusline-command.sh`** — the budget cache
   (`~/.claude/js2wasm-budget.json`) now also persists
   `five_hour_used_pct` + `five_hour_resets_at` (it previously kept only the
   weekly figures).
2. **`scripts/usage-limit-monitor.sh`** (new) — singleton daemon, 60s loop:
   reads the cache; at ≥99% (env-overridable `USAGE_LIMIT_SUSPEND_PCT`) on the
   5h (or weekly) window it raises `~/.claude/usage-limit-suspend.json`
   carrying the window name, percentage and reset timestamp; clears it when
   usage drops (new window). `--once` mode for tests.
3. **`.claude/settings.json`** — two hook wirings:
   - `SessionStart` launches the daemon (no-op if already running).
   - `PreToolUse` on `Agent` DENIES new agent spawns while the sentinel is
     live and unexpired, with a reason that carries the suspend order and the
     reset time, so the lead is instructed in-band to suspend the team and
     schedule exactly one wakeup.

## Honesty constraint (load-bearing)

The cache is written only when the statusline renders — i.e. interactive
sessions. **Headless/remote sessions never refresh it**, so the monitor
degrades to an explicit `NO-SIGNAL` log state there and never fabricates a
percentage (a detector must be able to say "I don't know"). In no-signal
sessions the fallback remains the documented limit-error handling: on the
first "hit your limit · resets HH:MM" error, suspend everything and arm one
wakeup at the stated reset.

## Test evidence (2026-08-16, `--once` mode against a synthetic cache)

| scenario | result |
| --- | --- |
| cache with `five_hour_used_pct: 99.5` | sentinel raised with `resets_at` |
| deny-hook command with live sentinel | emits `permissionDecision: "deny"` naming window, %, reset time |
| cache back to 12% | sentinel cleared, transition logged |
| cache absent | `NO-SIGNAL` logged once, no sentinel |

Settings JSON validated with `jq -e` for both hook entries after the merge
(existing hook arrays preserved).

## Residual

- The deny hook gates `Agent` spawns only; the lead's own long turns are not
  interrupted mid-flight (deliberate — the suspend itself costs tokens and
  must run to completion).
- Wakeup scheduling stays with the lead (send_later/one-shot cron) because
  hook scripts cannot reach the scheduling tools; the deny reason tells the
  lead the exact reset time to use.
