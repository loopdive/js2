---
id: 1042
title: "async/await state-machine lowering (AwaitExpression is currently a no-op)"
status: ready
created: 2026-04-11
updated: 2026-04-28
priority: high
feasibility: hard
reasoning_effort: max
goal: async-model
parent: 1032
depends_on: [680]
required_by: [1058]
---
# #1042 — Real `async`/`await` state-machine lowering

## Joint architect spec (S53)

This issue is one of five in the S53 async cluster. The unified architecture,
phase ordering, file map, and risk register live in
`plan/issues/sprints/53/async-cluster-architect-spec.md`. **Read that spec
first** — it pins the state-machine shape this issue must produce so it
stays compatible with #1373b's IR CPS lowering and #1116's Promise API
work. This issue is **Phase 2A** in the cluster.

## Problem

`src/codegen/expressions.ts:790` compiles `AwaitExpression` as a no-op — it recurses into the operand and returns whatever the operand returned. There is no Promise integration, no microtask suspension, no generator-style state machine, and no interaction with the host event loop.

```ts
if (ts.isAwaitExpression(expr)) {
  return compileExpressionInner(ctx, fctx, expr.expression);
}
```

In practice this means `async` functions behave like synchronous functions whose return value happens to be externref-wrapped. For Promise-returning host calls, the `.then(...)` chain runs inline because host Promises resolve synchronously on the next microtask and the Wasm code has already finished.

This works for trivial `Promise.resolve(x)` patterns. It breaks for anything that exercises real I/O completion (axios real HTTP GET in #1032), effect flushing (React useEffect in #1033), or any code that relies on observable suspension (parallel `Promise.all`, races with timeouts, backpressure).

## Approach

Two possible lowerings, in rough order of complexity:

1. **Generator-rewrite** — transform `async function` into `function*` at compile time, then use the existing generator machinery to save state at each `yield` (formerly `await`) and resume from a continuation closure. This is the standard technique used by TypeScript's own `--target es5` downlevel. Depends on #680 (Wasm-native generators as state machines) being solid.

2. **Stack switching (Wasm proposal)** — once the stack-switching proposal lands in toolchains, await can be a direct primitive. Not available today.

Recommended: pursue (1). Design doc before implementation because this interacts with closures, try/catch unwinding through await, and exception propagation across suspension points.

## ECMAScript spec reference

- [§27.7.5.1 AsyncFunctionStart](https://tc39.es/ecma262/#sec-async-functions-abstract-operations-async-function-start) — creates async execution context and promise capability
- [§15.8.4 Runtime Semantics: EvaluateAsyncFunctionBody](https://tc39.es/ecma262/#sec-runtime-semantics-evaluateasyncfunctionbody) — evaluates body, resolves/rejects completion promise
- [§6.2.4.1 Await](https://tc39.es/ecma262/#await) — suspends execution, resumes on promise settlement


## Acceptance criteria

- [ ] Design doc filed explaining the state-machine transform
- [ ] Simple case works: `async function f() { return await Promise.resolve(42); }` returns 42 after a real microtask yield
- [ ] try/catch around await propagates host rejections correctly
- [ ] Parallel `Promise.all([p1, p2])` serializes through two real microtask boundaries
- [ ] axios Tier 4 smoke test (real GET from httpbin.org) succeeds — #1032 acceptance criterion

## Non-goals

- Top-level await (separate issue)
- Async generators (`async function*`) — add after sync async works
- Stack switching — wait for the Wasm proposal

## Related

- Depends on: **#680** (Wasm-native generators — state-machine lowering for sync generators is a prerequisite technique)
- Parent: **#1032** (axios — first stress test to hit this)
- Blocks: #1032 real HTTP GET, #1033 concurrent React features
- Architecture: `plan/design/architecture/npm-stress-compiler-gaps.md` cross-cutting gap #2

---

## Implementation Plan (S53 architect — 2026-05-20)

This issue is now the **acceptance owner** for the async-model
cluster, not the implementation tracker. The implementation lives in
**#1373b** (`plan/issues/sprints/52/1373b-ir-async-cps-lowering.md`)
under `## Implementation Plan (S53 architect — joint spec for #1042 /
#1373 / #1373b)`.

### Strategic decision: state-machine, not stack-switching

The original Approach §1 (generator-rewrite via #680) is the right
direction but is implemented at the **IR level** rather than via
AST→AST rewriting:

- **Why IR**: the generator path (#680) uses host-driven `.next()`
  resumption — it's not a state machine in the wasm body but a host
  loop that calls into a wasm dispatch function. Async-await needs
  the **dispatch to live in wasm** (so WASI standalone mode works
  with no host) AND the resumption to be scheduled via a microtask
  queue (so `await Promise.resolve(x)` actually yields a tick).
- **Why not stack-switching**: the Wasm Stack Switching proposal
  (JSPI) is shipping in Chromium but isn't in Node WASI yet and isn't
  portable. We can revisit when it lands universally, but the
  state-machine encoding is correct and portable today.

### Files lowering `AwaitExpression` today

**`src/codegen/expressions.ts:973`** — the no-op identity. This stays
in place as a legacy fall-back path for the (transitional) period
while `ctx.supportsAsyncIr === false`. **Don't remove it** until
#1373b Slice 3 lands and the IR fallback budget shows zero async
functions in the `async-function` bucket on a full test262 run.

**`src/codegen/expressions.ts:154` `isAsyncCallExpression`** — detects
calls into known async fns and wraps the result in `Promise.resolve`
on the non-await consumer path. This wrap MUST stay even after IR
async lands because mixed-mode (legacy caller of an IR async fn) is
unavoidable during the rollout.

### Slice mapping

| #1042 Acceptance Criterion | Slice that delivers it | Validation |
|----------------------------|------------------------|------------|
| Design doc filed | This file + #1373b spec | ✅ This commit |
| `async f() { return await Promise.resolve(42); }` returns 42 | #1373b Slice 3 | `tests/ir/issue-1373b.test.ts` PENDING-path case + WASI smoke |
| try/catch around await propagates rejections | #1373c (new — splits out as Slice 4 in #1373b §2.5 explicitly defers it) | Add issue when Slice 3 lands |
| `Promise.all([p1, p2])` serialises through two microtask boundaries | #1373b Slice 3 | Synthetic test counting `__drain_microtasks` iterations |
| axios Tier 4 smoke (real GET from httpbin.org) | #1032 fixture | Existing #1032 acceptance test |

### Estimated total LoC across the cluster

| Slice | LoC | Status |
|-------|-----|--------|
| Slice 1 (gate scaffolding) | ~350 | ✅ Done in PR #441 (commit `3ea48c20c`) |
| #1326c Phase 1C-B (microtask queue + Promise.then) | ~900 | 🔄 in-progress |
| Slice 1b (from-ast wiring) | ~150 code + ~80 tests | ⏳ Spec ready |
| Slice 2 (PENDING-path CPS) | ~600 code + ~200 tests | ⏳ Spec ready, blocked on #1326c |
| Slice 3 (gate flip) | ~10 code + ~40 tests | ⏳ Spec ready, blocked on Slice 1b + Slice 2 |
| Slice 4 (try/catch around await — #1373c) | ~200 code + ~100 tests | ⏳ Out of #1373b scope; file when Slice 3 lands |

Total to close #1042 (excluding #1326c which is its own work): **~1300 LoC**.

### Test262 regression gate

See #1373b §2.9 for the watch-list directories. Net regressions must
be ≤ +10 per the standing PR self-merge protocol. Single bucket must
stay ≤ 50; escalate to tech lead if a single dir spikes.
