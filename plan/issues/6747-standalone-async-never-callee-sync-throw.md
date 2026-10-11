---
id: 6747
title: "standalone: an async function awaiting a `never`-typed call throws synchronously instead of rejecting"
status: ready
sprint: Backlog
created: 2026-09-29
updated: 2026-09-29
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6735, 2867, 1150]
---

# #6747 — `await g()` with a `never`-returning `g` escapes the async call

## Problem

Measured 2026-09-29 on main `c8b4f0ef36` (standalone, `compileMulti`, allowJs):

```js
async function f(x) { const m = await g(x); return m; }
function g(x) { throw new TypeError("sync"); }   // TS return type: never
try { const p = f(1); /* … */ } catch (e) { /* reached — wrong */ }
```

`f(1)` throws synchronously; per spec it returns a promise rejected with the
TypeError. The same body with `g` typed `Promise<…>` (throws on some inputs,
returns a promise on others), a void body, or an untyped callee rejects
correctly — only the `never`-typed callee misbehaves.

## Diagnosis (not yet fixed)

`calleeIsDriveLowered` (`src/codegen/expressions.ts`) answers with
`asyncFnNeedsCps(decl, plan)`, while activation (`decideAsyncActivation`,
`src/codegen/async-activation.ts`) decides with `asyncFnNeedsDrive`. For this
body the call site believes the callee is frame-driven (already returns a
`$Promise`, so it skips the #1150 try/catch → rejection wrap), but `$f` is
emitted as a plain synchronous body (g inlined, `throw` straight out). The
predicate the call site uses must be the one activation used.

## Acceptance criteria

- The snippet above rejects (`e instanceof TypeError`) instead of throwing.
- `calleeIsDriveLowered` and activation share one predicate.
- Standalone test262 `language/expressions/async-*`, `statements/async-function`
  and the async method buckets: no losses.
