---
id: 2099
title: "promote-baseline must re-run (not carry forward) poison-classified rows"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dev-b
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: testing
language_feature: n/a
goal: correctness
related: [2095]
origin: "2026-06-11 analysis program (report 06 §5); stub 08-C14 — alternatively extend #1862"
---

# #2099 — phantom failures persist across promotions

## Problem

Phantom `Binary emit error` rows from poisoned compiler workers can
persist across baseline promotions (the historical drift class): once a
poisoned result enters the baseline, every later promotion carries it
forward, and the #1862 in-review work left its acceptance boxes 2–3
(promotion-time re-run) unchecked.

## Root cause

The `promote-baseline` job carries rows matching `POISON_ERROR_RE` forward
instead of re-running them (#1862 investigation item 3, unimplemented).

## Plan

In promote-baseline: collect rows matching the poison signature, re-run
just those tests serially (clean worker), promote the re-run results.
Alternatively reopen/extend #1862 — coordinate with its in-review PR
before starting.

## Acceptance criteria

- A synthetic poisoned row is healed by the next promotion
- Promotion wall-clock increase bounded (< 2 min for current poison count)

## Dupe check

#1862 (in-review) covers the residual burst analysis; the promotion-time
re-run is its unimplemented item 3 — filed so it isn't lost if #1862
closes. New (analysis program).

## Resolution (2026-06-16, dev-b)

Implemented #1862 item 3 as a standalone, unit-testable script wired into the
promote-baseline job:

- **`scripts/heal-poison-rows.ts`** — reads a merged JSONL, collects rows whose
  error matches the shared `POISON_ERROR_RE` (`scripts/test262-poison-error.mjs`)
  and re-runs JUST those tests serially in a clean in-process compiler via
  `runTest262File`. A re-run that now passes/skips (or fails for a NON-poison
  reason) replaces the phantom row (status/error rewritten, stale
  error_category/signature dropped, `poison_healed: true` breadcrumb added); a
  re-run that STILL trips the poison signature is left as-is (genuine resource
  limit, not contamination). `pass`/`skip` rows are never poison candidates.
  Supports `--target standalone`, `--max-heal N`, `--quiet`; `--in`/`--out` may
  be the same path.
- **`test262-sharded.yml` promote-baseline job** — new step (after artifact
  download, before promotion) sets up pnpm + deps and heals both the host and
  standalone merged JSONLs, then rebuilds the merged report JSONs so the
  promoted summary counts reflect the healed rows. The job already checks out
  the test262 submodule recursively.

Serial + in-process is intentional: poison counts are small, so the wall-clock
cost is bounded (acceptance: < 2 min) and a single clean process is the
cleanest possible worker.

Tests: `tests/issue-2099.test.ts` (4 cases — phantom Binary-emit-error healed
to true verdict via a real passing test262 file; non-poison rows passed
through byte-for-byte; nothing-to-heal report; pass row with stray poison-text
error not treated as poison). All pass.

**Acceptance:**
- [x] A synthetic poisoned row is healed by the next promotion
- [x] Promotion wall-clock increase bounded — re-run is serial over the small
  poison set only; single-row heal measured at ~0.7s locally.

## Follow-up (2026-06-17, dev-2) — heal step crashed the promote-baseline job

The heal feature itself froze the baseline (~16h stale; every PR's
`check for test262 regressions` gate blinded). Root cause: a poison row for a
`dynamic-import` test
(`test/language/expressions/dynamic-import/import-attributes/2nd-param-with-non-object.js`,
classified poison by the `Maximum call stack size exceeded` signature) was
selected for healing. Its clean-process re-run drives Node's
`importModuleDynamicallyCallback` into a runaway "Maximum call stack size
exceeded" and emits the rejection as a **deferred** microtask — AFTER the
per-test `await` settled and after `main()` had finished writing the healed
JSONL. That deferred error landed OUTSIDE the per-test try/catch as an
uncaught exception, flipping the process exit code to 1 and failing the
`promote merged report to main baseline` job (so the js2wasm-baselines JSONL
was never updated).

Fix (`scripts/heal-poison-rows.ts`):
- `installDeferredErrorGuards()` — `process.on("uncaughtException"/
  "unhandledRejection")` log-and-swallow handlers, honouring the script's
  documented "exit 0 unless args malformed / input unreadable" contract. A
  contaminating re-run must never block promotion; the affected row is already
  left as-is (still-poison) by the loop before the deferred error fires.
- `main().then(() => process.exit(0))` behind an `INVOKED_AS_SCRIPT` entry
  guard — forces a clean exit after the durable write so a lingering
  microtask/timer can neither keep the loop alive nor flip the exit code. The
  entry guard also makes the module importable for the regression test.

Regression test: `tests/issue-2099.test.ts` 5th case — runs the real
`installDeferredErrorGuards` in a child process, fires both deferred-error
shapes, and asserts exit 0 (a no-guard child exits 1, confirmed).
