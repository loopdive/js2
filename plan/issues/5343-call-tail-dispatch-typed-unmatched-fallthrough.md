---
id: 5343
title: "call-tail-dispatch: a callee with a checker signature but no registered closure falls through to a silent `undefined`"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Handed on by the #5335 fix, which routed *around* it rather than into it.

In `src/codegen/expressions/call-tail-dispatch.ts`, the "CallExpression as
callee" arm (`f()()`) calls `matchClosureInfoBySignature`, which iterates
`ctx.closureInfoByTypeIdx`. When no registered closure matches **and** the
checker *does* give the inner call a signature, the guard
`if (!callSigs || callSigs.length === 0)` skips the working dynamic-call
ladder too, and the arm falls through to a tail that emits `drop` +
`ref.null extern` — a **silent `undefined`**, not a trap.

The untyped twin is already repaired (`tryEmitInlineDynamicCall`, guarded by
`callSigs.length === 0`); the *typed-but-unmatched* case is not. #5335 made
module-init pass 2 run so the registry is populated there, but the same
fall-through is reachable by any **host callee**, any callee compiled in a
**later module**, and any signature the registry never sees.

This is the mechanism that printed `0` instead of `3` for `outer()()()`. It
is also the leading suspect for hono's `Cannot read properties of null
(reading 'split')` (#5338) and axios `buildURL`'s null access (#5341) — both
are "a compiled callee answered nothing to the host".

## Acceptance criteria

1. A miss in `matchClosureInfoBySignature` with a non-empty `callSigs` falls
   back to the dynamic-call ladder; the `drop` + `ref.null extern` tail is
   reachable only when there is genuinely nothing to call.
2. Regression test: a two-file untyped `.js` project where the inner callee
   is (a) a host function, (b) a function exported by a second module and
   called before that module's closures are lifted — both must return the
   real value. Fails on parent, passes with fix. Anti-vacuity control: the
   already-matched case still takes the fast `call_ref` arm (assert on WAT or
   on a counter).
3. `tests/issue-5335-module-init-pass2-closure-registry.test.ts` still
   11/11 and `JS2WASM_TEST_FORCE_MODULE_INIT_PASS2` seam behaviour unchanged.
4. A/B at one HEAD, 17 suites, per test file; nothing regresses (anchors in
   #5338). If #5338/#5341 move, say so — that is the expected upside.
5. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. Read `call-tail-dispatch.ts` around `matchClosureInfoBySignature` and the
   `callSigs` guard; read `tryEmitInlineDynamicCall` to see the repaired
   untyped path. The fix is to make the typed path share that fallback: on
   registry miss, emit the dynamic ladder regardless of `callSigs.length`.
2. Capture `.tmp/call-tail-dispatch.orig.ts` before editing.
3. Reproduce with the host-callee shape first (no module-init involvement):
   `const f = () => globalThis.Math.max; f()(1, 2)` or an imported host
   function returned from a compiled function. Confirm the `ref.null extern`
   tail in WAT. Then the second-module shape.
4. Implement: route the miss to the dynamic ladder. Keep the fast arm for
   registry hits. Do **not** widen `callSigs` handling elsewhere.
5. Regression test; run the #5335 test file; A/B.

## Dispatch

Model: **sonnet**. Mechanism, site, and fix direction are all established by
the #5335 agent's WAT analysis; the untyped twin shows the exact shape of the
repair. Well-specified, small blast radius.
