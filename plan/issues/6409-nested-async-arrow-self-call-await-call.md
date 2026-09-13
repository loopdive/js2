---
id: 6409
title: "A nested async arrow that calls itself (through its own captured `const` binding) while its body awaits a call never enters the recursive activation — hono `createPool`'s pool-full retry strands"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
language_feature: async, closures
related: [5367, 5372, 5340, 4302]
---

## Problem

Inside an async function, a **nested async arrow** stored in a `const` that
(a) awaits a **call** somewhere in its body and (b) calls **itself** through
that captured binding never executes the recursive activation: the self-call
returns a Promise that resolves to `null` without the callee's body running
(its first statement is never reached). Measured on upstream/main
`225f400089` (JS-host GC lane, `compileProject`, untyped `.js` two-file
project, `target: "gc"`, `platform: "web"`, `experimentalIR`), identical with
the base sources of #5367/#5372 swapped in — so it is pre-existing and
independent of that fix (which only made it *reachable*, see Impact).

Two-file fixture (`lib.js` is empty apart from the timer helper):

```js
// lib.js
export function race(p, log) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r("TIMEOUT"), 200))]).then((v) => v + "|" + log.join(","));
}
```

```js
// rows.js
import { race } from "./lib.js";

// t1 — hono createPool's retry shape: strands (one "enter", then TIMEOUT)
export async function t1() {
  const log = [];
  const run = async (fn, promise, resolve) => {
    log.push("enter:" + typeof fn);
    if (!promise) {
      promise = new Promise((r) => (resolve = r));
      setTimeout(() => run(fn, promise, resolve));
      return promise;
    }
    const result = await fn();
    resolve(result);
    return promise;
  };
  return await race(run(() => "V"), log);
}
// t2 — same recursion, `await null` instead of `await fn()`: works
export async function t2() {
  const log = [];
  const run = async (fn, promise, resolve) => {
    log.push("enter:" + typeof fn);
    if (!promise) {
      promise = new Promise((r) => (resolve = r));
      setTimeout(() => run(fn, promise, resolve));
      return promise;
    }
    await null;
    resolve("V2");
    return promise;
  };
  return await race(run(() => "V"), log);
}
```

`t1()` → `TIMEOUT|enter:function` (native: `V|enter:function,enter:function`);
`t2()` → `V2|enter:function,enter:function`. An instrumented variant that
stores the recursive call's result shows `typeof p === "object"` and the
promise resolving to `null` — the body is simply never entered.

## Reduction table (all measured, JS-host lane, fix and base identical)

| variant | result |
| --- | --- |
| t1: nested `const run = async (fn, promise, resolve) => …`, `await fn()`, self-call via `setTimeout(() => run(…))` | **strands** |
| t3: same, self-call via `Promise.resolve().then(() => run(…))` | **strands** |
| t4: same, self-call synchronous `run(fn, promise, resolve)` in the body | **strands** |
| t5: same, `fn` a module-level function declaration | **strands** |
| t6: same, `fn` captured from the enclosing scope instead of a parameter | **strands** |
| u2: `await g()` with `g` a module-level `async function` (no function value at all) | **strands** |
| t2: `await null` instead of `await fn()` | works |
| u6: `const pending = fn(); await pending;` (await an identifier, not a call) | works |
| u7: the argument is an `async` closure (`run(async () => "V7")`) | works |
| u3: self-call through a holder object (`holder.run = run; holder.run(…)`) | works |
| u4: nested `async function run(…) {}` declaration instead of an arrow | works |
| u9: two sequential calls of `run` from the OUTER function (no self-call) | works |
| t7: plain (non-async) nested arrow with the same recursion | works |
| retryParams: the identical arrow at MODULE level (self-call via module scope) | works |

So the defect needs all three: a nested async **arrow** (not a declaration,
not a module-level binding), a self-reference through its own captured
`const` cell, and an `await` whose operand is a **call expression** in the
same body. Note u7: when the awaited call's callee is an async closure the
recursion works, so the planner's choice for `await <call>` (the awaited
type / "prepared native async" vs host-driven path) is part of the trigger.

Also seen (same fixture, also identical on the base): `const run = async (fn, n) =>
{ if (n > 0) return run(fn, n - 1); return await fn(); }` throws
`undefined is not a function` at the self-call (`u8`).

## Impact

hono `src/utils/concurrent.test.ts` (0/6). Its `createPool` is exactly t1:

```js
const run = async (fn, promise, resolve) => {
  if (pool.size >= concurrency) {
    promise ||= new Promise((r) => (resolve = r));
    setTimeout(() => run(fn, promise, resolve));
    return promise;
  }
  const marker = {};
  pool.add(marker);
  const result = await fn();
  …
};
```

With #5367 fixed (`await Promise.all(...)` inline is now driven), the four
`concurrency N, count M` tests get past the `Promise.all` and now fail on
`expect(running.size).toBe(0)` (`running.size` still `1|10|10|2000`) and the
two `with interval` tests on `toEqual(expectedResults)`: every job that hits
the pool-full branch is retried through the self-call and never runs. On the
original #5367 parent (`cbd2f11dff`) the same tests failed earlier (`results`
was `[]` because the inline `Promise.all` was never awaited); at
`225f400089` the typed upstream test reaches this assertion on the base too. The untyped mimic (`.tmp` probe
`poolDiag`) logs `add,add,retry,retry,done,done,timer-fired,timer-fired` and
nothing after — the retried `run` never enters.

## Where to look

- `src/codegen/async-frame.ts` — the entry stub / activation of a nested
  async arrow that is claimed by the host frame machine
  (`asyncFnNeedsHostDrive`): what a call through the arrow's own captured
  cell binds to when the body contains `await <call>` (compare u4, the
  declaration form, and u3, the holder form, which both work).
- `src/codegen/async-ir-planning.ts` / `prepared-native-async-await.ts` —
  `await fn()` vs `await pending` (u6) and vs an async-closure callee (u7)
  pick different lowerings; the failing rows are the ones where the awaited
  call is not provably a compiled async callee.
- `src/codegen/closures.ts` — self-capture of a `const` arrow (TDZ cell) in
  a driven frame; `t7` shows the cell itself is fine for a sync arrow.

## Acceptance criteria

1. Every "strands" row of the table above reads the native value; the
   "works" rows stay as they are.
2. Regression test under `tests/` with the table as untyped `.js` two-file
   fixtures (each row an async function resolved on the host via `.then`,
   a 200 ms race so a strand reads `TIMEOUT` instead of hanging), failing on
   the parent for the strands rows.
3. hono `src/utils/concurrent.test.ts` ≥ 5/6 through
   `tests/dogfood/hono-upstream-suite.mjs`.
4. A/B at one HEAD over the 17 dogfood suites, per test file; standalone
   lane byte-identical unless the change is deliberately shared.
