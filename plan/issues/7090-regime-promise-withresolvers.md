---
id: 7090
title: "Regime gap: `Promise.withResolvers()` has no native implementation (refused on gc, standalone and WASI)"
status: in-progress
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: Promise
goal: architecture
sprint: current
parent: 5385
related: [6979, 7089]
---

# #7090 — `Promise.withResolvers()` on the native regime

Found by the S7-c slice of #6979 (2026-10-16, branch
`issue-6979-s7c-collapse-standalone-arms`, WASI flip verdict): after WASI
moved onto the native regime, test262 `built-ins/Promise/withResolvers/
promise.js` fails on every WasmGC lane because the regime refuses
`Promise.withResolvers()`. The old WASI lowering produced a binary with no
`withResolvers` at all (it silently compiled the call away), so this is a
pre-existing hole that the flip made visible, not a regression of a passing
row. It is the only GAP the S7-c directory folds found.

## Plan

1. Measure: which refusal diagnostic fires, on which lanes (default gc,
   native-first, standalone, WASI), and which test262 rows under
   `built-ins/Promise/withResolvers/` pass/fail before the fix (standalone
   lane, `TEST262_PATH_FILTER=built-ins/Promise/withResolvers/`).
2. Implement on the native promise provider: `withResolvers` = create a
   pending native promise, return a plain object `{ promise, resolve, reject }`
   whose `resolve`/`reject` are the capability functions (same machinery as
   `new Promise(executor)` without running an executor). The `.call(Sub)`
   subclass form is #7089's scope; here `this === %Promise%` only, with a
   TypeError for a non-constructor `this` per spec step 1.
3. Tests: a focused test under native-first (JS environment) and standalone
   comparing with Node; the test262 subset count before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; direct-AST freeze respected (provider/runtime code only).
