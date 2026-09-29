---
id: 6761
title: "standalone: an async closure called through an untyped value returns its raw value and throws synchronously — no promise"
status: ready
sprint: Backlog
created: 2026-09-29
updated: 2026-09-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/claude-lead
related: [6735, 6747, 1150, 2867, 1313]
---

# #6761 — async closures reached through `any` never become promises

## Problem

In `--target standalone` an async function body returns its raw value, and the
**call site** turns it into a promise: `wrapAsyncReturn` for the value, and
`wrapAsyncCallInTryCatch` (#1150) for a synchronous throw
(`src/codegen/expressions.ts`). That only happens where the checker knows the
callee is async. A call through an untyped value — a callback parameter, the
usual shape in harness and library code — gets neither.

Measured 2026-09-29 on main `c9d7d2069` (standalone, allowJs,
`runtimeEvalProvider: false`):

| shape | result |
| --- | --- |
| `var f = async function () { throw e }; f()` | promise, rejects ✓ |
| `async function f() { throw e }; f()` | promise, rejects ✓ |
| `var g = f; g()`, `o.m()`, `a[0]()` (typed async) | promise, rejects ✓ |
| `function call(fn) { return fn(); }` + `call(async function () { return 5 })` | **raw `5`**, `.then` traps |
| `call(async function () { throw e })` | **throws synchronously** |
| `call(async () => { throw e })` | **throws synchronously** |
| `call(async function () { await 0; throw e })` | **throws synchronously** |

## Why it matters now

`assert.throwsAsync` (test262 `harness/asyncHelpers.js`) calls its `func`
argument exactly this way. Every standalone `asyncHelpers-throwsAsync-*` row
that passes an async function therefore sees "the function threw
synchronously", and the promise `throwsAsync` returns rejects.

Until #6301 those rows still passed: a standalone `await` of an
already-rejected promise continued with the rejection reason instead of
throwing, so the test body's `await p` swallowed the failure. #6301 fixed
`await` (#6735), which exposed two ES5 rows —
`harness/asyncHelpers-throwsAsync-native.js` and
`harness/asyncHelpers-throwsAsync-custom-typeerror.js` — and broke the
completed-edition ratchet on `main`. #6301's code was reverted in #6313 until
this issue lands.

## Direction

The dynamic call path (the `any`-callee dispatch that `call_ref`s a closure)
needs to know a closure came from an async function and apply the same two
steps the typed call site applies: wrap a normal return into a fulfilled
`$Promise`, and a throw into a rejected one. Typed call sites must keep their
current single wrap — do not move the wrap into the callee without also
teaching `calleeIsDriveLowered`-style checks, or typed calls build a
Promise-of-Promise (#2867 note in `expressions.ts`).

## Acceptance criteria

- Every row of the table above returns a promise that settles as the spec says.
- With #6301's `await` change re-applied, `harness/asyncHelpers-throwsAsync-*`
  pass in standalone, and ES5 stays at 100 %.
- Standalone async buckets (`language/expressions/async-*`,
  `statements/async-function`, the `async-method` dirs, `built-ins/Promise`):
  no losses.
