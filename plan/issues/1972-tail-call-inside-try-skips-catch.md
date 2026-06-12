---
id: 1972
title: "return_call conversion fires inside try/catch — the catch handler becomes unreachable, exceptions escape to the host"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
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

## Resolution (2026-06-12)

Implemented per the fix direction: `FunctionContext.tryCatchDepth`
(`src/codegen/context/types.ts`) counts enclosing try blocks WITH a catch
clause; `compileTryStatement` increments it around the try-body statement
loop (catch body compiles after the decrement, so its returns only answer
to outer handlers), and `emitReturnTail`
(`src/codegen/statements/control-flow.ts`) skips both the `return_call`
and `return_call_ref` rewrites while it is > 0 — exactly as
`hasPendingFinally` already did.

## Test Results

- Repro returns 42 (was: exception escaped to host).
- `tests/issue-1972.test.ts` — 8/8: repro, `return_call_ref` (indirect call
  in try), TCO outside try still emits `return_call` (WAT-asserted),
  catch-body return still TCO-eligible, return-after-try eligible again,
  nested try caught by inner handler, deeper-nested throw caught,
  try/finally value + finally side effect.
- Related suites: `issue-822` + `issue-839` (return_call validation) pass;
  `issue-2061`, `issue-1858`, `error-reporting-catchpaths` pass.
- Pre-existing failures identical on main (NOT from this change):
  `tests/tail-call-optimization.test.ts` (4 fails — see discovery below),
  `tests/finally-block.test.ts` (5 fails), `tests/global-index-shift-trycatch.test.ts`
  (file-level).

## Discovery — IR path strips return_call (pre-existing, separate issue)

While verifying "tail calls outside try still emit return_call":
the experimental-IR path (`compileIrPathFunctions`, runs after legacy
`compileDeclarations` in `generateModule`) re-lowers every IR-claimed
function and its lowering NEVER emits `return_call` — the legacy rewrite is
discarded with the legacy body. Confirmed by instrumentation: factorial
finalizes with 1 `return_call`, emit sees 0. This is why all 4
WAT/recursion assertions in `tests/tail-call-optimization.test.ts` fail on
current main: simple numeric recursions are exactly the functions IR
claims, so they lose TCO and deep recursion overflows the stack again.
Needs its own issue (IR-side tail-call support or preserving legacy TCO
for IR-claimed functions). The tests in `tests/issue-1972.test.ts` force
the legacy path (via `new Error`, which IR rejects as external-call) for
their positive `return_call` assertions.
