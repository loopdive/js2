---
id: 7101
title: "Regime gap: `Promise.allSettled.call(C, [thenable])` with a plain-function `C` throws on the native regime; Node returns normally"
status: ready
created: 2026-10-20
updated: 2026-10-20
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: Promise
goal: architecture
sprint: current
parent: 5385
related: [7089, 6979, 1528]
---

# #7101 — combinator with a plain-function capability constructor and a thenable element

Found by the S7-a landing (2026-10-20) while re-pinning
`tests/issue-1528-closure-construct.test.ts` on the default profile. On the
native regime (default gc, native-first, standalone) a call such as

```ts
function C(executor) { executor((v) => {}, (e) => {}); }
Promise.allSettled.call(C, [{ then(r) { r(1); } }]);
```

throws where Node returns the capability's result. #7089 (PR 6773) made
`NewPromiseCapability(C)` construct through an ordinary function or compiled
class for the combinators, so the remaining failure is the combination of a
plain-function constructor with a *thenable* element: the element's `then`
is invoked through the capability's resolve path, which for a non-%Promise%
capability does not go through the native thenable job. This behaves the
same on main's default profile before S7-a, so it is a pre-existing gap,
not a regression of the slice.

## Plan

1. Measure: a `.tmp` probe on native-first (JS environment via
   `wrapCompiledExports`) and standalone against Node — `all`, `allSettled`,
   `race`, `any` with `.call(C, …)` where `C` is a plain function, a compiled
   class extending Promise, and `Promise` itself; elements a settled native
   promise, a thenable object, and a plain value. Record which cell traps and
   the trap site (`src/codegen/promise/receiver-capability.ts`, the
   thenable job in the native provider, or the element iteration).
2. Fix in the native promise provider: a thenable element resolved through a
   custom capability must enqueue the same PromiseResolveThenableJob the
   %Promise% path uses; keep the `C === %Promise%` fast path byte-identical.
3. Tests: extend `tests/issue-7089-regime-promise-subclass-combinators.test.ts`
   with the plain-function + thenable rows on both lanes vs Node.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; `check:host-import-policy` unchanged.
