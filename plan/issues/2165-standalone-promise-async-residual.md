---
id: 2165
title: "Standalone Promise/async conformance residual (~223 tests)"
status: done
assignee: ttraenkler/se1
completed: 2026-06-16
sprint: 62
created: 2026-06-15
updated: 2026-06-16
priority: medium
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: promise-async
goal: standalone-mode
parent: 1116
depends_on: [1326]
---

# Standalone Promise/async conformance residual

## Problem

Promise resolution and async error handling landed in #1116 (`done`, sprint
55); the standalone microtask scheduler #1326 is `in-review` and Promise
subclass capability #1694 is in `backlog`. The host-vs-standalone baseline
diff (sha `31fa7e099`, 2026-06-15) shows **223 tests pass in host mode but
fail standalone**, attributed to Promise/async semantics.

## Evidence

- Gap category: `built-ins/Promise` 180 plus async language tests;
  `Promise_resolve`/`Promise_reject`/`Promise_then`/`__create_async_generator`/
  `__make_callback` host-import leaks.

## Acceptance criteria

- Standalone pass count for `built-ins/Promise` + async language tests rises
  toward host parity.
- No `Promise_*` / `__make_callback` host-import leak for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1116. Depends on the standalone microtask scheduler (#1326)
landing. Part of sprint-62 standalone catch-up (rank 11 by gap impact).

## Implementation Notes (se1, 2026-06-16, sprint 62)

### Gap census (standalone/WASI, current main)

Probed the representative Promise/async constructs in `--target wasi` for
`Promise_*` / `__make_callback` host-import leaks:

| construct | standalone |
|-----------|-----------|
| `Promise.resolve` / `.reject` | clean |
| `.then(f)` / `.then(f,g)` | clean |
| `async fn` / `await Promise.resolve` | clean |
| `Promise.all` / `Promise.race` | clean |
| **`.catch(f)`** | **LEAK: `__make_callback`** ← fixed here |
| `.finally(f)` | LEAK: `__make_callback` (residual) |
| `new Promise(executor)` | LEAK: `Promise_new` + `__make_callback` (residual, see #2028) |

So most of the originally-reported ~223-test gap had already closed via
#1326/#1326c; the live leaks at this point are `.catch`, `.finally`, and the
`new Promise` executor.

### This slice — standalone `.catch`

`.catch(onRejected)` ≡ `.then(undefined, onRejected)` (§27.2.5.1). Lowered it
through the existing native-`$Promise` then-machinery instead of the host
import:

- `src/codegen/expressions/calls.ts`: added a standalone `.catch` branch
  alongside the standalone `.then` branch — `emitStandalonePromiseThen(promise,
  null /*onFulfilled*/, onRejected)`. The chained promise propagates a
  fulfilled receiver unchanged (identity-fulfill wrapper) and routes a
  rejection through the user's `onRejected`.
- `src/codegen/expressions.ts`: extended the `isAsyncCallExpression` standalone
  guard to exclude `.catch` (it already excluded `.then`). Without this the
  `.catch` result — already a `$Promise` — was double-wrapped by
  `wrapAsyncReturn`, producing a Promise-of-Promise that yielded `illegal cast`
  / `NaN` when the chained result was consumed.

Result: `.catch` (standalone) no longer emits `Promise_catch` /
`__make_callback`. Inline `Promise.resolve(x).catch(f).then(g)` and rejection
routing both verified at runtime; brought to parity with `.then`.

### Validation

- `tests/issue-1326.test.ts` — 16/16 pass, including 2 new WASI `.catch` cases
  (rejection routing → reason+3; fulfilled promise skips `.catch`, value flows).
- `tsc --noEmit` clean; prettier clean; host-mode async suites
  (`async-await`, `issue-1042`) unchanged/pass.

### Remaining residual (NOT in this PR)

- **`.finally(f)`** — still leaks `__make_callback`. Needs synthesized
  pass-through wrappers (`(v)=>{f();return v}` / `(e)=>{f();throw e}`) that the
  current `emitStandalonePromiseThen` user-closure callback path doesn't express
  directly. Follow-up.
- **`new Promise(executor)`** — leaks `Promise_new` + `__make_callback` and the
  executor body never runs (separate root cause, see #2028 re-analysis / PR
  #1543).
- **Native `$Promise` stored in a `const`/var then re-consumed** — throws
  `illegal cast` (pre-existing; affects `.then` too, not introduced here).
