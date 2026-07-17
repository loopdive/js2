---
id: 3344
title: "CI: catastrophic regression guard (#1668) ignores the regressions-allow ceiling → blocks legitimate oracle-bump baseline promotion"
status: ready
sprint: current
priority: critical
horizon: m
feasibility: medium
task_type: ci-fix
area: ci
created: 2026-07-17
related: [3227, 3303, 3111, 3161, 1668]
origin: "the #3227/#3201 oracle v6→v7 honest-drop baseline cannot promote — the catastrophic guard step invokes diff-test262.ts BARE with no REGRESSIONS_ALLOW_FILE, so #3227's sanctioned regressions-allow:1100 (actual 1020<1100) is not honored"
---

# #3344 — Catastrophic regression guard must honor the regressions-allow ceiling

## Problem

The **"Catastrophic regression guard (#1668)"** step in
`.github/workflows/test262-sharded.yml` (the push / workflow_dispatch /
merge_group promote path, ~lines 700–745) invokes `scripts/diff-test262.ts`
**without** setting `REGRESSIONS_ALLOW_FILE` (and with no repo-variable or
workflow_dispatch-input path to supply it). So the **#3303 regressions-allow
mechanism** — a per-issue ceiling in the issue frontmatter that supersedes
drift-tolerance + bucket checks, verified working locally — is **inert for
the promote job**.

Consequence: a legitimate **oracle-version bump** (v6→v7 for #3227/#3201's
async post-drain honesty correction) produces exactly the sanctioned
reclassification shape (net −650, 1020 regressions, all the documented
async-gen `yield*` cluster), which #3227's frontmatter declares
`regressions-allow: { count: 1100 }` for — but the catastrophic guard can't
see it, so the baseline **cannot promote**, the public conformance number
stays stale at the pre-honesty oracle-6 figure, and the merge queue stays
oracle-skewed. `force_baseline_refresh` only bypasses the *separate*
fine-grained "check for test262 regressions" job, NOT this coarse guard.

Hand-verified data (from run 29567617728 merged-report artifact,
oracle_version=7): JS-host **32,138 / 43,106** (−650 from 32,788), standalone
**24,711 / 43,106** — the expected honest drop. So this is purely a CI-wiring
gap, not a real regression.

## Fix

Wire the regressions-allow discovery into the catastrophic-guard step so it
honors the same sanctioned ceiling the fine-grained gate does. Preferred:
**auto-discover** the `regressions-allow` declaration from the issue file(s)
added/changed on the merge commit (so no manual env wiring per-bump is
needed) — OR, minimally, add a `REGRESSIONS_ALLOW_FILE` workflow input / repo
variable path for the promote job. Confirm earlier oracle bumps (#3161 v5,
#3111) either stayed under the guard's catastrophic threshold or promoted via
a path that needs the same fix.

## Acceptance

- The #3227/#3201 v6→v7 baseline promotes cleanly (oracle_version==7 live on
  loopdive/js2wasm-baselines, JS-host ~32,138) with the async-cluster
  regressions excused by the #3227 ceiling — no hand-push, no gate bypass.
- The catastrophic guard still fails on a genuine regression that lacks a
  declared ceiling (add a test / dry-run proving it isn't just neutered).
- Doc the mechanism so the next oracle bump promotes without manual steps.

## Non-goals
- Do NOT hand-push a baseline to js2wasm-baselines (bypasses CI validation).
- Do NOT lower/disable the catastrophic guard globally.
