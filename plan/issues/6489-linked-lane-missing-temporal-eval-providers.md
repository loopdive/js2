---
id: 6489
title: "test262 linked shadow job does not download the Temporal and runtime-eval providers — ~1,300 rows differ for that reason alone"
status: done
sprint: current
created: 2026-09-16
updated: 2026-09-16
completed: 2026-09-16
assignee: ttraenkler/senior-dev
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infra
area: ci
goal: test262-conformance
depends_on: [6486]
related: [3451, 5353, 6486]
---

# #6489 — linked job lacks the provider downloads

## Problem (first full-corpus run, 2026-09-16, run 35116762391)

`test262-linked` (`.github/workflows/test262-sharded.yml`, added by #6486 on the
`test262-native-first` template) has neither the `JS2WASM_TEMPORAL_CACHE`
env nor the two steps every host shard job has:

- `Download compiled Temporal provider (#5353)`
- `Download selected runtime-eval provider (#2928/#4242)` (+ the verify step)

So in the linked lane `msg.temporal` rows found no provider
(`getWorkerTemporalProvider` → null) and ran without `Temporal`. The parity
report's largest buckets are exactly that: `Temporal is not defined` 713,
`Cannot read properties of null (reading 'since'|'until'|'toString'|'equals'|'subtract'|'catch')`
~340, `since|until|round|total is not a function` ~175, plus most of the
`Expected a RangeError but got a TypeError` 154+37+25+25. Eval-dependent rows
are affected the same way by the missing runtime-eval provider.

Note the worker order in `doCompile` (`scripts/test262-worker.mjs` ~L1445 vs
~L1468): a Temporal row takes the honest `compileWithTemporalGlobal` branch
BEFORE the linked branch, so with the provider present those rows are honest
rows inside the linked run (stamped `linked-harness`, though — the stamp should
say so; see plan step 3).

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

1. In `test262-linked`: add the `JS2WASM_TEMPORAL_CACHE: .test262-cache/temporal`
   env and the `needs:` entries / download+verify steps copied verbatim from
   `test262-shard` (~L189–240: Temporal provider download, runtime-eval
   provider download, verify shared runtime-eval provider cache). Keep the
   `if:` gate of the job unchanged.
2. Same for any other env the host job sets and the linked job lacks — diff
   the two `env:` blocks and list every difference in the issue; copy only
   what the honest lane has, never add lane-specific knobs.
3. Stamp honesty: a row that took the Temporal (honest) branch inside a
   linked run is not a linked measurement. In `doCompile`, when the Temporal
   branch wins while `linkedHarness` is set, mark
   `linkedHarness.fellBack = true` with reason `temporal row: honest compile
   (compileWithTemporalGlobal)` so the parity report counts it as a fallback,
   not as agreement. (A real linked+Temporal co-link is a later slice.)
4. Validate structurally (yaml parse, job graph unchanged for required checks)
   and with `tests/issue-6486-linked-parity-report.test.ts`.

## Acceptance

- [x] Next `linked_lane` dispatch: `Temporal is not defined` bucket = 0; the
      Temporal rows appear as fallbacks with the new reason (run 35144322208:
      4,611 `temporal row: honest compile` fallbacks, bucket gone).
- [x] Required checks and `docs/ci-policy.md` untouched.

## Implementation notes (2026-09-16, Opus lane)

Branch `issue-6489-linked-job-providers`.

### What changed

1. `.github/workflows/test262-sharded.yml`, `test262-linked`:
   - `env: JS2WASM_TEMPORAL_CACHE: .test262-cache/temporal` (verbatim from
     `test262-shard`).
   - Three steps copied verbatim after `Build compiler bundles`:
     `Download compiled Temporal provider (#5353)`,
     `Download selected runtime-eval provider (#2928/#4242)`,
     `Verify shared runtime-eval provider cache (#2928/#4242)`.
   - `needs: [temporal-provider]` — the only `needs:` the copied steps require
     (the artifact `temporal-provider-${{ github.run_id }}` is produced there).
2. `.github/workflows/test262-sharded.yml`, `temporal-provider`: added a
   `github.event_name == 'schedule'` arm to its `if:`. **Required**, not
   cosmetic: the linked lane runs on `schedule`, and without this arm the
   provider job is skipped there and `test262-linked` cascade-skips through the
   new `needs:` edge. On `schedule` the `changes` job is skipped, so its outputs
   read empty and `run_host != 'false'` holds — the host provider is built,
   which is the right answer for a host-only lane. No other job gains a `needs:`
   edge and the provider job remains unreferenced by any required check.
3. `scripts/test262-worker.mjs`, `doCompile` Temporal branch: when that branch
   wins while `linkedHarness` is set, it now sets
   `linkedHarness.fellBack = true` and
   `fallbackReason = "temporal row: honest compile (compileWithTemporalGlobal)"`.
   The descriptor is built fresh per row (worker ~L1895) and consumed by
   `noteLinkedFallback` on both the success and throw paths, so the parity
   report counts those rows as fallbacks rather than as linked agreement.

### Full `env:` diff, `test262-shard` vs `test262-linked` (plan step 2)

Machine-diffed with a YAML parse of the workflow. Keys only in `test262-shard`:

