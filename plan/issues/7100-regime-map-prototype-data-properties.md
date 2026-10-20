---
id: 7100
title: "Regime gap: a `Map`'s `constructor` and `Symbol.toStringTag` are never answered on the native lanes (every read form, `typeof` and truthiness included)"
status: ready
created: 2026-10-20
updated: 2026-10-20
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: Map
goal: architecture
sprint: current
parent: 5385
related: [7092, 7099, 6979]
---

# #7100 — `Map.prototype` data properties on a native receiver

Found by #7099 (2026-10-20) as a control row. On native-first (JS
environment) and standalone, `m.constructor`, `m.constructor === Map`,
`m[Symbol.toStringTag]` and `Object.prototype.toString.call(m)` for `m = new
Map()` are wrong in every form, including `typeof m.constructor` and `!!m.
constructor`, before and after the #7092/#7099 promise fixes: the native Map
provider's dynamic read answers only its methods (`get`, `set`, `has`, …) and
`size`; the prototype's data properties fall through to "no such member".
`Set` (and likely `WeakMap`/`WeakSet`) should be measured in the same step.

## Plan

1. Measure: a `.tmp` probe on native-first (via `wrapCompiledExports`) and
   standalone against Node for `Map`, `Set`, `WeakMap`, `WeakSet`: the four
   reads above, `"constructor" in m`, `Object.keys(m)`, a user-written
   `Map.prototype.foo = 1` read, and `m.constructor === undefined`; the test262
   rows under `built-ins/Map/prototype/` and `built-ins/Set/prototype/` that
   mention `constructor` or `toStringTag`, standalone lane, before.
2. Implement in the collection providers' dynamic-read arms (the same shape
   as #7092's `$Promise` arm): `constructor` answers the intrinsic
   first-class value (`Map` / `Set` / …) unless the program touched the
   prototype's own-property table, `Symbol.toStringTag` answers the class
   name; unknown names keep the prototype-chain walk. No new direct-AST
   emitter semantics; keep binaries that never read those members
   byte-identical.
3. Tests: a focused test under native-first and standalone vs Node; the
   test262 subset before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; `check:host-import-policy` unchanged.
