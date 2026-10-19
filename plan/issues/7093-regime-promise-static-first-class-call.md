---
id: 7093
title: "Regime gap: a first-class Promise static (`const f = Promise.withResolvers; f.call(Sub)`) throws TypeError instead of constructing through `this`"
status: ready
created: 2026-10-19
updated: 2026-10-19
priority: low
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler, runtime
language_feature: Promise
goal: architecture
sprint: Backlog
parent: 5385
related: [7089, 7090, 6979]
---

# #7093 — first-class Promise statics with an explicit receiver

Found by #7089 (2026-10-19). On the native regime (default gc, native-first,
standalone, WASI) the member-call spellings `Promise.try.call(Sub, fn)`,
`Promise.withResolvers.call(Sub)` and `(Promise.all as any).call(Sub, …)`
now construct through the subclass (`src/codegen/promise/
receiver-capability.ts`). The first-class spelling still does not:

```ts
const f = Promise.withResolvers;
f.call(Sub);           // throws TypeError on every native lane; Node returns a Sub capability
f();                   // TypeError — correct per spec (this is undefined)
```

The builtin value closure that `Promise.withResolvers` evaluates to as a
value has no `this` parameter, so a later `.call(C)` cannot see the
receiver. Fixing it needs the receiver passed in at the value-closure call
sites, which live in the frozen direct-AST emitters
(`plan/method/ir-only-development-freeze.md`), so the fix belongs to the IR
lowering of builtin function values, not to a provider patch.

## Plan

1. Measure: a `.tmp` probe for `withResolvers`, `try`, `all`, `race`, `any`,
   `allSettled` as first-class values with `.call(Sub)`, `.apply(Sub, …)` and
   `Reflect.apply`, on native-first (JS environment) and standalone, against
   Node; the test262 rows under `built-ins/Promise/*/ctx-*` that use the
   first-class form (count before).
2. Implement in the IR: builtin static function values carry a receiver
   slot; `.call`/`.apply`/`Reflect.apply` on them pass it through to the
   `receiver-capability` provider. No direct-AST body changes.
3. Tests: extend `tests/issue-7089-regime-promise-subclass-combinators.test.ts`
   with the first-class rows; test262 subset before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; byte-identity
   for programs that do not take a Promise static as a value.
