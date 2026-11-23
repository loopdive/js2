---
id: 7458
title: "`scripts/lib/native-eval-boundary-observation.test.mjs` is red on main: a frozen source digest is stale"
status: ready
created: 2026-11-23
updated: 2026-11-23
priority: medium
horizon: s
goal: ci-hardening
sprint: Backlog
related: [7354]
---

# #7458 — `scripts/lib/native-eval-boundary-observation.test.mjs` is red on main: a frozen source digest is stale

## Problem

11 of 12 tests fail with `frozen source digest must actually admit the controls`. The pinned digests were frozen at `bbd1392a4e`; `scripts/test262-fyi-runtime.js` changed afterwards at `aec823d3b4`. One more test fails with `realmCanarySnapshot is not defined`. The file is in no required check, so the failure is silent, and assertions edited later in that file never run.

## Acceptance criteria

- The file passes on main, or the digest pin is replaced by a check that cannot go stale silently (see #7380: no hash pins).
- The file runs in a required check or is deleted.
