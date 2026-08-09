---
id: 3462
title: "test262: two-baseline + fast-oracle-lane plumbing (oracle_lane stamp, diff-test262 guard, fast baseline fetch)"
status: done
completed: 2026-07-23
sprint: Backlog
priority: high
horizon: m
task_type: ci
area: ci
goal: maintainability
parent: 3450
---

# test262: two-baseline + fast-oracle-lane plumbing

Child (b) of the #3450 HYBRID two-oracle pipeline. Full spec:
`plan/design/3450-hybrid-two-oracle-plan.md` §2.

## Problem

The fast lane must gate fast-vs-fast so the ~9,244 native-harness boundary flips
are baked into a fast baseline ONCE and never false-fail a PR. That needs a
distinct oracle identity so `diff-test262` refuses to compare a fast candidate
against the honest v8 baseline (and vice-versa).

## Scope

- `tests/test262-oracle-version.ts`: keep `ORACLE_VERSION = 8`; add
  `ORACLE_FAST_REV = 1` + an `ORACLE_FAST_HISTORY` entry (native-harness verdict
  boundary). Independent axis from the honest integer — do NOT reuse "9".
- `tests/test262-shared.ts` `recordResult` (~347): stamp
  `oracle_lane: "honest" | "fast-nativeharness"` (default honest, absent ⇒
  honest); when fast, also stamp `oracle_fast_rev`. Select from
  `TEST262_ORACLE_MODE` + target (fast+host ⇒ fast; else honest — standalone
  always honest v8).
- `scripts/diff-test262.ts`: refuse to diff unless `oracle_version` AND
  `oracle_lane` (+ `oracle_fast_rev` when fast) match, unless `ORACLE_REBASE=1`.
- `scripts/fetch-baseline-jsonl.mjs`: add `FAST_BASELINE_REMOTE_URL` +
  `FAST_BASELINE_CACHE_PATH` + `ensureFastBaselineJsonl()` for
  `test262-fast-current.jsonl` (host only) in `loopdive/js2wasm-baselines`.

## Acceptance criteria

1. Fast-mode host rows carry `oracle_lane: fast-nativeharness` + `oracle_fast_rev`;
   honest/standalone rows carry `oracle_lane: honest` (or omit) + `oracle_version: 8`.
2. `diff-test262` refuses fast-vs-honest without `ORACLE_REBASE=1`; accepts
   fast-vs-fast and honest-vs-honest.
3. `fetch-baseline-jsonl.mjs` exposes fast-baseline fetch with the existing
   graceful-fallback semantics.
4. Existing honest baselines + consumers byte-unaffected (additive field).
