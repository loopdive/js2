---
id: 7247
title: "Regime gap: a caller-owned host `DataView` passed into an `any` parameter is not admitted by the native member call (`getUint8 is not a function`)"
status: ready
created: 2026-11-05
updated: 2026-11-05
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: DataView
goal: architecture
sprint: current
parent: 5385
related: [4397, 6979, 7102]
---

# #7247 — caller-owned DataView through the value boundary

Found by the S7-b fix-on-touch pass (2026-11-05) in
`tests/issue-4397-native-semantic-js-host.test.ts`, row "keeps DataView
window and byte semantics in Wasm while admitting caller-owned views"
(marked `it.fails` on PR 6705; fails on main before and after S7). Native
DataViews created inside the module work; a `DataView` the host constructs
and passes into `readBoundary(view: any)` reaches the regime's dynamic
member call as an unrecognised carrier and `view.getUint8(0)` throws
`getUint8 is not a function`. The receiver-side twin of #7102 (host
function-constructor instances across the boundary).

## Plan

1. Measure: a `.tmp` probe under native-first via `wrapCompiledExports`
   passing a host `DataView`, `Uint8Array`, `ArrayBuffer` and `Map` into an
   `any` parameter and calling a method / reading a property; against Node;
   record which arrive as recognised carriers and which as opaque host refs.
2. Fix: the value adapter wraps a host buffer view into the native DataView /
   TypedArray carrier on entry (sharing the bytes, as the standalone-side
   views already do), or the dynamic member call dispatches host buffer views
   through the platform-capability path; keep in-module views byte-identical.
3. Tests: turn the `it.fails` row back into a normal row; add the probe
   matrix.
4. Acceptance: equivalence gate "No new equivalence regressions"; no new
   host import.