| key | honest value | decision |
| --- | --- | --- |
| `JS2WASM_TEMPORAL_CACHE` | `.test262-cache/temporal` | **COPIED** — this was the bug. |
| `JS2WASM_EVAL_ENGINE` | `''` on a `gc` cell (standalone-gated) | **not copied** — the honest host lane's value is the empty string, identical to absence. |
| `TEST262_FULL_RUNTIME_EVAL` | `''` on a `gc` cell | **not copied** — same, empty on host. |
| `TEST262_IT_TIMEOUT_MS` | `''` on a `gc` cell | **not copied** — same, empty on host (host keeps the 90 s default). |
| `TEST262_PATH_FILTER` | `needs.changes.outputs.test262_scope` | **not copied** — it would require `needs: changes`, and `changes` has no `schedule` arm, so the cron linked lane would cascade-skip. It is empty on `workflow_dispatch` anyway (the only other arm), so copying it buys nothing and costs the cron lane. Deliberate, recorded difference. |

Keys only in `test262-linked`: `TEST262_ORACLE_MODE: linked` (the lane itself).
Differing values, both intentional and lane-identifying: `RUN_TIMESTAMP`
(`…-linked-chunk…`), `TEST262_RESULT_PREFIX` (`test262-linked`), `TEST262_TARGET`
(fixed `gc` vs the matrix value). All remaining keys are byte-identical.

### Correction to the Problem statement above

The eval-provider half of the diagnosis does not hold as written. The honest
`Download selected runtime-eval provider` / `Verify …` steps are gated
`matrix.target.test262_target == 'standalone'`, so **the honest host lane never
downloads a runtime-eval provider either** — the linked lane was not behind the
honest lane on that axis, and eval-dependent host rows cannot have differed for
this reason. The two steps are still copied in (gated `env.TEST262_TARGET ==
'standalone'`, i.e. inert on this `gc`-only job) so the provider block stays a
verbatim copy of the honest one and the lane difference is visible rather than
silent. Only the Temporal provider was genuinely missing.

### Validation

- YAML parse of the whole workflow with `yaml@2.8.3` from `node_modules`, plus a
  transitive `needs:` closure over the required checks' jobs: `merge-report`
  (`merge shard reports`), `regression-gate` (`check for test262 regressions`),
  `gate` (`cheap gate (main-ancestor + lint)`) and `promote-baseline` — none
  reach `test262-linked` or `merge-linked-report`. `quality`, `equivalence-gate`
  and `cla-check` live in other workflows and are untouched. `docs/ci-policy.md`
  untouched.
- `tests/issue-6486-linked-parity-report.test.ts`,
  `tests/issue-3462.test.ts`, `tests/issue-3451-linked-harness-lane.test.ts` —
  24 tests pass.
- Source ratchet gates + `typecheck` + `lint` green.

### What canNOT be validated in-container

The acceptance criteria are properties of a live dispatch: the artifact
download, the provider stamp match inside a runner, the `Temporal is not
defined` bucket going to 0, and the Temporal rows surfacing under the new
fallback reason. That needs the next `linked_lane` `workflow_dispatch` run,
which the lead dispatches. Status stays `in-progress` until that run is read.

## Second-run finding (2026-09-16, run 35144322208, main @ c55be108e0)

The dispatch after PR #5948 landed replaced the `Temporal is not defined`
bucket with a new one: `assert is not defined` 2,000 and `TemporalHelpers is
not defined` 723 — every Temporal row in the linked lane, now correctly stamped
as a fallback, failed on a MISSING HARNESS. Cause: in a linked run `source` is
the body-only unit (the provider carries the harness prefix), and the Temporal
branch of `doCompile` passed that `source` straight to
`compileWithTemporalGlobal`, while the linked fallback three lines below
reconstructs `linkedHarness.harnessPrefix + source`. Fix (this PR):
`temporalSource = linkedHarness ? linkedHarness.harnessPrefix + source : source`.

Measured in-container with the real runner (`tests/test262-chunk-dynamic.test.ts`,
`TEST262_ORACLE_MODE=linked`, chunk 0/1, host Temporal provider pre-warmed),
three Temporal rows (`PlainTime/prototype/hour/basic.js`,
`PlainDate/prototype/monthsInYear/basic.js`,
`Duration/prototype/negated/branding.js`): base worker = 3× `fail: assert is not
defined`; fixed worker = 3× `pass`, all three stamped `temporal row: honest
compile`. Expected on the next dispatch: those two buckets → 0, linked pass up by
roughly the ~2,700 rows they cover, agreement ≈ 97 %.

Two dispatch-path findings, not this issue's to fix:

- `skip_promote=true` refuses without `baseline_commit`, and with the
  `js2wasm-baselines` tip (`cef61fae`) the admit step fails on a missing
  `test262-baseline-pair.json`, so the honest shard matrix cascade-skips and
  the parity report is empty (runs 35135251334, 35140160393). A measurement
  dispatch on the main tip therefore has to run WITHOUT `skip_promote` (a
  re-promotion of the tip is a no-op).
- Artifact downloads (`*.blob.core.windows.net`) are blocked from the agent
  container, so the parity summary is read from the `merge linked evidence` job
  log, which prints it in full.
