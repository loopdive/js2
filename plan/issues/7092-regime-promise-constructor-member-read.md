---
id: 7092
title: "Regime gap: `(new Promise(executor)).constructor` reads `undefined` — the `$Promise` arm of `__extern_get` only answers then/catch/finally"
status: ready
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
related: [7089, 7090, 6979]
---

# #7092 — `Promise.prototype.constructor` on a native promise receiver

Found while implementing #7090 (2026-10-19, native-first default in a
JavaScript environment and on standalone): a dynamic member read on a native
promise receiver — `p.constructor`, where `p = new Promise(executor)` or the
`promise` field of `Promise.withResolvers()` — evaluates to `undefined`.
The `$Promise` arm of `__extern_get` in
`src/codegen/promise-dynamic-member-read.ts` only answers `then`, `catch` and
`finally`; every other name falls through to the "no such member" result.
Under the retired `host-assisted` profile the host object answered the read.

Observable consequence: test262 rows that assert
`Object.getPrototypeOf(p).constructor === Promise` or call
`p.constructor.resolve(...)` (the species path of `Promise.prototype.then`,
`finally`) fail on every WasmGC lane; the subclass cases are #7089's scope.

## Plan

1. Measure: a `.tmp` probe compiled with `semanticProviders: "native-first"`
   (JS environment, through `wrapCompiledExports`) and with
   `target: "standalone"` reading `p.constructor`, `p.constructor === Promise`,
   `"constructor" in p`, `Object.keys(p)`; the test262 rows under
   `built-ins/Promise/prototype/` that mention `constructor` before the fix
   (standalone lane, `TEST262_PATH_FILTER`).
2. Implement in the promise provider's dynamic read: the `$Promise` arm of
   `__extern_get` answers `constructor` with the intrinsic `%Promise%` value
   (the same reference `Promise` resolves to as a first-class value), and
   `Symbol.toStringTag` with `"Promise"`; unknown names keep falling through
   to the prototype-chain walk the provider already uses for user-touched
   `Promise.prototype` members, so a user `Promise.prototype.foo = …` is still
   found.
3. Tests: a focused test under native-first and standalone comparing with
   Node; the test262 subset count before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; direct-AST freeze respected (provider/runtime code only).
