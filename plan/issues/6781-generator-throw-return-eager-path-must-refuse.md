---
id: 6781
title: "codegen: a generator whose consumer calls `.throw()`/`.return()` silently takes the eager host-buffer path — body and `finally` run at creation, `throw` escapes the generator's own `catch`"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: generators
goal: generator-model
related: [1687, 1691, 1344, 2035]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H2"
---

# #6781 — refuse, do not silently demote, generators that need `.throw()` / `.return()`

## Problem

#1687 records that the eager generator model cannot thread `.throw()` /
`.return()` into a `yield`. This issue is about what happens **today** when a
program does it anyway: the compiler silently falls back to the eager
host-buffer path and the program runs with different semantics.

Reproduced 2026-09-30 (JS-host lane):

| probe | wasm | JS |
|---|---|---|
| generator with `try { yield 1 } catch (e) { log("caught:" + e) }`, consumer calls `it.next(); it.throw("boom")` | `boom` escapes uncaught | `caught:boom`, then `{value:2,done:false}` … |
| `let created = 0; function* g() { created = 100; try { yield 1 } finally { created += 2 } }; const it = g();` then read `created` before `.next()` | `102` | `0` |
| `throw` after the first `yield`, consumer inside `try/catch` | raw `WebAssembly.Exception` escapes the caller's `catch` | caught |

## Root cause

`src/codegen/generators-native.ts:3780` gates the lazy lowering on
`resultConsumptionIsSafe`; when the consumer touches `next | return | throw`
in a way the gate does not accept, `:4302-4308` "falls to the eager-buffer
host path" — the whole body is executed at construction and buffered.
Nothing is reported: no warning, no error.

## Correction (this issue)

1. Make the fallback a **compile error** with a clear message
   (`generator-eager-unsupported: consumer calls .throw()/.return(); see #1687`),
   the same policy #3587 adopted for async shapes the lane cannot lower.
2. Keep the eager path only for generators whose consumption is provably
   `next()`-only (the current safe gate) — that path is observably correct
   there (verified: lazy `finally` timing matches Node for `next`-only use).
3. Wire the diagnostic through `ctx.errors` so #6776's validation and the CLI
   both show it.

The real fix — threading `.throw()`/`.return()` into the suspended frame —
stays with #1687 / #1691; this issue only removes the silent miscompile.

## Acceptance

- The three probes above fail to compile with the named diagnostic (until
  #1687 lands, after which they must pass and this gate becomes dead).
- `next()`-only generators are unaffected: no new compile errors in
  `tests/equivalence/` or the pinned issue tests.
- test262 `GeneratorPrototype/throw|return` rows move from `fail` to
  `compile_error` (report the count in the PR; a compile_error is the honest
  verdict).
