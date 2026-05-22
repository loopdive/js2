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
note: "Verified 2026-05-21: AwaitExpression no-op at expressions.ts:973 (drifted from cited L790). Multiple other line refs in this issue may need re-verification before dispatch."
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

`src/codegen/expressions.ts:973` (verified 2026-05-21 — was 790) compiles `AwaitExpression` as a no-op — it recurses into the operand and returns whatever the operand returned. There is no Promise integration, no microtask suspension, no generator-style state machine, and no interaction with the host event loop.

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

---

## Status update (2026-05-21 — arch-async, task #79)

### Current line numbers after code reorganisation

The pre-S53 plan above refers to functions that have since moved into
the `src/codegen/expressions/` subdirectory. Verified current locations:

- `AwaitExpression` no-op handler — **`src/codegen/expressions.ts:973`** (unchanged from spec)
- `isAsyncCallExpression` — **`src/codegen/expressions.ts:154`**
- `wrapAsyncReturn` — **`src/codegen/expressions.ts:184`**
- `wrapAsyncCallInTryCatch` — **`src/codegen/expressions.ts:236`**
- Async call wrap site — **`src/codegen/expressions.ts:898-935`**
- `compileCallExpression` — **`src/codegen/expressions/calls.ts:965`** (moved out of `expressions.ts`)
- `.then`/`.catch`/`.finally` instance-method dispatch — **`src/codegen/expressions/calls.ts:3807-3809`**
- `effectiveRetType` for async — **`src/codegen/function-body.ts:567-569`**
- `compileArrowAsClosure` param-type resolution — **`src/codegen/closures.ts:1169-1170`** (was the cited 875-886 region — file grew)
- `collectPromiseImports` — **`src/codegen/index.ts:4614`**
- `compileVariableStatement` + `isPromiseHostCall` — **`src/codegen/statements/variables.ts:141`** / **`:117`**

### Conflict notes — #820c overlap (CRITICAL)

#820c (async-gen object-method yield* iterator-protocol, ~39 fails) is **in-progress
in parallel** and edits two of the same files:

- `src/codegen/expressions/calls.ts` — #820c adds `IteratorStep` non-object guard
  near the yield* lowering (~line 4293). #1042 Slice 2A's CPS entry-point
  delegates from the `AwaitExpression` handler. **No textual overlap expected**
  (yield* and await are different AST nodes), but both PRs touch `calls.ts` —
  whichever lands second must rebase. Coordinate via `[CONFLICT]` TaskList item
  if both touch the same export block.
- `src/codegen/closures.ts` — #820c modifies `__obj_meth_tramp_*` emission
  (async-generator trampoline). #1042 Slice 2A's continuation-closure synthesis
  adds new closure structs in the same file. Different regions of the file.
  Low risk if both rebase forward.

**Land order recommendation**: #820c is smaller (~39 fails, surgical fix). Land #820c
first; then #1042 Slice 2A rebases on top. The joint async-cluster spec already
sequences #1151 (Gap B) → #1116 (WI1-WI8) → #1042 → #1373b; #820c can slot in
parallel with the #1151 / #1116 phase since neither touches the IteratorStep
guard.

### FAIL estimate

Per the issue header (`test262_fail`: not set explicitly) and joint spec §5:
- **~210 tests** fixed by Phase 2A when the AST-level CPS lands (issue body
  estimate). Bucket: `language/expressions/await/*`, `language/statements/await/*`,
  `built-ins/Promise/*` overlap with #1116, async-iter cases that need observable
  microtask suspension.
- Net delta target after #1116 + #1151 already in: ≥ +150 pass (subtract the
  overlap with #1116's 151 Promise tests; many will already pass via Phase 1B).
