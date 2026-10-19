---
id: 7094
title: "Regime gap: `r += await p.then(f, g)` on a rejected `p` answers 0 on both native lanes"
status: ready
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: async/await
goal: architecture
sprint: current
parent: 5385
related: [7089, 6982, 6979]
---

# #7094 — compound assignment of an awaited `then(f, g)` on a rejected promise

Found by #7089 (2026-10-19) while testing combinator rows; it is not specific
to the combinators. On native-first (JS environment) and standalone:

```ts
let r = 0;
const p = Promise.reject(new Error("x"));
r += await p.then((v) => 1, (e) => 2);
// Node: r === 2.  Native lanes: r === 0.
```

The awaited value of the `then` call with a rejection handler is lost when
the await sits inside a compound assignment: the right operand reads as 0.
The plain form `const v = await p.then(f, g); r += v;` is not yet
measured and must be part of the first step.

## Plan

1. Measure: a `.tmp` probe matrix: `r += await <expr>` with `<expr>` ∈
   {`p.then(f, g)` on rejected `p`, `p.then(f)` on resolved `p`,
   `p.catch(g)`, a plain resolved promise}; the two-statement form; `r = r +
   await …`; on native-first and standalone against Node. Record whether the
   defect is in the async-CPS resume slot for the compound-assignment RHS,
   in the `then(f, g)` rejection handler's return value, or in the
   onRejected result settling the derived promise.
2. Implement in the native promise provider / async scheduler (shared
   runtime, not direct-AST bodies): the defect's actual site from step 1.
3. Tests: a focused test under native-first and standalone comparing with
   Node; the test262 rows under `built-ins/Promise/prototype/then/` that
   reject and `language/expressions/await/` with compound assignment,
   before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import.
