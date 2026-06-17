---
id: 1042
title: "async/await state-machine lowering (AwaitExpression is currently a no-op)"
status: in-progress
created: 2026-04-11
updated: 2026-06-04
priority: high
feasibility: hard
reasoning_effort: max
goal: async-model
sprint: 63
parent: 1032
depends_on: [680]
required_by: [1058, 1766, 1774]
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
**#1373b** (`plan/issues/1373b-ir-async-cps-lowering.md`)
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

---

## Slice 2A — Dev-Ready Spec, RE-VERIFIED (senior-dev, 2026-06-03)

The S53 architect spec above (Steps 1–14) is the master design and remains
correct in shape. This section **re-verifies every line reference against
current `main` (HEAD `f0e9d798e`, after #1108 landed)**, narrows the scope to
exactly what the tech lead authorized for sprint 58, and records two findings
that materially change the foundation work. **Read this section first, then
the Step-1–14 spec for detail.** Where they disagree on a line number, this
section wins (the older one drifted).

### Scope for sprint 58 (tech-lead authorized)

**Slice 2A only:** single-await, *linear* async-function bodies — no loop, no
branch (`if`/`switch`/`?:` outside the awaited expression), no nested function,
JS-host mode only. Plus the `return await x` collapse. Everything else
(multi-await sequencing, try/catch-across-await, async arrows/methods,
standalone/WASI CPS, nested await) stays gated/legacy and is filed forward.

The *body shapes that must work* in this slice:

```ts
// S1 — return-await collapse (the canonical acceptance test)
async function f() { return await Promise.resolve(42); }     // f() resolves to 42

// S2 — await-then-return-constant
async function g() { await Promise.resolve(); return 7; }     // g() resolves to 7

// S3 — await-bound, used in the tail
async function h(p) { const y = await p; return y + 1; }      // h(Promise.resolve(1)) → 2

// S4 — prefix-sync then single await tail
async function k(a) { const x = a * 2; const y = await foo(); return x + y; }
```

Anything with a second await, a branch, or a loop **must fall through to the
legacy no-op path** (no regression, no CPS) — gate it off cleanly and report a
follow-up rather than emit a half-formed machine.

### Verified current line numbers (corrects the drifted refs above)

| Symbol / site | Spec said | **Verified now** |
|---|---|---|
| `AwaitExpression` no-op | `expressions.ts:973` | **`src/codegen/expressions.ts:1165`** |
| `FunctionContext.asyncCpsActive` | "ADD to context/types.ts" | **already present — `src/codegen/context/types.ts:204`** (Slice 1 added it) |
| async path in `compileFunctionBody` | `function-body.ts:558-647` | **`src/codegen/function-body.ts:560` (fn start), `:569` `isAsync`, `:571` `effectiveRetType`, `:614` ret-type resolve** |
| `ctx.currentFunc = fctx` | `:647` | **`function-body.ts:649`** |
| main body statement loop | `compileStatement` loop | **`function-body.ts:965-966`** (and a separate decl-body loop at `:893-894`) |
| `ctx.currentFunc = null` (body end) | — | **`function-body.ts:994`** |
| `compileArrowAsClosure` | `closures.ts:1151` / `1247` | **`src/codegen/closures.ts:1247`** |
| `collectReferencedIdentifiers` | `closures.ts:78` | **`closures.ts:185`** (re-exported) |
| `collectFunctionOwnLocals` | `closures.ts` (~1242) | **`closures.ts:92`** |
| `analyzeAsyncBody` etc. | "create async-cps.ts" | **`src/codegen/async-cps.ts` EXISTS** (Slice 1, PR #441) — `analyzeAsyncBody` is real; `emitAsyncStateMachine`/`compileNestedAwait` are inert `reportError` stubs; `ASYNC_CPS_ENABLED = false` at `async-cps.ts:38` |
| `rewriteFuncResultType` | "add to registry/types.ts" | **DOES NOT EXIST yet** — must add |
| `emitStandalonePromiseResolve/Reject/Then` | async-scheduler `:171-195` | **`src/codegen/async-scheduler.ts:1089 / :1103 / :1132`** (Then is real now, not a stub) |
| host Promise imports in `runtime.ts` | — | **`Promise_resolve`/`reject`/`new`/`then`/`then2`/`catch`/`finally` all present, `runtime.ts:7835-7846`** |

### Finding 1 — the analysis surface is DONE and correct; only emission is missing

`analyzeAsyncBody` (async-cps.ts:66) already returns a real `AsyncCpsPlan`
with `awaitPoints`, a conservative whole-remainder `liveAfterAwait`, plus
`hasTryAcrossAwait`/`hasUncaughtThrow`. It correctly stops at nested function
scopes. Slice 2A does **not** need to touch analysis except to *consume* it.
For the linear single-await scope, the conservative whole-remainder liveness is
exactly right (one segment after the await ⇒ capture = all locals referenced in
the tail). **Do not rewrite the liveness pass.**

### Finding 2 — the JS-host "deferred Promise" primitives DO NOT EXIST (foundation gap)

The Step-5 design settles the *outer* promise from inside a continuation via
three host imports — `Promise_new_pending`, `Promise_settle_resolve`,
`Promise_settle_reject`. **None of these exist in `runtime.ts`.** What exists is
`Promise_new` (takes an executor), `Promise_then`/`Promise_then2`,
`Promise_resolve`/`reject`. So the continuation cannot reach back and resolve a
pre-allocated pending promise with the primitives available today.

Two ways to close this, pick **(A)** for Slice 2A:

- **(A) `.then`-returns-the-chain model (no new host imports).** Do NOT
  pre-allocate an outer pending promise. Instead the async function returns
  `awaited.then(onFulfilled, onRejected)` directly — the chained promise that
  `.then` returns *is* the function's result promise. The continuation closure
  is `onFulfilled(value) → result`; its return value becomes the resolution of
  the chained promise automatically (JS Promise semantics). This is exactly
  what the `return await x` collapse and the four S1–S4 shapes need, and it uses
  only the **already-wired** `Promise_then`/`Promise_then2` imports. No
  `runtime.ts` change, no `addUnionImports` index-shift risk from new imports.
  - S1 `return await Promise.resolve(42)`: emit `Promise.resolve(42).then(id)`
    where `id` is the identity continuation → resolves to 42. (Or, since the
    operand is already a promise, just return it — see collapse note below.)
  - S2/S3/S4: return `awaited.then(__cont)` where `__cont(value)` runs the tail
    segment (with captured locals) and **returns** the tail's value; the
    chained promise resolves to it.
- **(B) deferred-promise imports.** The Step-5 model. Defer to a follow-up —
  it needs `runtime.ts` handlers + 3 late imports + the `addUnionImports`
  index-shift dance. Not worth it for Slice 2A; model (A) is strictly simpler
  and covers the scope.

**Consequence:** Slice 2A needs **no new host imports and no `runtime.ts`
change**. That removes the single biggest module-wide risk (late-import index
shifting) from this slice. `rewriteFuncResultType` (flip the async fn's wasm
result to `externref`) is still required because the body now returns the
chained promise (externref) rather than the unwrapped value.

### Continuation closure — reuse, don't reinvent

The continuation `__cont(value) → result` is a 1-arg closure that captures the
live locals. **It is the exact shape `compileArrowAsClosure` already produces**
(closures.ts:1247) for `(capturedState..., value) => { tail }`. The cleanest
Slice 2A tactic: **synthesize a `ts.ArrowFunction` node** for the tail segment —
parameter list `[valueParam]`, body = the post-await statements with the
await-binding rebound to `valueParam` — and run it through the existing
`compileArrowAsClosure`. This gets capture-struct + funcref-table + lifted-fn
emission for free and avoids the `compileSyntheticAsyncContinuation` new-function
work in the master spec (which can land later if synthetic-AST proves awkward).
Validate the synthetic-arrow approach on S1 first; if the TS factory node trips
a checker lookup (no symbol for a synthesized node), fall back to the explicit
`compileSyntheticAsyncContinuation` helper (Step-4/master spec).

### `return await x` collapse (must-have for S1)

In `analyzeAsyncBody`'s single-segment case, detect when the entire post-await
remainder is exactly `return <the-await-binding>` OR the function body is
exactly `return await <expr>`. In that case the continuation is the identity
and you can emit `Promise.resolve(<expr>)` (ToPromise) directly as the function
result — no continuation closure at all. This is both the simplest and the
most common shape; implement it first as a standalone fast-path, then the
general `awaited.then(__cont)` path for S2–S4.

### Step plan for Slice 2A (revised, model (A))

1. **`rewriteFuncResultType(ctx, typeIdx, ret)`** — add to
   `src/codegen/registry/types.ts` (narrow: mutate `ft.results = [ret]` only;
   guard `ft.kind === "func"`). ~6 LoC.
2. **Gate + entry hook in `function-body.ts`** (after `:649`, before the body
   loop at `:965`): when `isAsync`, call `analyzeAsyncBody`. Proceed with CPS
   **only if** `plan.awaitPoints.length === 1` AND the body is linear
   (no loop/branch/try/nested-fn — add a `isLinearSingleAwaitBody(plan, decl)`
   predicate). Otherwise fall through to the unchanged legacy path. If CPS:
   `rewriteFuncResultType(..., {kind:"externref"})`, set
   `fctx.asyncCpsActive = true`, call `emitAsyncStateMachine`, then skip the
   normal statement loop. Flip `ASYNC_CPS_ENABLED` to `true` only after the
   gate predicate is in place (the predicate is the real safety, not the const).
3. **`emitAsyncStateMachine`** (replace the inert stub at async-cps.ts:121):
   - Compile the prefix segment (statements before the await) into `fctx.body`.
   - Compile the awaited operand → externref; if its static type is not
     `Promise<…>` (reuse `unwrapPromiseType` probe), wrap in `Promise_resolve`.
   - **Collapse fast-path:** if `return await`/`return <binding>` is the whole
     tail → leave the awaited (ToPromise'd) value on the stack and `return`.
   - **General path:** synthesize the tail arrow, compile via
     `compileArrowAsClosure` → funcref/closure externref; emit
     `Promise_then(awaited, cont)`; `return` the chained promise.
4. **Keep the await dispatcher** at `expressions.ts:1165` as-is for the
   `!fctx.asyncCpsActive` legacy case; when `asyncCpsActive` is true the await
   node is consumed by `emitAsyncStateMachine` and never reaches the dispatcher
   in the linear single-await scope — but defensively route a stray one to
   `compileNestedAwait` (which already `reportError`s "nested await not
   supported").
5. **Tests** — `tests/issue-1042.test.ts`: S1–S4 above via the existing
   `compile` + host-import harness (assert resolved values through a real
   microtask tick), plus a **negative/no-regression** test that a
   two-await / branchy async body still compiles (legacy path) and a
   `tests/equivalence.test.ts` run shows byte-identical output for all
   await-less async functions (gate predicate must exclude them).

Estimated: `rewriteFuncResultType` ~6, gate+predicate ~40, `emitAsyncStateMachine`
~120, tests ~120 → **~290 LoC**, matching the tech-lead's 200–300 envelope
*because* model (A) drops the host-import/runtime foundation.

### Risk register (Slice 2A specific)

- **Return-type flip blast radius.** `rewriteFuncResultType` changes the wasm
  result for every caller of the async fn. The legacy call-site wrap
  (`wrapAsyncReturn`, `expressions.ts:184`) already expects async calls to yield
  an externref-carried promise, so callers should be consistent — but **verify
  with an equivalence test that a sync caller of a CPS'd async fn still type-checks
  in wasm** (the #1 thing that produces module-wide invalid Wasm). This is why
  the gate must be conservative.
- **Recursion / mutual recursion.** A CPS'd async fn that calls itself: the
  recursive call site sees the flipped externref return — fine under model (A)
  since the call yields the chained promise. Add an S3-style recursive case if
  time permits; otherwise exclude recursive async fns from the gate and file
  forward.
- **`compileArrowAsClosure` on a synthesized node.** TS checker may have no
  symbol/type for a factory-created arrow. Probe early (Step 3); fall back to
  `compileSyntheticAsyncContinuation` if it throws.
- **`addUnionImports` index shift.** Model (A) adds **no** new imports, so this
  classic hazard does not apply to Slice 2A. (It returns in model (B)/follow-up.)

### Filed-forward follow-ups (open as sub-issues when Slice 2A lands)

- **#1042-2B** multi-await sequencing (N segments, `Promise_then` chain).
- **#1042-2C** try/catch-across-await (the `onRejected` continuation = compiled
  catch body) — already partly specced in master Step 7.
- **#1042-2D** async arrows + class/object async methods through CPS.
- **#1042-2E** standalone/WASI CPS via `emitStandalonePromiseThen` +
  microtask drain (blocked on #1326c, which has landed — re-evaluate).
- **#1042-2F** deferred-promise host imports (model (B)) only if a future shape
  needs settle-from-outside (e.g. `Promise.all` combinator authored in CPS).

---

## In-progress work (sd-1665, 2026-06-03) — PR1 foundation

Branch: `issue-1042-async-cps` (worktree
`/workspace/.claude/worktrees/issue-1042-cps`, off origin/main 837b1b394).
Lead-confirmed PR1 scope: single + sequential await, JS-host only, behind the
`fctx.asyncCpsActive` gate (kept off by default so emitted Wasm is unchanged);
try/catch-across-await + nested await + async arrows/methods → explicit
`reportError` + legacy fallback.

### Done so far (COMMITTED on branch, all inert behind `ASYNC_CPS_ENABLED=false`, tsc clean)
- **e42882074** — `src/runtime.ts` (~line 7836): the 3 JS-host scheduling
  primitives — `Promise_new_pending` (allocate pending Promise, stash
  `__r`/`__j` resolve/reject capabilities), `Promise_settle_resolve`
  (`p.__r(val)`), `Promise_settle_reject` (`p.__j(reason)`). PLUS
  `compileSyntheticAsyncContinuation` in `src/codegen/closures.ts:2809` — the
  continuation synthesizer (item 1 below, DONE): takes explicit
  `(segmentStmts, captures, resumeBinding)`, emits exported
  `__cb_${cbId}(externref captures, externref awaitValue) -> externref`
  compatible with the `__make_callback` host bridge; restores captured locals
  from a `__cb_cap_${cbId}` struct, binds the awaited result, runs the segment,
  returns `ref.null.extern`. Returns `{cbId, capStructTypeIdx, captures}`.
- **c991edc92** — `splitBodyAtAwait` + `AwaitSplit` in `async-cps.ts` (item 2,
  DONE): pure single-await segmentation into prefix / awaitedExpr /
  resumeBinding / suffix for the 3 canonical shapes (`return await P`,
  `const x = await P; rest`, `await P; rest`). Returns `null` outside the shape
  gate → legacy fallback.
- Issue → `status: in-progress`.
- **4b44f5ae3** — `emitAsyncStateMachine` driver + `emitMakeContinuationCallback`
  (item 3, DONE): prefix → awaited-expr → captures → continuation synth →
  `__make_callback(cbId, capStruct)` → `Promise_then2(awaited, contCb, null)` →
  return chained Promise. `.then`-chaining model (no Promise_new_pending /
  manual settle — the continuation's `return X` is the cb's externref result,
  and `.then`'s returned promise resolves to it).
- **00649ccdb** — function-body.ts activation hook + AwaitExpression gate
  (items 4-5-7, DONE): on eligible JS-host single-tail-await fns,
  `rewriteFuncResultType(externref)` + `asyncCpsActive` + drive the machine +
  skip the normal loop; nested/non-tail await under CPS → `reportError`.

### DESIGN WALL — gate flip blocked (item 9, NOT done in PR1)

Flipping `ASYNC_CPS_ENABLED` → true is a **genuine design wall**, not mechanical.
The existing compiler lowers async functions **synchronously**: a caller does
`f() as any as number` and gets the unwrapped value directly (see
`tests/equivalence/async-function.test.ts` — "await expression is identity
(pass-through)" exercises exactly `const v = await getValue(); return v` and
asserts `test() as any as number === 100`). The CPS lowering changes the async
return model to a **real Promise object** (externref). Flipping the gate
therefore breaks the entire synchronous-async test suite and very likely many
test262 async cases that depend on the sync model.

Turning CPS on requires a **coordinated migration of the synchronous-async
contract** (call sites, await pass-through, the whole async test corpus,
test262 expectations) — a separate, larger effort that needs a product/architect
decision, NOT something to force inside PR1. So **PR1 lands the full driver +
wiring INERT** (gate off): emitted Wasm is byte-identical, existing async tests
pass unchanged (verified: `async-function.test.ts` + `async-await.test.ts` green
with the wiring in). The driver is exercised only when the gate is flipped in a
follow-up that owns the model migration.

Remaining (follow-up, gated): flip `ASYNC_CPS_ENABLED`, migrate the
synchronous-async contract + tests, add `tests/issue-1042.test.ts` (the 5
canonical cases — which require the gate on to pass). The `Promise_new_pending`
/ `Promise_settle_*` runtime primitives committed in e42882074 remain available
if the chosen settle model needs them, but the current driver uses the simpler
`.then`-chaining path and does not require them.

### `__make_callback` contract (confirmed for the driver)
`__make_callback: (i32 cbId, externref captures) -> externref` (index.ts:7060).
The continuation creation site pushes `i32.const cbId` + the captures struct
(`extern.convert_any` to externref) + `call __make_callback` → yields a JS
callback. Pass that callback to `Promise_then2(awaited, contCb, rejectCb)`. The
host dispatches `exports["__cb_${cbId}"](captures, settledValue)` as a microtask
(runtime.ts ~8759). This is the no-funcref-table path — reuse it; do NOT build a
separate funcref table.

### Verified wiring points (current line numbers, post-merge of origin/main)
- `AwaitExpression` no-op: `src/codegen/expressions.ts:1165` (pass-through).
- async dispatch: `src/codegen/function-body.ts:569` (`isAsync` →
  `effectiveRetType = unwrapPromiseType`); statement loop at `:894`/`:966`.
- `compileArrowAsClosure`: `src/codegen/closures.ts:1247` — the continuation
  template (large: closure-id, param/return-type resolution, capture analysis
  with ref-cell boxing, struct synthesis, lifted-func emission).
- `collectReferencedIdentifiers` (closures.ts:185), `collectBindingPatternNames`
  (closures.ts:384) — reused by `analyzeAsyncBody`.
- `fctx.asyncCpsActive` field already present (context/types.ts:204).
- Promise host imports present in runtime.ts: `Promise_resolve/reject/new/then/
  then2/catch/finally` + `_maybeWrapCallable` callback bridge.
- `analyzeAsyncBody` (async-cps.ts:66) is real: await collection (no nested-fn
  descent) + conservative whole-remainder live-vars + try-across-await /
  uncaught-throw detection. `emitAsyncStateMachine`/`compileNestedAwait` are
  `reportError` stubs (gated off by `ASYNC_CPS_ENABLED = false`).

### Remaining (resume here — `emitAsyncStateMachine` driver is the next + heaviest piece)
1. ✅ DONE (e42882074) — `compileSyntheticAsyncContinuation` (closures.ts:2809).
2. ✅ DONE (c991edc92) — `splitBodyAtAwait` + `AwaitSplit` (async-cps.ts).
3. `emitAsyncStateMachine`: alloc outer pending Promise (`Promise_new_pending`);
   compile prefix segment; build capture struct; compile awaited expr; wrap
   continuations via `__make_callback`; `Promise_then2(awaited, contCb,
   rejectCb)`; return outer Promise. Continuation settles outer Promise via
   `Promise_settle_resolve`. `return await X` collapse per spec §6.2.
   Wrap each continuation in `try/catch_all` → `Promise_settle_reject` on escape.
4. function-body.ts hook (~after fctx built, before stmt loop): `analyzeAsyncBody`;
   if `awaitPoints.length>0` AND JS-host AND no try-across-await/nested →
   `rewriteFuncResultType(externref)`, set `asyncCpsActive`, drive
   `emitAsyncStateMachine`, skip stmt loop. Else legacy path.
5. AwaitExpression gate (expressions.ts:1165): `!asyncCpsActive` → legacy
   pass-through; else `compileNestedAwait` (reportError in PR1).
6. late-import decls for `Promise_new_pending` / `Promise_settle_resolve` /
   `Promise_settle_reject` / `Promise_then2`.
7. `rewriteFuncResultType(ctx, typeIdx, ret)` in registry/types.ts (mutate
   `.results` only).
8. `tests/issue-1042.test.ts` — 5 canonical cases (identity await=42, sequential
   side-effect ordering, try/catch reject, Promise.all interleave, return-await).
9. Flip `ASYNC_CPS_ENABLED`/the function-body gate on for JS-host async-with-await.

### Continuation-synthesis primitive (key finding, 2026-06-03)
Reuse the existing **`__make_callback` host bridge** (closures.ts:2351
`compileArrowAsHostCallback`, creation site ~:2701 — pushes `cbId` + captures
externref, calls `__make_callback` → JS-callable externref) rather than
hand-rolling funcref-table plumbing. `Promise_then2(awaited, contCb,
rejectCb)` takes those externref callbacks directly; the JS host invokes them
arity-1 with the settled value (via `_maybeWrapCallable`, already wired in
runtime.ts). So `compileSyntheticAsyncContinuation` = assign a `cbId`,
synthesize a lifted fn `(captures, awaitValue) → externref` that restores
locals from the capture struct (struct.get) then runs the post-await segment,
register it in the same cbId dispatch table `__make_callback`/`__call_fn_N`
use, and at the state-machine site emit `cbId` + captures-struct +
`call __make_callback`. Source from a statement list + explicit capture set
instead of an arrow AST node. Branch merged with latest origin/main (incl.
#1103a Map) — clean.

---

## Slice 2A — runtime-validated blockers (senior-dev, 2026-06-03)

**Status update that supersedes the "flip a dead no-op" framing.** The entire
Slice 2A machinery is *already implemented and wired*, gated only by
`ASYNC_CPS_ENABLED = false` (`src/codegen/async-cps.ts`):

- `analyzeAsyncBody`, `splitBodyAtAwait`, `emitAsyncStateMachine`,
  `emitMakeContinuationCallback` — all real (commits `f02d12c00`,
  `c991edc92`, `4b44f5ae3`).
- `compileSyntheticAsyncContinuation` + `AsyncCapture` — real in
  `src/codegen/closures.ts:2775/2809`.
- `__make_callback` (declarations.ts:1221 + runtime.ts:8861 dispatch on
  `__cb_${id}`) and `Promise_then2` (runtime.ts:7911) host imports — real.
- Activation hook in `function-body.ts:981-1003` (gated on `ASYNC_CPS_ENABLED`,
  `isAsync`, not-wasi/standalone, single-await + no-try + `splitBodyAtAwait`
  accepts) → `rewriteFuncResultType(ctx, func, externref)` (function-body.ts:59),
  `fctx.asyncCpsActive = true`, `emitAsyncStateMachine`, skip the stmt loop.
- The await dispatcher at `expressions.ts:1165` already routes a stray
  CPS-mode await to a `reportError`.

So the remaining work is **flip the gate + fix what the flip exposes**, not
new emission code. I flipped `ASYNC_CPS_ENABLED = true` locally and exercised
the four canonical shapes (`return await g()`, `await g(); return 7`,
`const y = await h(); return y+1`, plus the no-await control). Findings:

### Compiles cleanly (no Wasm-validation error)

All four shapes produce valid Wasm with the gate on. The no-await async fn
correctly stays on the legacy synchronous path (the gate predicate excludes
it — `awaitPoints.length === 1` is required). So `rewriteFuncResultType` and
the gate predicate are sound; there is **no module-wide invalid-Wasm blast
radius** (the spec's top risk does not materialise for the linear scope).

### Pre-existing legacy bug confirmed (motivation, not regression)

With the gate OFF, `return await realPromise()` / `const y = await
realPromise()` already return `null`/wrong — the legacy path fakes async
synchronously and only "works" when the awaited value is synchronously
available. CPS is what fixes this; it is not introducing the failure.

### BLOCKER 1 — late-import index shift on the OUTER async body (the real gate)

Runtime trace (Node, real host `Promise_then2`/`__make_callback`): with the
gate on, `__make_callback` fires but **`Promise_then2` never does**, and the
async fn returns the *callback function itself* instead of the chained
promise. The WAT prints `call 2` = `Promise_then2` (symbolic resolution is
correct), but the **binary's raw funcIdx is stale**. Root cause: the outer
`$f` body emits `call __make_callback` / `call Promise_then2` with funcIdx
values captured at emit time, but those two are added via `ensureLateImport`
during `emitAsyncStateMachine`, and `__box_number` (added while coercing the
awaited value) lands at a *different* relative position run-to-run
(observed import orders: `g, __make_callback, Promise_then2, __box_number`
for return-await vs `g, __box_number, __make_callback, Promise_then2` for
`await; return 7`). The outer `fctx.body` is **not** in `ctx.liveBodies`
during emission, so the shift walker never patches its `call` opcodes — the
classic late-import index-shift hazard the spec flagged as risk #1.

What I tried (reverted — kept the tree byte-identical / gate-off):
- Adding `ctx.liveBodies.add(fctx.body)` for the whole `emitAsyncStateMachine`
  span (mirroring `compileSyntheticAsyncContinuation`'s own
  `liveBodies.add(cbFctx.body)` at closures.ts:2854). **Necessary but not
  sufficient** on its own — still returned `undefined`.
- Also calling `flushLateImportShifts(ctx, fctx)` at the end → **double-counts**
  the delta on top of the live-body shifts and causes infinite recursion
  (`$f` ends up calling itself). So liveBodies-membership and an explicit
  flush are mutually exclusive; pick one.

**The robust fix (recommended for the follow-up):** pre-register
`__make_callback` and `Promise_then2` **upfront** via a `collectAsyncCpsImports`
prepass — exactly the pattern `collectCallbackImports` (index.ts:7066) uses for
`__make_callback` when an arrow/function-expression is present (it scans the
source and `addImport`s upfront so `funcMap` carries a stable index). A bare
`async function f(){ return await g(); }` has no arrow, so that prepass does
**not** fire, which is why `emitAsyncStateMachine` is forced onto the
late-import path. Add a sibling prepass that, when the gate is on and any
CPS-eligible async fn is present, pre-registers both imports; then have
`emitAsyncStateMachine` use `ctx.funcMap.get("__make_callback")` /
`ctx.funcMap.get("Promise_then2")` (stable) instead of `ensureLateImport`.
That removes the shift hazard at its source and matches every other
host-callback path. `__box_number` is itself a late import but it is consumed
*inside* the same body before the `Promise_then2` call is emitted, so once the
two callback imports are stable the boxing shift is harmless.

### BLOCKER 2 — `return await` collapse discards the resolved value

For `isReturnAwait`, `emitAsyncStateMachine` synthesizes the continuation with
an empty suffix, and `compileSyntheticAsyncContinuation` falls through to
`ref.null.extern` (closures.ts:2898) — so the chained promise resolves to
`undefined`, not the awaited value. Fix: the `return await` continuation must
be the **identity** — return its `__awaitValue` param (`local.get 1`). I
prototyped this as a `compileSyntheticAsyncContinuation(..., { returnAwaitValue
})` option that emits `local.get 1` instead of `ref.null.extern` at the tail;
it is a clean ~6-line change. (Reverted with the rest.)

### Revised follow-up plan (now that blockers are concrete)

1. `collectAsyncCpsImports` prepass (index.ts, beside `collectCallbackImports`)
   — pre-register `__make_callback` + `Promise_then2` upfront when the gate is
   on and a CPS-eligible async fn exists. ~25 LoC.
2. `emitAsyncStateMachine`: replace the two `ensureLateImport` calls with
   `ctx.funcMap.get(...)` (with a `reportError` if absent). ~6 LoC.
3. `compileSyntheticAsyncContinuation`: add `returnAwaitValue` identity tail.
   ~6 LoC.
4. Flip `ASYNC_CPS_ENABLED = true`; update the
   `tests/issue-1042.test.ts` "gate is OFF" assertion.
5. Tests: S1–S4 resolved-value assertions through a real microtask tick;
   a no-regression test that two-await / branchy async still compiles on the
   legacy path; equivalence-test pass for await-less async fns (gate predicate
   must exclude them — confirmed locally it does).
6. **Watch the existing `tests/async-await.test.ts`**: those tests currently
   expect the *synchronous* legacy result (`getNum()` toBe `42`, not a
   Promise). Flipping the gate makes single-await JS-host async fns return a
   Promise — those assertions must be updated to `await exports.f()`, OR the
   gate predicate must be confirmed to exclude their exact shapes. This is the
   real review surface for the follow-up PR, not the codegen.

Estimate for the follow-up: ~45 LoC of source + ~120 LoC tests + the
`async-await.test.ts` assertion migration. The module-wide return-type-flip
risk is **lower than feared** (compiles clean), but the test-expectation
migration in #6 is the genuine blast radius.

## Slice 2A — IMPLEMENTED + machinery verified correct, gate stays OFF (senior-dev, 2026-06-03)

The three blockers are fixed and the state machine is **end-to-end correct when
it runs** (proven with the gate forced on locally — `tests/issue-1042.test.ts`
`describe.skipIf(!ASYNC_CPS_ENABLED)` block: S1 `return await`, S2 `const x =
await`, S3 `await; return`, prefix-local capture, param+local capture, literal
await, and the two legacy controls all resolve to the right value). What
landed on the branch (all behind `ASYNC_CPS_ENABLED`, gate left **false**):

1. **Blocker 1 (late-import shift) — fixed.** New `collectAsyncCpsImports`
   detection + finalize in the unified collector (`declarations.ts`): when the
   gate is on and a CPS-eligible async fn exists, pre-register `__make_callback`
   + `Promise_then2` + `Promise_resolve` upfront so the driver resolves them via
   `ctx.funcMap.get(...)` (stable) instead of `ensureLateImport` (which would
   not shift the outer body's `call` opcodes — the outer `$f` body is not in
   `ctx.liveBodies`). `emitAsyncStateMachine` now reads the three stable indices
   and `reportError`s if the prepass didn't run.
2. **`await V` PromiseResolve (§27.7.5.3) — added.** The driver wraps the awaited
   value with `Promise_resolve` before `Promise_then2`, so `await <non-thenable>`
   (e.g. `await 41`) resolves to the value instead of throwing on `(41).then`.
3. **Blocker 2 (`return await` collapse) — fixed.**
   `compileSyntheticAsyncContinuation(..., { returnAwaitValue })` emits
   `local.get 1` (the `__awaitValue` param) as the identity tail instead of
   `ref.null.extern`, so the chained promise resolves to the awaited value.
4. **Capture/resume-binding aliasing — fixed.** The resume binding (`const x =
   await P`) is computed *before* the capture set and excluded from it:
   `hoistLetConstWithTdz` allocates a same-named outer local, so `liveAfterAwait`
   listed it, and capturing it snapshotted its uninitialized (0) value and
   shadowed the resumed value in the continuation. (Found via gate-on probe:
   `const x = await inner(); return x+1` returned 1 instead of 42.)

### Why the gate ships OFF — synchronous-consumption contract regression

Flipping `ASYNC_CPS_ENABLED` globally regresses **3 equivalence tests**
(`tests/equivalence/async-function.test.ts` "await expression is identity
(pass-through)"; `tests/equivalence/promise-chains.test.ts` "await expression
passes through value" + "nested async calls"). All three consume a single-await
async fn as a *raw value* — `asyncFn() as any as number` — relying on the legacy
synchronous fakery (#1313/#1727 "compile away"): the legacy path returns the
unwrapped value synchronously, so the cast yields a number. With CPS on, that
async fn returns a real `Promise`, and `Promise as any as number` → **NaN**.

The gate is **per-definition** but the contract is **per-call-site**: a function
cannot know whether a given caller `await`s it (wants a Promise) or consumes it
as a raw value (wants the unwrapped T). A global flip cannot satisfy both. The
existing `asyncResultConsumedAsValue` (expressions.ts:1118) detects the raw-value
case at the *call site*, but the CPS rewrite changes the *callee's* return type,
which all call sites then observe. These three patterns are pervasive in test262
(`async fn` results consumed synchronously), so the global flip would regress
far more than the 3 local cases.

**What turning CPS on for real needs (architect-level — spec risk #1/#6):** the
synchronous-consumption call sites must be taught to *drive* the returned
Promise to its settled value (a synchronous resolve for already-settled
promises), OR the async-fn return-type rewrite must be gated on whole-program
consumption analysis (only rewrite fns that are exclusively `await`ed / consumed
as Promises). Neither is in Slice 2A's linear scope. The machinery is ready and
correct; the remaining work is reconciling the two consumption contracts. Until
then the gate stays `false` (byte-identical legacy codegen — the equivalence
suite and `async-await.test.ts` are unchanged on this branch). Re-route to
architect for the consumption-contract decision before the next flip attempt.
