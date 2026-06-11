---
id: 1972
title: "return_call conversion fires inside try/catch — the catch handler becomes unreachable, exceptions escape to the host"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: exceptions
goal: error-model
related: [822, 839, 1642]
origin: "2026-06-10 deep-audit sweep (optimizer agent): verified on main, default GC backend, WAT-proofed"
---

# #1972 — `try { return f(); } catch { ... }` never catches

## Problem

Wasm `return_call` replaces the caller frame, so a callee's throw unwinds past
the enclosing handler. The tail-call rewrite is suppressed for pending
`finally` but NOT for an enclosing `try` with a catch — making the ubiquitous
`try { return f(); } catch { ... }` pattern silently uncatchable.

## Repro (verified on main, default config, unoptimized)

```ts
function boom(): number { throw new Error("kaboom"); }
export function test(): number {
  try { return boom(); } catch (e) { return 42; }
}
```

node: `42` — wasm: uncaught Exception escapes to the host. WAT confirms
`(try (do return_call 3) (catch ...))`.

## Root cause

`src/codegen/statements/control-flow.ts:140,218-233` — `compileReturnStatement`
suppresses the `call`→`return_call` (and `call_ref`→`return_call_ref`) rewrite
only when `fctx.finallyStack` is non-empty (`hasPendingFinally`). No check for
an enclosing try-with-catch. `canTailCall`/`canTailCallRef` (24-88) check only
signature compatibility.

## Fix direction

Track try-nesting in `FunctionContext` (a `tryDepth`/`inTryWithHandler`
counter incremented by try-statement lowering) and skip the tail-call rewrite
when > 0, exactly as `hasPendingFinally` does. Same guard for the
`return_call_ref` branch.

## Acceptance criteria

- Repro returns `42`
- Tail calls outside try still emit `return_call` (recursion depth tests pass)
- `return_call_ref` path covered

## Dupe check

#822/#839 are return_call *validation* CEs; #1642 is return-in-IIFE leak.
Catch-skipping is unfiled.
