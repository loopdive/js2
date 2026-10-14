---
id: 6983
title: "Native regime in a JS environment regresses acorn, lit, prettier on npm-compat versus the host lane"
status: in-progress
assignee: ttraenkler/opus-6983-npm
created: 2026-10-14
updated: 2026-10-14
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: compiler, optimizer
language_feature: compiler-internals
goal: architecture
sprint: current
parent: 5385
related: [6708, 6749, 6979]
---

# #6983 — native-first regime npm-compat parity (S6 evidence item 3)

The dashboard refresh of 2026-10-14T15:10Z (`perf.lanes.jsHostNative` in
`benchmarks/results/npm-compat.json`) shows three packages that are
`measured` on the host-assisted lane but fail on the `js-host-native` lane
(`semanticProviders: "native-first"`). #6708 S6 evidence item 3 requires that
the regime not regress any package from `measured` to an error state.

| package | host lane | regime lane | diagnostic |
|---|---|---|---|
| acorn | measured | runtime-error | `RuntimeError: illegal cast` |
| lit | measured | runtime-error | `[object WebAssembly.Exception]` reaches the host |
| prettier | measured | optimization-error | `wasm-opt -O4` "unexpected expr type / UNREACHABLE executed"; no-flatten retry times out |

lodash-es (regime `optimization-error`, same wasm-opt crash) is in scope if it
shares the root cause.

## Acceptance criteria

- acorn, lit, prettier `measured` on a local
  `generate-npm-compat-report.mjs --only <pkg> --perf-only --lane js-host-native` run.
- `node scripts/equivalence-gate.mjs`: no new equivalence regressions.
- A focused regression test per root cause (native-first and standalone).

## Root causes and measurements

(in progress)
