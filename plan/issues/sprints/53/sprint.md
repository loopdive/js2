---
sprint: 53
status: planning
created: 2026-05-20
planned: 2026-05-20
baseline_pass: 28168
baseline_total: 43160
baseline_pct: 65.3
---

# Sprint 53 Planning

## Sprint Goal

Land the async-model groundwork (close the long-tailed async/await + Promise gap)
while clearing the structural Wasm-closure bridge and Wasm-native runtime
primitives that block standalone-mode and host-independence. Carry forward the
five S52 issues that never received a PR.

Secondary: clear the host-independence epics (#1470-#1474) that are sitting
in-progress without merge so the standalone track can move from "implemented"
to "validated".

## Baseline at planning

- 28,168 / 43,160 pass (65.3 %)
- ~60 open PRs from S52 - most are spec-completeness fixes already in flight
- Carry-forward: 5 S52 issues are `status: ready` with no PR open

## Issue Table

| id    | title                                                       | priority | feasibility | est_impact (FAIL / strategic) | goal             |
|-------|-------------------------------------------------------------|----------|-------------|-------------------------------|------------------|
| 1373  | IR: claim async functions through IR path                   | medium   | hard        | unlocks #1373b + async coverage | async-model      |
| 1373b | IR async Phase C: CPS lowering for await/throw/return       | medium   | hard        | strategic (blocked on #1373)   | async-model      |
| 1382  | Wasm closures not JS-callable from host imports             | high     | hard        | structural (unblocks #1339/#1358/#1311) | ir-full-coverage |
| 1394  | class method-closure caching stable singleton               | high     | hard        | unblocks ESLint runtime + perf  | spec-completeness |
| 1400  | npm: compile ESLint package entry to valid Wasm             | high     | medium      | proves npm-realworld pipeline  | npm-library-support |
| 1387  | feat: with-statement architect exploration                  | medium   | hard        | ~50 FAIL + spec coverage       | spec-completeness |
| 1042  | async/await state-machine lowering (AwaitExpression no-op)  | high     | hard        | ~210 FAIL + correctness        | async-model      |
| 1116  | Promise resolution and async error handling                 | critical | hard        | 210 FAIL                       | async-model      |
| 1151  | Async function synchronous throws bypass Promise.reject     | high     | hard        | ~80 FAIL                       | async-model      |
| 1103  | Wasm-native Map / Set / WeakMap / WeakSet                   | high     | hard        | unblocks standalone iterator   | iterator-protocol |
| 1105  | Wasm-native String method implementations                   | high     | hard        | unblocks WASI String coverage  | standalone-mode  |
| 1089  | codegen: dynamic import() expressions                       | medium   | hard        | 429 currently-skipped tests    | async-model      |
| 1130  | Array methods getter-observing property access              | medium   | hard        | ~120 FAIL                      | property-model   |
| 1129  | ToObject (§7.1.18) — primitive auto-boxing                  | medium   | hard        | broad coercion fidelity        | core-semantics   |
| 1352  | RegExp exec result wasmGC string vs externref equality      | medium   | medium      | ~50 FAIL S15.10.2 cluster      | spec-completeness |

## Carry-forward from Sprint 52

The following S52 issues are `status: ready` and have **no open PR** as of
2026-05-20 — they must be re-claimed in S53:

- **#1373** — IR async function (no agent ever picked it up; architect spec still needed)
- **#1373b** — IR async CPS lowering (blocked on #1373; re-open once #1373 lands)
- **#1382** — Wasm closure / host-import bridge (structural; architect-grade)
- **#1394** — Method-closure caching (depends on #1388, architect-grade)
- **#1400** — ESLint entry-point compiled module validity
- **#1387** — `with` statement architect exploration (was `moved-to-s52` — needs status reset to `ready`)

The 41 other S52 ready/in-progress issues either have an open PR or are
already in-progress in a worktree; treat them as inherited WIP. Sprint 52
will be wrapped up via the normal PR queue; do **not** re-claim any of those
issues into S53 until S52 is officially closed.

## In-progress carry-over (do not re-dispatch — finish via existing PRs / worktrees)

These are flagged `in-progress` in S52. If their PR has not landed by the time
S53 starts, the existing dev or skill resumes; the sprint table above does NOT
include them as new work.

- #1364 class element descriptor fidelity (PR #366)
- #1431, #1433, #1435, #1436, #1438, #1443, #1445, #1450, #1460, #1467, #1468 — spec-gap fixes (all have open PRs)
- #1470-#1474 — host-independence epics (in-progress, no PR yet visible — needs status audit at S53 start)
- #1505 — spec audit (research; rolling)
- #1511, #1513, #1514, #1515, #1516, #1519 — spec-gap fixes (all have open PRs)
- #1520 — Static Hermes comparison (research/docs)

## Notes

### Architectural pre-work needed before dispatch

- **#1373** + **#1373b**: architect spec required (IR async function and CPS
  lowering — touches core IR, must coordinate with #1042 state-machine lowering).
  Recommend single architect spec covering #1373, #1373b, and #1042 jointly so
  the three async strategies stay coherent.
- **#1382**: architect spec required (Wasm-closure / host-import bridge — touches
  ABI between codegen and runtime imports; must define the funcref/struct
  shape exposed to host).
- **#1394**: architect spec required (must not regress #1388 perf path).
- **#1103**, **#1105**: architect spec required (Wasm-native runtime primitives
  — coordinate with host-independence epics #1470-#1474).

### Dependencies to watch

- #1373b blocks on #1373 — keep them sequential, single dev.
- #1042 / #1116 / #1151 form an async-model cluster — best assigned to one dev
  or to architect+dev pair to avoid conflicting solutions.
- #1394 depends on #1388 (already merged) — ready to spec.
- Host-independence #1470-#1474 currently `in-progress` with no visible PRs —
  audit on day 1 of S53. If they are stale, reset to `ready` and re-dispatch.

### Risks

- Async cluster (#1373, #1373b, #1042, #1116, #1151) is all `feasibility: hard`
  and overlapping. If we dispatch all in parallel we WILL hit merge conflicts.
  PO recommends: architect spec first, then sequential dev work in one worktree.
- Standalone cluster (#1103, #1105) is hard and large. Consider splitting #1103
  into Map / Set / WeakMap / WeakSet sub-issues at architect-spec time.
- #1400 (ESLint valid wasm) depends on real-world npm compilation correctness;
  may surface new compile_error buckets that are not in scope.

### Sprint sizing

- 6 carry-forward + 9 new = 15 issues total
- Hard-feasibility ratio: 13 / 15 — heavy. PO accepts this because the async
  cluster has the highest expected pass-rate impact and unblocks downstream
  goals (generator-model, async-model, spec-completeness).
- Reasoning_effort distribution: 2 max, 13 high/medium. Plan for 1-2 architect
  agents alongside 3-4 dev agents.

### Out of scope for S53

- #1066 (eval-in-standalone): keep in backlog; depends on Wasm-child-module
  loader work that is not on critical path.
- #1100, #1101, #1102: Wasm-native Proxy / WeakRef / eval. Defer until #1103 +
  #1105 prove the standalone-runtime pattern.
- #1199 (linear-memory backing for typed numeric arrays): performance goal,
  keep in backlog for a perf-focused sprint.

## Definition of Done (sprint-level)

- Async cluster: at least #1042 or #1373 lands with measurable Promise/await
  test coverage improvement; the other receives a merged architect spec.
- #1382 has a merged bridge implementation (even if not all downstream issues
  consume it yet).
- #1394, #1400 closed with PRs merged.
- Carry-forward S52 issues either landed or have explicit `status: blocked` /
  `wont-fix` with documented rationale.
- Net test262 pass-rate up vs baseline (28,168 / 43,160).
