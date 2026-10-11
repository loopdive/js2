---
id: 6851
title: "npm-compat: jsdom/webpack still show 'package entry did not produce a runnable Wasm module' — their measure job OOMs in the unbounded native-first lane, so the rows are carried forward stale"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-05
completed: 2026-10-05
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: tooling
goal: standalone
related: [6052, 6660, 6661, 6742, 5385, 4287, 4299]
---

# #6851 — jsdom and webpack never got #6661's real diagnostics

## Problem

`benchmarks/results/npm-compat.json` (CI refresh of 2026-10-05) still shows
`package entry did not produce a runnable Wasm module` on every perf lane of
**jsdom** and **webpack** — the opaque text #6052/#6661 removed. That string
no longer exists in `scripts/`: both rows are **fossils**, `measuredAt
2026-09-08`, `refresh.status: "stale"` ("measurement worker did not produce a
partial report"). The reporting code is right; these two packages are simply
never re-measured.

Why the worker produces no partial — CI logs of `npm-compat-refresh` run
37246523357 (2026-10-05):

| job | after `[npm-compat] <pkg> — bounded published package-entry compile/validate...` |
| --- | --- |
| Measure npm-compat (webpack) | +6.7 min: `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory` (heap 3.8 GB), exit 134 |
| Measure npm-compat (jsdom) | +17.7 min: same OOM (heap 3.9 GB), exit 134 |

The OOM is in the **generator process itself** (the package-entry probe,
upstream suites and standalone lanes all run in children whose output is
captured, not printed). The only package-graph compile left in-process for a
host-blocked package is the **native-first JS-host lane**
(`jsHostNative = await nativeFirstPerfLane(() => runHost("js-host-native"))`,
added 2026-09-07 — one day before both rows froze). For webpack and jsdom the
JS-host package-entry gate has already timed out on the same graph (120 s /
180 s budget), and that lane then compiles it with no budget and inside the
generator's ~4 GB heap. #6661 bounded the two *standalone* lanes in a child
for exactly this case but left the native-first lane in process.

A second, smaller defect: when a bounded lane child dies of OOM, the lane
diagnostic quoted its last output line, which for V8's fatal OOM is a native
stack frame (`10: 0x1269c4e [node]`) — opaque again.

## Implementation Plan

Scripts-only; no compiler source, the JS-host lane's compile input and
options are unchanged (only the process it runs in, and only when the host
gate already blocked).

1. `scripts/lib/npm-compat-perf.mjs`
   - `JS_HOST_NATIVE_PERF_LANE` / `CHILD_PERF_LANES`: the lane table a
     bounded `--perf-only --lane <lane>` child can measure (the two standalone
     lanes + `js-host-native` → `perf.lanes.jsHostNative`, placement js-host).
   - `resolveNativeFirstPerfLane({ hostBlocked, inProcess, inChild })`:
     host-blocked → `inChild("js-host-native")`, else in process.
   - `childLaneFailureDiagnostic(lane, budgetMs, child)`: budget overrun text
     unchanged; a V8 heap exhaustion is named as such; otherwise the last
     output line as before.
2. `scripts/generate-npm-compat-report.mjs`
   - `standaloneLaneInChild` → `perfLaneInChild` (looks the lane up in
     `CHILD_PERF_LANES`, uses the lane's placement, failure text from
     `childLaneFailureDiagnostic`).
   - `perfNpmCompatPackage`: the native-first lane goes through
     `resolveNativeFirstPerfLane` with `perfLaneInChild` and the package's
     harness budget.
   - Phase log lines (`— upstream suite...`, `— perf lanes...`) so a job that
     dies leaves the phase on the CI log.
3. Regression test `tests/issue-6851-npm-compat-native-lane-bounded-child.test.ts`
   (resolver routing, lane table, a real child OOM → named diagnostic with
   the legacy tail as anti-vacuity control, generator wiring).

Acceptance: the next CI refresh writes fresh jsdom and webpack rows (no
`refresh.status: "stale"`), each lane naming its own reason.

## Resolution

Implemented as planned, merged with #6742 (which landed meanwhile and names
the phase of a lane-budget overrun): `perfLaneInChild` uses #6742's
`laneBudgetOverrun` for a timed-out child of any lane, and
`compileNpmCompatPerfLane` now marks `codegen` for every lane child (a no-op
outside a child), so a js-host-native overrun reads `js-host-native lane
exceeded the <budget>ms harness budget during codegen (...)`.

Evidence and its limits:

- **Timing** — the native-first lane (#5385) landed on main with PR #5728 at
  2026-09-08T21:57Z; jsdom/webpack were last measured at 19:13/19:14Z that
  day, the last refresh before it. Every refresh since carried them stale.
- **Attribution is by elimination, not a local reproduction.** On a shared box
  at load average 40-300 none of the local runs finished inside 2 h (webpack
  `--lane js-host-native` in process at a 4 GB heap; webpack and jsdom
  `--lane standalone-dynamic`). The package-entry probe, upstream-suite
  compiles and standalone lanes all run in children with piped output, so the
  printed OOM banner is the generator's own; the native-first compile is the
  only package-graph compile left in it. The new phase log lines make the next
  CI log confirm or refute this directly.

Lane status, before → expected after the first CI refresh on this code
(bounded child budget = the package's harness `timeoutMs`: webpack 120 s,
jsdom 180 s):

| package | lane | before (row of 2026-09-08, stale) | after |
| --- | --- | --- | --- |
| webpack | standaloneDynamic | `package entry did not produce a runnable Wasm module` | its own child result — locally the standalone compile has never finished inside 1500 s (#6661), so expect `standalone-dynamic lane exceeded the 120000ms harness budget during codegen` (#4287) |
| webpack | jsHostNative | (absent) | bounded child: budget overrun or named heap exhaustion |
| jsdom | standaloneDynamic | `package entry did not produce a runnable Wasm module` | its own child result (2026-09-23 local: dynamic-import refusal, since fixed by #3494 — the current blocker is whatever CI's child now reports) |
| jsdom | jsHostNative | (absent) | bounded child: budget overrun or named heap exhaustion |

Real blockers: webpack — package-graph compile time (#4287, open, ready);
jsdom — no fresh measurement exists after #3494; #4299 tracks its package
compile. Neither is a small fix.
