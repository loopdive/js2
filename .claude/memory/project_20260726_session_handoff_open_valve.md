---
name: project_20260726_session_handoff_open_valve
description: "HANDOFF 2026-07-26 ~00:10Z — CHECK FIRST: BASELINE_TRAP_GROWTH_ALLOW may be left at 1; report page still stale from a SECOND unfixed bug; 4 follow-ups unfiled"
metadata: 
  node_type: memory
  type: project
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-26T00:44:06.348Z
---

# Handoff — 2026-07-26 ~00:10Z (sprint 77 window)

## ✅ RESOLVED — the one-cycle valve closed correctly (no action needed)

`BASELINE_TRAP_GROWTH_ALLOW` was set to `1` at 23:40:56Z so PR **#3619** (which
declares an intentional `illegal_cast` +1) could land without re-wedging promote.
Outcome, all verified:

- #3619 merged **00:35:48Z**; its promote pushed the baseline **00:37:22Z**;
  run `30181427156` = **success**. #3590 also merged (00:21:27Z).
- Valve reset to **`0` at 00:42:52Z** — five minutes AFTER the promote read it.

**Lesson worth keeping:** a post-merge push run reuses the **per-SHA baseline
cache** (#3448/#3467) instead of re-running shards, so its promote job can finish
~90 s after merge — NOT the ~16 min a cold sharded run takes. A fixed-delay
"wait then reset" watcher is therefore racy in BOTH directions. Gate on the
promote run's actual conclusion, never on a sleep.

(Sanity-check anyway if in doubt: `gh api
"repos/loopdive/js2/actions/variables/BASELINE_TRAP_GROWTH_ALLOW" --jq '.value'`
must read `0`.)

## What was fixed (verified)

The **baseline-promote deadlock**: a declared `trap-growth-allow` resolves from the
change-set, so it applies at PR level and **evaporates in the post-merge promote
job** (`tolerance 0`). Baseline pinned at `illegal_cast` 74 while main sat at 75 ⇒
every push failed identically. Cleared with the one-cycle valve + re-running the
failed run. Promotes flowing since (22:43 → 22:46 → 23:02 → 00:06Z).

Blast radius was far beyond a stale dashboard: **four PRs (#3635, #3636, #3627,
#3639) were parked with identical misleading verdicts.** Proven by a clean A/B —
#3636 failed at 22:18Z on the stale baseline and **passed at 23:01Z on the fresh
one with no code change**.

test262 host: 30,390/43,098 (70.51%) → **30,511/43,104 (70.78%)**. Standalone flat
at 23,523/43,106. These are all PRE-de-inflation.

## ⚠️ STILL BROKEN — the user's actual visible symptom

**The report page is STILL stale** and fixing promote did NOT fix it. Committed
`benchmarks/results/test262-current.json` is stuck at `15:43:36Z / 30390-43098`.
The summary sync **ran at 23:32:36Z and reported SUCCESS while committing nothing**,
with fresh baseline data available. That is a **SECOND, INDEPENDENT BUG**.
Evidence: sync runs hourly and all `success` (18:29, 19:45, 21:27, 22:28, 23:32),
but commits land only ~3-hourly and stopped entirely after 15:43. **"success" is
not evidence it did its job** — same shape as the `quality` fail-fast case.
**This is the top item; it is what the user can see.**

## Unfiled — exist ONLY in that conversation

1. **CLAUDE.md still says `-R loopdive/js2wasm`** for the main repo (renamed to
   `loopdive/js2`). Agents follow it literally. `loopdive/js2wasm-baselines` is a
   genuinely separate repo — do NOT rename that.
2. **Ratchet the #3603 ceiling down.** PR #3635 carries `regressions-allow: 2500`,
   an explicitly **stakeholder-directed UNMEASURED** ceiling (the v11→v12 bump is
   itself the verdict-logic change, so no pre-v12 figure converts). Capture the
   first v12 merge_group measurement and tighten to measured+margin. Prior v11
   context only: 1031-1033 honest regressions, 96-97 gross fixed.
3. **#3644 residual**: the allowance is consumed by exactly ONE promote run — if
   that run fails for any unrelated reason the declaration vanishes and the wedge
   returns identically. Prevents the wedge; does not make recovery self-healing.
4. `quality` fail-fast masking, and the auto-enqueue grace-0 race.

## Landed

PR **#3640** merged (documents the deadlock on #3634, blocks its unsafe blind-retry
fix). PR **#3627** merged. Queued: #3635, #3498, #3625, #3590, #3619, #3639, #3641.
**#3639 is the only CODE fix for the deadlock** — main still has
`if (forwardOracleBump)` at `check-baseline-trap-growth.ts:142`.

See [[reference_never_push_to_a_queued_pr_it_ejects_to_the_back]],
[[reference_workflow_touching_prs_never_autoenqueue]],
[[reference_quality_failfast_masks_downstream_gates]].