- Acceptance gate per joint spec: simple `await Promise.resolve(42)` returns 42
  after a real microtask tick + try/catch around await + `Promise.all` with
  real interleaving + axios real-GET (#1032).

### Test cases (5 representative — for `tests/issue-1042.test.ts`)

1. **Identity await** — `async function f() { return await Promise.resolve(42); }; f().then(v => expect(v).toBe(42))` — value flows through one microtask boundary.
2. **Sequential awaits with side effects** — `let order = []; async function f() { order.push("a"); await Promise.resolve(); order.push("b"); }; f(); order.push("c"); // ['a','c','b']` — observable suspension.
3. **try/catch across await** — `async function f() { try { await Promise.reject(new Error("x")); } catch (e) { return e.message; } }; f().then(v => expect(v).toBe("x"))` — Promise rejection re-thrown into catch handler.
4. **Parallel Promise.all interleaving** — `async function f() { return await Promise.all([Promise.resolve(1), Promise.resolve(2)]); }; f().then(v => expect(v).toEqual([1,2]))` — combinator path through Phase 1B.
5. **return await tail** — `async function inner() { return 7; } async function outer() { return await inner(); }; outer().then(v => expect(v).toBe(7))` — Promise unwrap collapse per Risk Register §6.2.

### Sequencing summary

| Phase | Owner | Status |
|-------|-------|--------|
| 1A — #1151 binding-pattern guard | dev (one-line in `closures.ts:1169-1170`) | ready |
| 1B — #1116 WI1-WI8 (partially landed: WI1/WI4/WI5/WI8 done) | dev | ready, partial |
| 2A — #1042 introduces `async-cps.ts`, routes `AwaitExpression` | dev (this issue) | blocked on 1A+1B PRs landing |
| 2B — #1373b CPS lowering | senior-dev | blocked on #1326c Phase 1C-B + 2A |
| 3A/B — async.throw, try/catch across await | senior-dev | sub-slices of #1373b |

---

## Implementation Plan — Dev-Ready Spec (S53 architect, task #88, 2026-05-21)

This section is the **step-by-step coding spec** for Phase 2A (#1042). The
joint architect spec at `plan/issues/sprints/53/async-cluster-architect-spec.md`
defines the *what* (state-machine model, IR contract, mode dispatch); this
section defines the *how* (functions to write, signatures, Wasm patterns, the
order to land them).

**Pre-condition** (verify before starting):

- #1151 (Phase 1A, binding-pattern null guard at `closures.ts:1186-1189`) is
  ALREADY in tree — see lines 1176-1189 above. Don't re-implement.
- #1116 (Phase 1B) WIs 1/4/5/8 already landed. The rest are independent and
  do not block #1042 — start regardless of their status.
- `src/codegen/async-scheduler.ts` is in place. `emitStandalonePromiseResolve`
  / `emitStandalonePromiseReject` (lines 171-195) are usable as-is; the
  `then` and `enqueue` helpers throw stubs and stay that way for the JS-host
  variant of this spec.

### Step 1 — Create `src/codegen/async-cps.ts` (new file)

This is the shared CPS-transform module that both #1042 (AST) and #1373b (IR)
will call into. **Write the AST path first**; #1373b will call the same
top-level entry points later.

**Exported surface (must remain stable for #1373b):**

```ts
// src/codegen/async-cps.ts

/**
 * Result of analysing an async function body for CPS transform.
 * Populated by analyzeAsyncBody, consumed by emitAsyncStateMachine.
 */
export interface AsyncCpsPlan {
  /** Pre-order list of await points found in the body (by ts.Node identity). */
  awaitPoints: ts.AwaitExpression[];
  /** For each await point: live local names that must be captured into the next continuation. */
  liveAfterAwait: Map<ts.AwaitExpression, Set<string>>;
  /** Does the body contain a `try`/`catch` that spans an await? (Phase 3B — gated). */
  hasTryAcrossAwait: boolean;
  /** Does the body contain `throw` outside try/catch that must reject the outer Promise? */
  hasUncaughtThrow: boolean;
}

/**
 * Walk the body of an async function declaration / arrow / method and produce a plan.
 * Pure analysis — no codegen side effects.
 */
export function analyzeAsyncBody(ctx: CodegenContext, fn: ts.FunctionLikeDeclaration): AsyncCpsPlan;

/**
 * Emit a CPS-lowered async function body into fctx. Replaces the normal
 * compileStatement loop that compileFunctionBody would otherwise run.
 *
 * Caller (compileFunctionBody) has already:
 *   - Registered params as locals in fctx.localMap
 *   - Set fctx.returnType to { kind: "externref" } (a Promise carrier)
 *
 * This function:
 *   1. Allocates the outer $Promise via emitStandalonePromiseResolve(pending)
 *      OR via Promise_resolve host import (JS-host mode)
 *   2. Compiles the prefix segment (statements before the first await)
 *   3. At each await point: spills live locals into a continuation closure struct,
 *      schedules continuation via then() on the awaited value, returns the outer Promise
 *   4. The continuation segments are emitted as separate top-level functions
 *      (added to ctx.mod.functions during this call) — same pattern as compileArrowAsClosure
 */
export function emitAsyncStateMachine(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): void;

/**
 * IR entry point (Phase 2B / #1373b). Same machinery, IR input.
 * Stub returning `false` is acceptable in #1042's first PR — #1373b
 * fills it in.
 */
export function emitAsyncStateMachineFromIr(/* ... */): boolean;
```

**Internal helpers (private to async-cps.ts):**

- `splitBodyAtAwait(stmts: ts.Statement[]): Segment[]` — walks the statement
  list and the expression tree; whenever it hits an `AwaitExpression`, ends
  the current segment and starts a new one. A `Segment` is `{ stmts:
  ts.Statement[]; tailAwait: ts.AwaitExpression | null }`.
- `computeLiveLocals(segment: Segment, allParams: string[]): Set<string>` —
  union of (a) params, (b) locals declared in this segment or any prior
  segment, that are referenced in any later segment. Use the existing
  `collectReferencedIdentifiers` helper exported from `closures.ts` (see
  `expressions.ts:78`).
- `synthesizeContinuationClosure(ctx, captures, body): { funcIdx, structTypeIdx }`
  — creates a `__cont_N` function plus a `__cont_N_struct` capture struct.
  **Re-use `compileArrowAsClosure`'s closure-pipeline pattern** at
  `closures.ts:1554-1576` rather than rolling new struct/func synthesis.
  Param signature uniformly `(externref capturedState, externref awaitValue)
  → externref` per joint spec §2.2.

### Step 2 — Wire the await dispatcher in `expressions.ts:973`

**Current code** (`src/codegen/expressions.ts:973-975`):

```ts
if (ts.isAwaitExpression(expr)) {
  return compileExpressionInner(ctx, fctx, expr.expression);
}
```

**Replace with:**

```ts
if (ts.isAwaitExpression(expr)) {
  // The await is reached only via the CPS transform — emitAsyncStateMachine
  // routes each segment's tail-await through a continuation. The expression
  // dispatcher only sees an isolated await when the surrounding function
  // could not be CPS-transformed (e.g. await in a non-async context, which
  // TS rejects, or a transitional legacy fall-back).
  //
  // Legacy fall-back: pass-through the operand value. This matches today's
  // behaviour and keeps the existing 250+ async tests that don't require
  // observable suspension passing while CPS rolls out.
  if (!fctx.asyncCpsActive) {
    return compileExpressionInner(ctx, fctx, expr.expression);
  }
  // CPS is active: the surrounding emitAsyncStateMachine has already
  // segmented the body and split the await into "schedule continuation" +
  // "resume with value". When the recursive expression compilation hits
  // this node, it means a nested expression (e.g. `await (x + await y)`)
  // — emit a synchronous unwrap of the already-fulfilled Promise.
  return compileNestedAwait(ctx, fctx, expr);
}
```

Where `compileNestedAwait` (new helper, exported from `async-cps.ts`) handles
the case of nested awaits within a single segment (each inner await also
becomes a continuation point). For the **initial PR**, throw a
`reportError("nested await not yet supported")` and add a follow-up issue;
the joint spec §6.2 calls out `return await` as the only tail case that must
work in Slice 2A.

**Add to `FunctionContext`** (`src/codegen/context/types.ts`, search for the
`FunctionContext` interface — it lives in `context/types.ts` per the import at
expressions.ts:27):

```ts
asyncCpsActive?: boolean;  // true while emitAsyncStateMachine is driving the body
```

### Step 3 — Hook `compileFunctionBody` for async functions

**File:** `src/codegen/function-body.ts:558-647`

The current async path just sets `effectiveRetType = unwrapPromiseType(retType)`
(line 569) and otherwise compiles the body like a sync function. Replace
this in the **single dispatch point** at the bottom of `compileFunctionBody`:

```ts
// AFTER fctx is built and ctx.currentFunc = fctx (line 647),
// BEFORE the statement loop (search for `compileStatement(ctx, fctx, stmt)`)

if (isAsync) {
  // #1042 Slice 2A: route through CPS transform if the function uses await.
  // If no await is present, the function is "async in name only" — the
  // legacy effectiveRetType unwrap + wrapAsyncReturn on call sites is
  // sufficient; skip CPS to keep the conservative path stable.
  const plan = analyzeAsyncBody(ctx, decl);
  if (plan.awaitPoints.length > 0) {
    // Override return type to externref (the outer Promise carrier).
    // The existing effectiveRetType path is a transitional shim per joint
    // spec §6.1; CPS-driven async functions now produce a real Promise.
    fctx.returnType = { kind: "externref" };
    // Re-register the function's wasm type signature so callers see the
    // new return type. The existing pattern is at `index.ts:collectDeclarations`;
    // here we need to mutate ctx.mod.types[func.typeIdx] in place.
    rewriteFuncResultType(ctx, func.typeIdx, { kind: "externref" });
    fctx.asyncCpsActive = true;
    emitAsyncStateMachine(ctx, fctx, decl, plan);
    fctx.asyncCpsActive = false;
    // emitAsyncStateMachine drove the entire body; skip the normal stmt loop.
    finalizeFunctionBody(ctx, fctx, func);  // existing cleanup
    return;
  }
}
// ...existing statement-loop path stays unchanged for sync + await-less async fns
```

**`rewriteFuncResultType` helper** lives in `src/codegen/registry/types.ts`
(check for an existing function; if not, add it). Pattern:

```ts
export function rewriteFuncResultType(ctx: CodegenContext, typeIdx: number, ret: ValType): void {
  const ft = ctx.mod.types[typeIdx];
  if (ft?.kind !== "func") return;
  ft.results = [ret];
}
```

This is intentionally narrow — only mutate the result, never the params.

### Step 4 — Generator-rewrite as the segmentation model

The joint spec calls this a "CPS transform", but the actual mechanic is the
standard **generator-rewrite**: split the body at each await, compile each
segment as a continuation function, chain them via Promise.then. The model
maps cleanly to the existing closure pipeline.

**For each await point `expr.expression` in the body:**

Given the source pattern:

```ts
async function f(a, b) {
  const x = computeSync(a);
  const y = await foo(b);
  const z = y + x;
  return z;
}
```

`emitAsyncStateMachine` produces three functions:

1. **`f` (the original)** — receives `(a, b)`:
   - Compiles `const x = computeSync(a);` (prefix segment).
   - Compiles `foo(b)` (the awaited expression).
   - Allocates capture struct `{ a, b, x, outerPromise }`.
   - Allocates the outer pending `$Promise` (or host Promise via
     `Promise_new` import in JS-host mode — see step 5).
   - Emits `Promise.then(awaited, __cont_1_callback, __cont_1_reject)`.
     - In JS-host mode: build a `__make_callback` wrapping `__cont_1`.
     - In standalone mode: call `emitStandalonePromiseThen` (currently a
       throwing stub; #1373b will fill in. For now, error out at codegen
       with a clear "standalone CPS pending #1326c Phase 1C-B" message
       and fall back to JS-host import path if running in JS-host mode).
   - Returns the outer pending Promise.

2. **`__cont_1` (continuation after first await)** — receives `(captures: externref, awaitValue: externref)`:
   - Restores locals from capture struct (`struct.get`).
   - Binds `y = awaitValue`.
   - Compiles `const z = y + x;`.
   - Compiles `return z;` as: settle `captures.outerPromise` to FULFILLED with `z`.
     - JS-host mode: `Promise_resolve_with_promise(outerPromise, z)` (new
       import — see step 5).
     - Standalone mode: `struct.set $Promise.state := FULFILLED;
       struct.set $Promise.value := z;` plus draining any registered
       callbacks (delegate to `emitStandalonePromiseSettle` — add as a new
       helper in `async-scheduler.ts`).

3. **`__cont_1_reject` (rejection of the first await)** — receives `(captures: externref, reason: externref)`:
   - Settles `captures.outerPromise` to REJECTED with `reason`.
   - This handles the "promise we awaited was rejected, but caller has no
     try/catch" case. If the source has `try { await ... } catch(e) { ... }`,
     **the catch-clause body becomes its own continuation** (see step 7).

**Implementation tactic**: don't write the segmentation by hand. Walk the
AST once with `analyzeAsyncBody`, then for each segment call into the
existing closure-synthesis machinery in `closures.ts:2107-2152` (`emit*
liftedFunc + closureStruct`). Each continuation closure is exactly the
shape `compileArrowAsClosure` already produces — uniform `(captures,
awaitValue) → externref` funcref. Add a thin wrapper:

```ts
// In async-cps.ts
function synthesizeContinuation(
  ctx: CodegenContext,
  parentFctx: FunctionContext,
  segmentStmts: ts.Statement[],
  captures: Set<string>,
  resumeBinding: { name: string; type: ValType } | null,  // the awaited-value binding (e.g. `y` in `let y = await foo()`)
): { funcIdx: number; structTypeIdx: number } {
  // Build a synthetic ts.FunctionExpression node? NO — too invasive.
  // Instead, call into a new helper in closures.ts:
  //   compileSyntheticAsyncContinuation(ctx, captures, segmentStmts, resumeBinding)
  // which mirrors compileArrowAsClosure but accepts statements + a capture set
  // directly, without an AST FunctionExpression wrapper.
}
```

**Add `compileSyntheticAsyncContinuation` to `closures.ts`** alongside
`compileArrowAsClosure`. It is the SAME function as `compileArrowAsClosure`
minus the parameter analysis (we supply the param list directly:
`[capturesParam, awaitValueParam]`) and minus the `body = arrow.body` step
(we supply statements directly). Keep the closure-struct + funcref-table +
lifted-function emission identical.

### Step 5 — Outer Promise allocation + settlement

**JS-host mode** (existing path, default for non-WASI):

Three NEW host imports must be declared (add to the `addUnionImports`
shift list — see `index.ts` `collectPromiseImports` near line 4614, and
the "addUnionImports shifts function indices" guidance in the architect
prompt):

| Import | Signature | Purpose |
|--------|-----------|---------|
| `Promise_new_pending` | `() → externref` | Allocate a new pending Promise + return it. JS side: `let r,j; const p = new Promise((res,rej)=>{r=res;j=rej;}); p.__r=r; p.__j=j; return p;` |
| `Promise_settle_resolve` | `(externref promise, externref value) → ()` | Calls `promise.__r(value)` to settle. |
| `Promise_settle_reject` | `(externref promise, externref reason) → ()` | Calls `promise.__j(reason)`. |

Declare these via the existing `ensureLateImport` mechanism
(`expressions.ts:221` shows the pattern with `Promise_resolve`).

**Standalone (WASI) mode**:

- Allocate pending Promise: `i32.const 0 (PENDING)` + `ref.null.extern`
  (value) + `ref.null.extern` (callbacks) + `struct.new $Promise` +
  `extern.convert_any`. Wrap in a one-liner helper
  `emitStandalonePromiseNew(ctx, fctx)` in `async-scheduler.ts` —
  symmetric to the existing `emitStandalonePromiseResolve`.
- Settle: write `state` and `value` fields via `struct.set`, then drain
  registered callbacks. **The callback-drain depends on #1326c Phase 1C-B
  microtask queue.** Until that lands, error out at codegen with a clear
  message; CPS only works in JS-host mode for now. Mark in PR description.

**Wasm IR pattern (JS-host mode prefix segment):**

```wasm
;; Allocate outer pending Promise
call $Promise_new_pending           ;; → externref (outerPromise)
local.set $outerPromise

;; ... compile prefix segment statements (computeSync(a)) ...

;; Build capture struct { a, b, x, outerPromise }
local.get $a
local.get $b
local.get $x
local.get $outerPromise
struct.new $__cont_1_struct
local.set $captures

;; Compile the awaited expression: foo(b) → externref (the Promise it returns)
local.get $b
call $foo                            ;; → externref (awaited Promise)

;; Make continuation callbacks: __make_callback expects (cbId, captures) → externref
;; The cbId is a compile-time-assigned integer; see closures.ts:2583-2584 pattern.
i32.const <__cont_1 cbId>
local.get $captures
call $__make_callback                ;; → externref (resolve handler)

i32.const <__cont_1_reject cbId>
local.get $captures
call $__make_callback                ;; → externref (reject handler)

;; awaited.then(resolveHandler, rejectHandler)
call $Promise_then_2                 ;; → externref (chained Promise, discarded)
drop

;; Return the outer pending Promise — caller will see settlement later
local.get $outerPromise
return
```

`Promise_then_2` is a 2-argument variant (resolve + reject) — extend
`#1116`'s `.then` dispatch to emit this when both callbacks are supplied.
If `Promise_then` with 1 arg is what's already wired, add `Promise_then_2`
as a new late import alongside it.

### Step 6 — Return value wrapping (acceptance #2)

`async function f() { return await Promise.resolve(42); }` — the issue's
canonical acceptance test.

Flow under the spec above:

1. Prefix segment: empty (the await is the first instruction).
2. Awaited expression: `Promise.resolve(42)` — already returns externref.
3. Capture struct: `{ outerPromise }`.
4. `Promise_then_2(awaitedPromise, __cont_1, __cont_1_reject)`.
5. Return `outerPromise`.
6. `__cont_1(captures, value=42_boxed)` runs as a microtask:
   - Restore `outerPromise` from captures.
   - The `return await X` collapse (joint spec §6.2): when the segment's
     ONLY statement is `return <expr>` and the expression itself is the
     `await` we just resumed from, settle `outerPromise` with the
     `awaitValue` directly (no further wrap). **Detect this in
     `splitBodyAtAwait`** by checking whether the post-await suffix is a
     bare `return awaitValueBinding` — if yes, mark the segment as
     `returnAwaitCollapse: true` and emit a direct
     `Promise_settle_resolve(outerPromise, awaitValue)` settle.

**Default case (non-collapse):**

```ts
async function f() {
  await foo();
  return 7;
}
```

Continuation `__cont_1` ends in:

```wasm
local.get $captures
struct.get $__cont_1_struct $outerPromise
;; value 7 as boxed externref
f64.const 7
call $__box_number                   ;; → externref
call $Promise_settle_resolve
ref.null.extern                      ;; continuation result (callbacks ignore it)
return
```

### Step 7 — try/catch through await (acceptance #3)

The joint spec defers full try/catch-across-await to #1373c (Slice 4).
For #1042's initial PR, implement the **narrow case** that the issue
acceptance criterion #3 requires: a single `try { await X; ... } catch
(e) { ... }` block.

**Approach**: when `analyzeAsyncBody` sees an `await` inside the try-block
of a `TryStatement`, set `hasTryAcrossAwait = true` on the plan AND record
the catch-clause body + parameter on the await point.

For that await, `emitAsyncStateMachine` produces a `__cont_1_reject` whose
body is the **compiled catch clause body**, not the default
"settle-outerPromise-rejected" pattern:

```ts
// Pseudocode for __cont_1_reject of `try { let y = await foo(); ... } catch(e) { return -1; }`
function __cont_1_reject(captures, reason) {
  // Bind catch-clause param `e` to `reason`
  let e = reason;
  // Compile catch-clause body — return -1 → settle outerPromise FULFILLED with -1
  Promise_settle_resolve(captures.outerPromise, -1);
}
```

**Limitation for the initial PR**: only handle the case where the `try`
contains a single statement that IS the await (or `try { stmt; await X;
stmts; } catch ... finally ...` where every statement before the await is
side-effect-only — track in plan and only enable the rewrite when the
pattern matches). Anything more complex (catch-clause with its own
`await`, nested try inside the catch, `finally`) — emit a `reportError`
"unsupported try/catch shape across await — tracking in #1373c" and
fall back to the legacy no-op `await`. **Filed as follow-up
sub-issue.**

**Wasm catch-handler wiring (JS-host mode)**: the catch-clause is just
another continuation closure. The reject handler maps directly:
`Promise.then(awaited, __cont_1, __cont_1_reject_catchclause)`. No Wasm
exception-handling primitives needed in this path — the Promise's
rejection path IS the catch entry.

### Step 8 — Sync throws inside async body (Phase 3A overlap)

For #1042 Slice 2A, leave existing behaviour: `throw` in the prefix
segment is caught by `wrapAsyncCallInTryCatch` at the call site (already
in place at `expressions.ts:236`). A `throw` in a post-await continuation
runs as a microtask without try/catch — the runtime turns it into an
unhandled-rejection on the outer Promise. This is acceptable for Slice
2A; #1373b Phase 3A makes it spec-correct.

To prevent regression: every synthesized continuation function MUST be
wrapped in a `try/catch_all` that settles `captures.outerPromise` to
REJECTED on any escaping wasm exception. Pattern (emit at end of
`synthesizeContinuation`):

```wasm
(try (result externref)
  (do
    <continuation body>
  )
  (catch_all
    local.get $captures
    struct.get $__cont_N_struct $outerPromise
    call $__get_caught_exception
    call $Promise_settle_reject
    ref.null.extern
  )
)
```

`__get_caught_exception` is already a late import (search
`expressions.ts:269`).

### Step 9 — Live-variables analysis (Risk §6.6)

The capture set for each continuation is "locals referenced in any segment
after the await". Implement in `analyzeAsyncBody`:

```ts
function computeLiveAfterEach(plan: AsyncCpsPlan, fn: ts.FunctionLikeDeclaration): void {
  // Reverse pass: build a name set per segment of names referenced.
  // For each segment i, liveAfter[i] = union(referenced(j) for j > i)
  // minus locals declared in segments j > i (those don't need to flow forward).
  const referencedPerSeg: Set<string>[] = ...;
  const declaredPerSeg: Set<string>[] = ...;  // var / let / const declared IN this segment
  for (let i = plan.awaitPoints.length - 1; i >= 0; i--) {
    const live = new Set<string>();
    for (let j = i + 1; j < segments.length; j++) {
      for (const name of referencedPerSeg[j]) {
        if (!declaredPerSeg[j].has(name)) live.add(name);
      }
    }
    plan.liveAfterAwait.set(plan.awaitPoints[i], live);
  }
}
```

**Re-use existing helpers**:

- `collectReferencedIdentifiers(node, into, ownLocals)` — exported from
  `closures.ts:78` (via re-export in `expressions.ts:78`). Walks an AST
  subtree and adds referenced names to `into`.
- `collectFunctionOwnLocals(fn, into)` — exported from `closures.ts`
  (used at line 1242).

**Do not write a new live-variables pass.** Compose these two.

**Param handling**: params are always captured (they're alive from
function entry through to function return because they may be referenced
after any await).

### Step 10 — Edge cases

- **`await` in a non-async context** — already a TS type-check error;
  `expressions.ts:973` (current no-op) handles this defensively because
  the `expr.expression` compiles to whatever it would compile to in sync
  context. Keep the legacy fall-back path (`!fctx.asyncCpsActive`
  branch) so this stays harmless.

- **Nested async functions** — each nested `async function` /
  `async arrow` is compiled independently. `analyzeAsyncBody` MUST NOT
  descend into a nested function expression (use the same descent guard
  as `collectReferencedIdentifiers` — stop at function boundaries).

- **`return await x` collapse** — Step 6 covers this. Detect in
  `splitBodyAtAwait` when the segment is exactly `return <AwaitExpression>;`.

- **`async () => await x` arrow** — same machinery, just enter via
  `compileArrowAsClosure` (`closures.ts:1151`). Check `isAsync` at
  line 1195; if true and the body contains an `AwaitExpression`, call
  `analyzeAsyncBody` + `emitAsyncStateMachine` instead of the regular
  arrow-body compile. **Do this in a follow-up PR** — the initial PR can
  scope to `async function` declarations only and add a clear
  "async arrow with await not yet routed through CPS" reportError +
  fall-back for arrows. File a sub-issue if not covered in #1373b.

- **Async methods on classes / object literals** — same as nested async
  functions. Defer to follow-up PR.

- **Empty body (`async function f() {}`)** — no awaits, no CPS path; the
  Phase 2A entry-point check (`plan.awaitPoints.length > 0` in Step 3)
  skips CPS entirely and the legacy `wrapAsyncReturn` at call sites
  handles wrapping. Verify with a regression test.

- **`await undefined` / `await 42` (non-Promise operand)** — spec says
  `Await` does ToPromise on its operand. JS-host mode: wrap operand in
  `Promise.resolve(...)` before `Promise_then_2`. Detect statically:
  if the operand's TS type is not `Promise<…>` (use the existing
  `unwrapPromiseType` check from `function-body.ts:569`), insert a
  `Promise_resolve(operand)` before the `.then` call.

- **`await await x`** — emit Step 2's "nested await not supported"
  error in the initial PR; the inner await would create a sub-segment.
  File a follow-up sub-issue.

### Step 11 — File map (what each file needs)

| File | Action | Why |
|------|--------|-----|
| `src/codegen/async-cps.ts` | **NEW** | Holds `analyzeAsyncBody`, `emitAsyncStateMachine`, `splitBodyAtAwait`, `computeLiveAfterEach`. ~600 LoC. |
| `src/codegen/expressions.ts` | EDIT line 973 — gate the no-op behind `!fctx.asyncCpsActive`; otherwise call `compileNestedAwait` (initial PR: report unsupported and fall back) | Make await-dispatch CPS-aware |
| `src/codegen/function-body.ts` | EDIT around line 647 (after fctx setup) — call `analyzeAsyncBody`; if awaits present, call `emitAsyncStateMachine` and skip the normal stmt loop | Single async entry point |
| `src/codegen/closures.ts` | ADD `compileSyntheticAsyncContinuation` (new function) — mirror of `compileArrowAsClosure` accepting explicit param list + statement list | Reuse closure pipeline for continuations |
| `src/codegen/async-scheduler.ts` | ADD `emitStandalonePromiseNew` + `emitStandalonePromiseSettle` (settle a pending Promise in place). Standalone CPS is gated on #1326c; helpers stay no-throw stubs that error on call until 1C-B | Standalone mode parity scaffolding |
| `src/codegen/context/types.ts` | ADD `asyncCpsActive?: boolean` field to `FunctionContext` | Signal CPS to the await dispatcher |
| `src/codegen/registry/types.ts` | ADD `rewriteFuncResultType(ctx, typeIdx, ret)` helper if absent | Flip async function return type to externref |
| `src/codegen/expressions/late-imports.ts` | ADD late-import declarations for `Promise_new_pending`, `Promise_settle_resolve`, `Promise_settle_reject`, `Promise_then_2` (or extend existing `.then` dispatch) | JS-host scheduling primitives |
| `src/runtime.ts` | ADD JS implementations of the four new host imports | Provide the resolution loop on the JS side |
| `tests/issue-1042.test.ts` | **NEW** | The five canonical cases from §"Test cases (5 representative)" above |

### Step 12 — Land order and acceptance checks

**Within Slice 2A (this PR):**

1. Create `async-cps.ts` skeleton with `analyzeAsyncBody` (no-op
   `emitAsyncStateMachine` that throws) + tests for analysis only.
2. Add host imports + runtime handlers; verify `runtime.ts` mock works
   for the 5 canonical cases via a unit test that calls the imports
   directly.
3. Wire `compileSyntheticAsyncContinuation` in `closures.ts` (mechanical
   refactor of `compileArrowAsClosure`); add a test that synthesises a
   trivial continuation and ensures the closure struct + funcref are
   registered correctly.
4. Wire `emitAsyncStateMachine` for the **single-await, no-try** case
   (test cases 1, 5).
5. Add multi-segment support for the **sequential-awaits** case (test
   case 2).
6. Add try/catch-across-await for the **narrow** case (test case 3).
7. Add `Promise.all` interleaving — actually a Phase 1B / #1116 path;
   verify it works via CPS without extra code (test case 4).

**Acceptance gates per joint spec §5 and §1042 issue body:**

- `tests/equivalence.test.ts` passes (no regressions).
- `tests/issue-1042.test.ts` — all 5 representative cases.
- Test262 PR delta: target +150 pass (joint spec estimate), no single
  bucket >50 regression, total regression <10.
- Compiled module size: continuation closures add ~1KB per await point
  per async function; document the size impact in the PR description.

### Step 13 — Coordination

- **Do NOT delete** `wrapAsyncReturn` (`expressions.ts:184`) or
  `wrapAsyncCallInTryCatch` (`expressions.ts:236`). They remain the
  legacy path for async functions without awaits. Per joint spec §3
  Phase 1 and §6.1, these stay until #1373b ships and IR coverage is
  100%. Adding a comment to each ("legacy path — Phase 2B/#1373b
  retires") is encouraged.

- **#820c overlap** — the in-progress #820c PR edits
  `src/codegen/expressions/calls.ts` near line 4293 (yield* / iterator
  protocol). #1042 does not touch that file directly in the AST path,
  but Step 5's `Promise_then_2` extension MAY touch the `.then` instance
  dispatch at `calls.ts:3807-3809`. Land #820c first (smaller, surgical),
  then rebase this work on top. Create a `[CONFLICT]` TaskList item if
  the dispatcher region collides.

- **#1373b (Phase 2B) integration** — once this PR lands and exposes
  the `emitAsyncStateMachine` entry, #1373b's `from-ast.ts` IR emission
  + `lower.ts:1773` arms call into the same module via
  `emitAsyncStateMachineFromIr` (Step 1's stub). The IR path is **not**
  blocked on #1326c Phase 1C-B as long as it stays in JS-host mode for
  initial rollout — only standalone CPS is blocked.

- **Test262 watch-list**: `language/expressions/await/*`,
  `language/statements/for-await-of/*` (mostly Phase 1A territory but
  some require real suspension), `built-ins/Promise/all/*`,
  `built-ins/Promise/race/*`, `built-ins/Promise/any/*` (combinator
  interleaving sees real microtask boundaries only after #1042).

### Step 14 — Quick start for the dev

1. `git worktree add /workspace/.claude/worktrees/issue-1042-cps -b issue-1042-cps origin/main`
2. Read §"## Joint architect spec (S53)" at the top of this file +
   `plan/issues/sprints/53/async-cluster-architect-spec.md`.
3. Confirm `closures.ts:1186-1189` (binding-pattern null guard) is present.
4. Create `src/codegen/async-cps.ts` with the exported surface in Step 1.
5. Land the 14 steps as a single PR (joint spec §3 explicitly requests
   one PR series, not five). Use commit boundaries per step for review
   hygiene. Target ~600 LoC.
6. Pre-merge: run `tests/equivalence.test.ts` + `tests/issue-1042.test.ts`.
   Open PR, monitor `.claude/ci-status/pr-<N>.json` per the standard
   `dev-self-merge` skill.

