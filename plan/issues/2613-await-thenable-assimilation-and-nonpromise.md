---
id: 2613
title: "await on a thenable/non-Promise: assimilate via host (PromiseResolve) instead of returning the raw object (~15 fails)"
status: blocked
created: 2026-06-22
updated: 2026-06-24
priority: high
feasibility: hard
task_type: bug
area: async, codegen
language_feature: async
goal: async-model
sprint: Backlog
parent: 1042
depends_on: 1373b
assignee: ttraenkler/async-2612-2613
note: "Premise invalidated 2026-06-22: the spec assumed ASYNC_CPS_ENABLED=false (legacy identity-passthrough await). On current main ASYNC_CPS_ENABLED=true — the CPS state machine now OWNS thenable-await lowering, so this is no longer a JS-host point-fix. Re-routed to #1373b."
---
# #2613 — `await <thenable>` / `await <non-Promise>` must assimilate, not pass the object through

## Investigation result (2026-06-22, ASYNC lane) — BLOCKED on #1373b

The original spec (written when `ASYNC_CPS_ENABLED = false`) planned a JS-host
`__await_thenable` import on the **legacy identity-passthrough** await arm
(`expressions.ts` `ts.isAwaitExpression`). That premise no longer holds:

- **`ASYNC_CPS_ENABLED = true` on current main** (`src/codegen/async-cps.ts:60`).
- For `const v = await <thenable>` (a user thenable / `any` operand), the await
  operand is **not statically resolved** → `asyncFnNeedsCps` returns true →
  `emitAsyncStateMachine` drives the body via `Promise_resolve` →
  `Promise_then2` → continuation. The legacy `compileExpressionInner` await arm
  is **never reached** (confirmed by instrumentation: the arm fires only for
  await shapes `splitBodyAtAwait` rejects, e.g. `return (await x)` in some
  positions).

So a JS-host `__await_thenable` on the legacy arm is largely inert — CPS
intercepts the thenable shapes first. A prototype of that import + the await-arm
route was built and **reverted** (it produced 0 confirmed row flips and added a
new host import + a touch on the hot await path for no gain).

### True root cause of the residual failures — CPS synchronous-settlement gap

The test262 harness runner calls the exported `test()` **synchronously** and
reads `ret === 1` immediately (`tests/test262-runner.ts:3223`) with **no
microtask drain and no `await`**. An `asyncTest(foo)` async body must therefore
complete — including `await thenable` and the assertion after it — synchronously
inside `foo()`. The CPS state machine, by design, defers its continuation to a
later microtask (`Promise_then2`), so the post-await assertion's `__fail` update
lands **after** `ret` is captured → the test reads a stale pass/fail. That is
the `await-awaits-thenables` / `await-throws-rejections` / `*-non-promise-*`
failure mechanism.

Fixing it correctly requires either (a) the CPS lowering to settle a
synchronously-resolvable awaited value **synchronously** (collapse the
single-tick `Promise_then2` deferral when the operand settles in-tick), or
(b) the runner to drain the host microtask queue before reading the result.
Both are #1373b (IR async Phase C — CPS lowering for await/return/throw)
territory, not a bounded JS-host dev point-fix. Routing there.

## Failing tests (unchanged from baseline, all still `fail`/`compile_error`)
`expressions/await/`: `await-awaits-thenables.js`,
`await-awaits-thenables-that-throw.js`, `await-throws-rejections.js`,
`await-non-promise-thenable.js`, `await-non-promise.js` (compile_error),
`await-monkey-patched-promise.js`, `async-await-interleaved.js`,
`for-await-of-interleaved.js`; `module-code/top-level-await/await-awaits-thenables*.js`;
`built-ins/Array/fromAsync/*-thenable-awaits-once.js`. ≈ 15 rows.

## Recommendation
Fold the ~15 rows into #1373b's CPS-await Phase C (synchronous-settlement of an
in-tick-resolvable awaited value). Do NOT re-attempt as a legacy-arm host
point-fix while `ASYNC_CPS_ENABLED = true`.

## Unified-spec routing (architect, 2026-07-04) — supersedes the recommendation above

This issue is now covered by the **unified Promise semantics spec in #2623
(§P2 thenable assimilation, §P3 job-queue contract, §P7 slice queue)**. The
routing splits by lane, and the "synchronous settlement" idea is explicitly
REJECTED — collapsing an in-tick-resolvable await to synchronous settlement
violates the spec tick contract (#2623 §P3 J-5, observable via the
interleaving tests in this issue's own row list). The honest fix is:

- **Host-lane rows (~15 here)** → **#2623 §P7 slice P-8** (runner drain
  contract: the harness yields a turn before reading the verdict, plus the
  `Test262Error.thrower` / `promiseHelper.js` shims). Harness change,
  Opus-executable, MEASURED (expect honest flips both ways).
- **Standalone twin** (await on a thenable under the native carrier) →
  **#2623 §P7 slice P-4** (generic-thenable arm in `__promise_resolve_value`
  + await-operand normalization through PromiseResolve on the #2906 suspend
  terminator), sequenced after Fable slice P-3.

The `depends_on: 1373b` framing is superseded by the P-8/P-4 routing; keep
`blocked` until either slice lands, then re-measure this row list.
