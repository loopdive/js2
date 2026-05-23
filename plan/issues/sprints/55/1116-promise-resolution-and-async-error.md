---
id: 1116
sprint: 55
title: "Promise resolution and async error handling (210 tests)"
status: ready
created: 2026-04-04
updated: 2026-04-28
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bugfix
goal: async-model
renumbered_from: 855
depends_on: [944]
test262_fail: 210
note: "Verified 2026-05-21: collectPromiseImports at codegen/index.ts:4614 (matches WI1); runtime.ts Promise handlers at L3946 (drifted from ~991). All other line refs (expressions.ts, statements.ts, index.ts) should be re-grepped before dispatch."
---
# #1116 -- Promise resolution and async error handling (210 tests)

## Joint architect spec (S53)

This issue is one of five in the S53 async cluster. The unified architecture,
phase ordering, file map, and risk register live in
`plan/issues/sprints/53/async-cluster-architect-spec.md`. The v2 work-item
plan below is adopted **verbatim** by that spec as **Phase 1B**. Read the
joint spec for cross-issue context (especially the v1-regression discipline
rule — type overrides only at `compileVariableStatement`, never at hoisting).

## Problem

210 tests fail with promise_error. These tests involve Promise resolution, async/await error handling, and async generator interactions. The error category indicates the test's async completion callback was never called or was called with an error.

### Breakdown by category

| Category | Count |
|----------|-------|
| built-ins/Promise | 151 |
| language/module-code | 17 |
| language/expressions | 15 |
| built-ins/Array | 11 |
| language/statements | 8 |
| built-ins/AsyncGeneratorPrototype | 6 |
| built-ins/AsyncFromSyncIteratorPrototype | 1 |
| built-ins/Object | 1 |

### Sample files (from test results)

**1. Promise.all/race/allSettled/any**
Files: `test/built-ins/Promise/all/*.js`, `test/built-ins/Promise/race/*.js`, etc.
Root cause: Promise combinators (all, race, allSettled, any) may not resolve correctly when given arrays of promises with mixed resolve/reject.

**2. Async generator return with broken promise**
File: `test/built-ins/AsyncGeneratorPrototype/return/return-suspendedStart-broken-promise.js`
Error: `Generator must not be resumed.`
Root cause: Async generator's `.return()` with a rejected promise should not resume the generator body.

**3. Async from sync iterator protocol**
File: `test/built-ins/AsyncFromSyncIteratorPrototype/*.js`
Root cause: The bridge between sync and async iterators is not properly implementing the protocol.

**4. Module top-level await**
Files: `test/language/module-code/top-level-await/*.js`
Root cause: Top-level await in modules may not properly propagate promise rejections.

## ECMAScript spec reference

- [§27.2.1.3.2 Promise Resolve Functions](https://tc39.es/ecma262/#sec-promise-resolve-functions) — resolution procedure including thenable detection
- [§27.2.1.4 FulfillPromise](https://tc39.es/ecma262/#sec-fulfillpromise) — transitions state from pending to fulfilled
- [§27.2.1.7 RejectPromise](https://tc39.es/ecma262/#sec-rejectpromise) — transitions state from pending to rejected
- [§27.2.5.4 Promise.prototype.then](https://tc39.es/ecma262/#sec-promise.prototype.then) — creates chained promise with onFulfilled/onRejected handlers


## Root cause in compiler

In `src/codegen/expressions.ts` and `src/codegen/statements.ts`:

1. **Promise combinators incomplete**: `Promise.all`, `Promise.race`, `Promise.allSettled`, `Promise.any` may not properly track the resolution state of all input promises
2. **Async generator return protocol**: The `.return()` method on async generators should handle pending promises without resuming the generator body
3. **Async-from-sync iterator wrapper**: Missing or incomplete bridge between sync iterators and async iteration protocol
4. **Module async completion**: Top-level await in modules needs to signal completion via the test harness's `$DONE()` callback

## Suggested fix

These are complex async protocol issues. Recommended approach:
1. Audit Promise combinator implementations against ES spec
2. Fix async generator return/throw to check generator state before resuming
3. Implement AsyncFromSyncIteratorPrototype wrapper per ES spec 27.1.4

## Acceptance criteria

- Promise combinators (all, race, allSettled, any) work for mixed resolve/reject inputs
- Async generator return with rejected promise does not resume generator
- >=100 of 210 tests fixed

## Test Results (v1, reverted)

191/652 Promise test262 tests pass (29.3%) — up from near 0% baseline for key patterns.
**Reverted in `f572d629` due to 1,451 regressions.** See #944 for bisection analysis.

## Implementation Plan — Dev-Ready Summary (task #88, 2026-05-21)

**Read this first.** The joint cluster strategy is at
`plan/issues/sprints/53/async-cluster-architect-spec.md` §1.4 + §3 Phase 1B
— but a dev only needs this issue file. The deep WI1-WI8 plan lives below;
this section crystallises what is **still actionable** today.

### Status snapshot (verified 2026-05-21)

| WI | Description | Status | Action |
|----|-------------|--------|--------|
| WI1 | `collectPromiseImports` detects allSettled/any/finally/then2/new Promise | **LANDED** at `src/codegen/index.ts:4614` | verify no method name missing |
| WI2 | Static-method dispatch (allSettled/any) | **partial** at `src/codegen/expressions/calls.ts:compileCallExpression` (line ~965) | confirm both names in the existing all/race/resolve/reject block |
| WI3 | `.then`/`.catch`/`.finally` instance dispatch with receiver type guard | **partial** at `src/codegen/expressions/calls.ts:3807-3809` | **CRITICAL: verify the v2 receiver type guard is present.** Without it the v1 regression cascade returns. Pattern in §"WI3" below — guard rejects routing through `Promise_then` unless `recvSym === "Promise"` or apparent type's symbol is `Promise`. |
| WI4 | `new Promise(executor)` | **import LANDED** (`index.ts:4719-4721`); emit-site to verify in `expressions.ts:compileNewExpression` | confirm executor arg passes through |
| WI5 | `compileVariableStatement` + narrow `isPromiseHostCall` (statics + `new` only — NOT instance methods) | **LANDED** at `src/codegen/statements/variables.ts:117` / `:141` | leave alone — extending the predicate is the v1 trap |
| WI6 | Async-void → `Promise.resolve(undefined)` wrap | **TODO** | implement at `compileExpressionBody` ~739 and `compileCallExpression` `isEffectivelyVoidReturn` block (see WI6 below) |
| WI7 | Mark nested async fns in `ctx.asyncFunctions` | **TODO** | add `isAsync` modifier check in `compileNestedFunctionDeclaration` (statements family); see WI7 below |
| WI8 | Runtime `Promise_*` handlers (allSettled/any/new/then2/finally) | **LANDED** at `src/runtime.ts:3946-3972` | verify `Promise_then2` signature `(p, cb1, cb2) → externref` |

### Remaining work (do in this order)

1. **Audit WI3 guard.** If absent, add `recvSym === "Promise" || apparentSym === "Promise"` check BEFORE the existing `Promise_then`/`Promise_catch`/`Promise_finally`/`Promise_then2` routing at `calls.ts:3807`. Without this guard, `.then()` calls on compiled async function results (TS type `Promise<T>`, Wasm type `T`) route through the Promise host import and trap at runtime. **This is the single most regression-prone change in the cluster.** Reproduce v1's failure mode 1 in a unit test before changing anything: `async function f() { return 1; } f().then(v => v)` should NOT route through `Promise_then` because the Wasm-level receiver isn't externref.

2. **WI6 implementation** — wrap async-void calls in `Promise.resolve(undefined)` when the consumer expects externref. Code is in §"WI6" below.

3. **WI7 implementation** — register nested async functions so WI6's `isAsyncCallExpression`/`asyncFunctions.has(name)` detection covers them. Code in §"WI7" below.

4. **Re-baseline** — run `tests/equivalence.test.ts` + targeted test262 buckets `built-ins/Promise/all`, `built-ins/Promise/race`, `built-ins/Promise/allSettled`, `built-ins/Promise/any`, `built-ins/Promise/resolve`, `built-ins/Promise/reject`. Original baseline was 210 fails; expect most landed-WIs already moved the needle. Document current pass count in the PR before claiming "remaining work scope".

### Critical rules (joint spec §6.5, non-negotiable)

- **Never override variable types at hoisting / `collectDeclarations` / `walkStmtForLetConst`.** Only at `compileVariableStatement` (WI5's narrow predicate). v1 broke 828 tests by cascading types through generators and async generators.
- **Never include instance methods (`.then`/`.catch`/`.finally`) in `isPromiseHostCall`.** Only `Promise.resolve/reject/all/race/allSettled/any` and `new Promise()` are guaranteed host Promises. Instance methods on compiled async return values would silently widen the variable to externref and break the next 277 tests.
- **The WI3 receiver guard is the prevention against v1's 666-test regression.** Land any WI3 change behind a unit test that asserts compiled async return + `.then()` does NOT call `Promise_then`.

### Pre-merge checks

- Equivalence tests pass (no regressions).
- `tests/issue-1116.test.ts` covers the 5 representative cases listed in the §"Test cases (5 representative)" section near the bottom of this file.
- Test262 regression ratio < 10%, no single bucket > 50 (per `dev-self-merge` skill).
- If touching `calls.ts:3807` (WI3 guard region), manually verify the four host-Promise patterns AND a compiled-async `.then()` pattern: the first four should call `Promise_then`/`Promise_then2`, the last must not.

### Coordination

- **#820c overlap**: edits the same file (`calls.ts`) but a different region (yield*/IteratorStep ~line 4293). No textual overlap with the 3807 block. Land in either order, rebase second.
- **#1042 dependency**: Phase 2A (#1042) introduces `async-cps.ts` and eventually changes async function bodies to return real Promises. After #1042 ships, the WI3 receiver guard will start matching compiled async returns too — at that point WI3's guard logic can be simplified (TS type `Promise<T>` becomes a reliable signal). Do NOT pre-emptively loosen the guard.
- **#1151 Gap A1** broadens `isAsyncCallExpression` independently; no conflict with #1116's edits.

---

## Implementation Plan (v2) — detailed reference

### Why v1 failed — root cause analysis

Commit `bae201ef` made TWO kinds of changes:

1. **Safe**: Expression-level compilation (allSettled, any, finally, then2, new Promise, ensureLateImport) — these return externref from `compileCallExpression`/`compileNewExpression` and are self-contained.

2. **Dangerous**: Type inference overrides at variable hoisting/declaration — these changed variable types from `resolveWasmType(ctx, varType)` (which unwraps `Promise<T>` → T) to `externref` in 5 places across index.ts and statements.ts. This caused:

**Failure mode 1 (666 tests: "p.then is not a function")**:
The `.then()/.catch()/.finally()` expression handler has NO receiver type guard — it matches ANY `.then()` call. Combined with `ensureLateImport` (which always creates the import on-demand), `.then()` on compiled async function results was routed through `Promise_then`. But compiled async functions return the unwrapped value T (not a Promise), so `T.then(cb)` fails at runtime.

**Failure mode 2 (504 tests: stack balance "not enough arguments")**:
The `isPromiseHostCallExpr` check in `hoistVarDecl`/`walkStmtForLetConst`/`collectDeclarations` was applied to `.then()/.catch()/.finally()` call results. This overrode variable types for intermediate values in async generator codegen, where the hoisted type (now externref) conflicted with the actual Wasm stack values produced by the generator protocol.

**Failure mode 3 (277 tests: null deref)**:
Variables pre-hoisted as externref received `null` as default (Wasm externref default), but downstream code expected the unwrapped T (e.g., f64 default 0). Null deref when accessing properties.

### v2 design principles

1. **Never change variable types at hoisting/collectDeclarations in index.ts** — these affect ALL references to the variable and cascade unpredictably through generators and async generators.
2. **Receiver type guard on instance methods** — the `.then()/.catch()/.finally()` handler must verify the receiver is a host Promise (externref) before routing through the Promise path.
3. **Each work item is independently testable and revertible** — no item depends on another for correctness of existing code.
4. **Expression-level only** — type overrides happen at the `compileVariableStatement` site in statements.ts (where the initializer result type is known), NOT at pre-scan/hoisting time.

### Work Items

#### WI1: Expand `collectPromiseImports` to detect new patterns (index.ts)

**File: `src/codegen/index.ts`**
- Function `collectPromiseImports` (line ~7879)

Add detection for:
- Static methods: `allSettled`, `any` (line ~7891, add to method list)
- Instance method: `.finally` (line ~7898, add to detection condition)
- Separate static vs instance registration (line ~7946): add `instanceMethods` set containing "then", "catch", "finally" to avoid registering them as 1-param imports
- Register `Promise_then2` import when `.then()` with 2+ args is detected — requires counting arguments in the visit function. Type: `(externref, externref, externref) → externref`.

**Pattern to follow**: The existing `collectPromiseImports` registration pattern (line 7950-7954 for statics, 7957-7966 for instance methods).

```typescript
// In the visit function, detection:
if (method === "all" || method === "race" || method === "allSettled" || method === "any" || method === "resolve" || method === "reject") {
  needed.add(method);
}
// ...
if (method === "then" || method === "catch" || method === "finally") {
  // existing receiver type check...
  needed.add(method);
  // Detect .then(cb1, cb2) for Promise_then2
  if (method === "then" && node.arguments.length >= 2) {
    needThen2 = true;
  }
}

// Registration (after the loop):
const instanceMethods = new Set(["then", "catch", "finally"]);
for (const method of needed) {
  if (instanceMethods.has(method)) continue;
  // register as (externref) → externref
}
for (const method of needed) {
  if (method === "then" || method === "catch" || method === "finally") {
    // register as (externref, externref) → externref
  }
}
if (needThen2 && !ctx.funcMap.has("Promise_then2")) {
  // register as (externref, externref, externref) → externref
}
```

**Risk**: None — only adds new imports, doesn't change existing behavior.

---

#### WI2: Expression compiler — add static methods (expressions.ts)

**File: `src/codegen/expressions.ts`**
- Function `compileCallExpression`, the `Promise.all/race/resolve/reject` handler (line ~10348 post-revert, ~10322 current)

Add `allSettled` and `any` to the method name check:
```typescript
(propAccess.name.text === "all" ||
  propAccess.name.text === "race" ||
  propAccess.name.text === "allSettled" ||  // NEW
  propAccess.name.text === "any" ||          // NEW
  propAccess.name.text === "resolve" ||
  propAccess.name.text === "reject")
```

Add `ensureLateImport` fallback for on-demand import creation (in case `collectPromiseImports` missed it due to dynamic patterns):
```typescript
const funcIdx = ctx.funcMap.get(importName) ??
  ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
flushLateImportShifts(ctx, fctx);
```

**Risk**: None — only extends existing pattern to new methods. Returns externref (same as existing methods).

---

#### WI3: Expression compiler — add instance methods with receiver guard (expressions.ts)

**File: `src/codegen/expressions.ts`**
- Function `compileCallExpression`, the `.then()/.catch()` handler (line ~10660 post-revert)

**CRITICAL SAFETY CHANGE**: Add a receiver type guard before the handler:

```typescript
// Handle Promise instance methods: .then(cb1, cb2?), .catch(cb), .finally(cb)
// Promise values are externref; delegate to host imports
// GUARD: Only match when receiver is a host Promise (TS type is Promise)
{
  const method = propAccess.name.text;
  if ((method === "then" || method === "catch" || method === "finally") && expr.arguments.length >= 1) {
    // Verify receiver is actually Promise-typed (not just any object with .then)
    const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
    const recvSym = receiverType.getSymbol()?.name;
    const apparentSym = ctx.checker.getApparentType(receiverType).getSymbol()?.name;
    const isPromiseReceiver = recvSym === "Promise" || apparentSym === "Promise";
    
    if (isPromiseReceiver) {
      // ... existing handler code ...
    }
  }
}
```

This guard prevents routing `.then()` calls on non-Promise receivers (like compiled async function results with TS type `Promise<T>` but Wasm type T) through the Promise host path. When the guard fails, the code falls through to general method dispatch.

**Why this wasn't in v1**: v1 assumed all `.then()` calls on `Promise<T>` typed values were host Promises. But compiled async functions also have `Promise<T>` return types. The guard should check that the receiver's **Wasm-level** value will actually be a host Promise.

**Refinement**: The guard above checks TS type, which is `Promise` for BOTH host Promises and compiled async returns. A more precise guard: check if the receiver expression is itself a host Promise call or a variable initialized from one. However, this is overly complex. A simpler approach: the guard should check if `Promise_then` import exists OR can be late-imported. If the receiver is a compiled async function, its return type at the Wasm level won't be externref, so `compileExpression(receiver)` won't produce externref. Add a check: after compiling the receiver, verify it produced externref before calling `Promise_then`.

**Revised approach** (safer):
```typescript
if (isPromiseReceiver) {
  const useThen2 = method === "then" && expr.arguments.length >= 2;
  const importName = useThen2 ? "Promise_then2" : `Promise_${method}`;
  const funcIdx = ctx.funcMap.get(importName) ??
    ensureLateImport(ctx, importName, /* params */, [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    // Compile receiver
    const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
    // If receiver compiled to non-externref (e.g., f64 from async fn),
    // coerce it — the JS runtime will see the boxed value, and .then()
    // will fail at runtime (correct behavior: compiled async fns don't return Promises)
    if (recvType && recvType.kind !== "externref") {
      coerceType(ctx, fctx, recvType, { kind: "externref" });
    }
    // ... compile callbacks, emit call ...
  }
}
```

Also add:
- `.finally()` support (add to method check)
- `.then(cb1, cb2)` two-callback form (use `Promise_then2` import when 2+ args)
- `ensureLateImport` fallback for on-demand import creation

**Stack balance for .then()**: The old code pushed receiver + cb + null (3 values) for a 2-param import. v2 uses `Promise_then2` (3-param) when 2 callbacks, `Promise_then` (2-param) when 1 callback. No null padding.

**Risk**: Low. The receiver guard prevents matching non-Promise `.then()` calls. Falls through to general dispatch for compiled async results.

---

#### WI4: `new Promise(executor)` support (expressions.ts)

**File: `src/codegen/expressions.ts`**
- Function `compileNewExpression` (line ~15375)

Already exists in current code. After the revert, re-add:
```typescript
// Handle `new Promise(executor)` — delegate to host import
if (ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
  const funcIdx = ctx.funcMap.get("Promise_new") ??
    ensureLateImport(ctx, "Promise_new", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "call", funcIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return { kind: "externref" };
}
```

**Risk**: None — new code path for a previously unsupported pattern.

---

#### WI5: Variable type inference for host Promise initializers (statements.ts)

**File: `src/codegen/statements.ts`**
- Function `compileVariableStatement` (line ~537)

Add `isPromiseHostCall` helper (same function from v1, line ~506):
```typescript
function isPromiseHostCall(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) {
    // Also check new Promise(executor)
    if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
      return true;
    }
    return false;
  }
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const method = expr.expression.name.text;
    // Static methods: Promise.resolve/reject/all/race/allSettled/any
    if (
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "Promise" &&
      (method === "resolve" || method === "reject" || method === "all" ||
       method === "race" || method === "allSettled" || method === "any")
    ) {
      return true;
    }
    // DELIBERATELY OMIT instance methods (.then/.catch/.finally) here.
    // Only static Promise calls and new Promise() are guaranteed to
    // produce host Promise objects. Instance methods on compiled async
    // function results would fail, and we don't want to silently type
    // those variables as externref.
  }
  return false;
}
```

**CRITICAL DIFFERENCE FROM v1**: The v1 `isPromiseHostCall` included `.then()/.catch()/.finally()` on Promise-typed receivers. v2 ONLY matches `Promise.resolve/reject/all/race/allSettled/any` and `new Promise()`. This prevents cascading type overrides through Promise chains on compiled async functions.

Use in `compileVariableStatement` at variable type resolution (line ~710):
```typescript
const wasmType =
  widenedTypeIdx !== undefined
    ? { kind: "ref_null" as const, typeIdx: widenedTypeIdx }
    : (inferredVecType ??
      (decl.initializer && isStringMethodReturningHostArray(ctx, decl.initializer)
        ? { kind: "externref" as const }
        : (decl.initializer && isPromiseHostCall(ctx, decl.initializer)
          ? { kind: "externref" as const }
          : resolveWasmType(ctx, varType))));
```

The local type update logic at line 732-748 handles the mismatch between hoisted type (f64 from `resolveWasmType`) and compile-time type (externref from `isPromiseHostCall`). Condition at line 744: `!(existingIsRef && newIsPrimitive)` — for f64→externref: existingIsRef=false, so condition is `!(false && ...)` = true → update happens. This is safe.

**Hoisting mismatch for `var` declarations**: When a `var p = Promise.resolve(42)` is hoisted, the local gets f64 type and `f64.const 0; local.set` is emitted. At compile time, the type is updated to externref, but the earlier `f64.const 0; local.set` now targets an externref local → Wasm validation error.

**Fix for hoisting mismatch**: DON'T override at hoisting in index.ts. Instead, at the type-update point in `compileVariableStatement` (line 744), when the type IS being updated from primitive to externref, ALSO patch the hoisting default value. But this is complex. 

**Simpler fix**: Accept the limitation that `var` declarations of Promises may not work if they're accessed before initialization. In practice, test262 Promise tests use `const`/`let` for Promise variables, not `var`. The `let`/`const` path uses `walkStmtForLetConst` for pre-allocation, which happens at the same block level (not hoisted to function top).

For `let`/`const`, `walkStmtForLetConst` in index.ts pre-allocates the local. If we DON'T override there, it allocates as f64 (unwrapped Promise<T>). Then `compileVariableStatement` tries to update to externref. The update logic (line 732-748) only applies to `isVar` declarations — let/const won't trigger it.

For `let`/`const` that were pre-allocated: look at line 718-722:
```typescript
const isHoistedLetConst = !isVar && existingIdx !== undefined && ...;
const localIdx =
  (isVar || isHoistedLetConst) && existingIdx !== undefined ...
    ? existingIdx
    : allocLocal(fctx, name, wasmType);
```

If `isHoistedLetConst` is true, it reuses the existing slot. The type update at 732-748 only runs for `isVar`. So for let/const, the pre-hoisted type persists and doesn't get updated.

**Full fix for let/const**: Extend the type update logic to also handle `isHoistedLetConst`:

```typescript
// After line 722, extend the type update to let/const pre-allocated locals:
if ((isVar || isHoistedLetConst) && existingIdx !== undefined && existingIdx >= fctx.params.length) {
  const localSlot = fctx.locals[existingIdx - fctx.params.length];
  if (localSlot && wasmType.kind !== localSlot.type.kind) {
    const existingIsRef = localSlot.type.kind === "ref" || localSlot.type.kind === "ref_null";
    const newIsPrimitive = wasmType.kind === "f64" || wasmType.kind === "i32" || wasmType.kind === "i64" || wasmType.kind === "externref";
    if (!(existingIsRef && newIsPrimitive)) {
      localSlot.type = wasmType;
    }
  }
}
```

For `var` hoisting: the default value emission at hoisting time uses `__get_undefined()` for externref locals and `f64.const 0` for f64 locals. If the local is f64 at hoisting but externref at compile time, the `f64.const 0; local.set` is a type error. However, since we DON'T override at hoisting, and the type is only changed at compile time, the body already has the wrong default. To handle this:

**Option A (recommended)**: In `hoistVarDecl` in index.ts, also add the `isPromiseHostCallExpr` check for `var` declarations. This is the ONE place in index.ts where the override is safe, because `hoistVarDecl` runs per-function (not globally) and only affects the function's local variables. Use the NARROW check (static methods + new Promise only, no instance methods).

**Option B**: Don't support `var p = Promise.resolve(...)` — only `let`/`const`. Accept the limitation.

**Recommendation**: Start with Option B. Most test262 Promise tests use `let`/`const` or direct chaining (`Promise.resolve(42).then(cb)`). Add Option A as a follow-up if needed.

**Risk**: Medium. The type update logic is delicate. Test with simple Promise patterns first.

---

#### WI6: Async void → Promise.resolve wrapping (expressions.ts)

**File: `src/codegen/expressions.ts`**
- Function `compileExpressionBody` (line ~739, inside the `VOID_RESULT` handler)
- Function `compileCallExpression` (line ~12286, after `isEffectivelyVoidReturn` check)

When an async function call returns `VOID_RESULT` but the caller expects `externref` (e.g., for `.then()` chaining), wrap the result in `Promise.resolve(undefined)`:

**In `compileExpressionBody`** (line ~742):
```typescript
if (expectedType) {
  // Async functions return Promise<void> at the TS level but void at
  // the Wasm level. When the caller expects externref (e.g., for
  // .then()/.catch()/.finally()), push a resolved Promise.
  if (expectedType.kind === "externref" && ts.isCallExpression(expr)) {
    const tsType = ctx.checker.getTypeAtLocation(expr);
    const symName = tsType.getSymbol()?.name;
    if (symName === "Promise") {
      let resolveIdx = ctx.funcMap.get("Promise_resolve");
      if (resolveIdx === undefined) {
        resolveIdx = ensureLateImport(ctx, "Promise_resolve",
          [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        resolveIdx = ctx.funcMap.get("Promise_resolve") ?? resolveIdx;
      }
      if (resolveIdx !== undefined) {
        fctx.body.push({ op: "ref.null.extern" }); // undefined
        fctx.body.push({ op: "call", funcIdx: resolveIdx });
        return expectedType;
      }
    }
  }
  // ... existing default value handling ...
}
```

**In `compileCallExpression`** (line ~12286):
```typescript
if (isEffectivelyVoidReturn(ctx, retType, funcName)) {
  if (funcName && ctx.asyncFunctions.has(funcName)) {
    let resolveIdx = ctx.funcMap.get("Promise_resolve");
    if (resolveIdx === undefined) {
      resolveIdx = ensureLateImport(ctx, "Promise_resolve",
        [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      resolveIdx = ctx.funcMap.get("Promise_resolve") ?? resolveIdx;
    }
    if (resolveIdx !== undefined) {
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "call", funcIdx: resolveIdx });
      return { kind: "externref" };
    }
  }
  return VOID_RESULT;
}
```

**Risk**: Low. Only adds a value when a void-return async call's result is consumed. Doesn't change the return type of the function itself.

---

#### WI7: Nested async function detection (statements.ts)

**File: `src/codegen/statements.ts`**
- Function `compileNestedFunctionDeclaration` (line ~6780)

Current code tracks generators but not async functions for nested declarations:
```typescript
if (isGenerator) {
  ctx.generatorFunctions.add(funcName);
}
```

Add async detection (requires importing `unwrapPromiseType`):
```typescript
// At top of file, add import:
import { isStringType, isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";

// In compileNestedFunctionDeclaration:
const isAsync = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
if (isAsync) {
  ctx.asyncFunctions.add(funcName);
}

// When resolving return type:
let retType = ctx.checker.getReturnTypeOfSignature(sig);
if (isAsync) {
  retType = unwrapPromiseType(retType, ctx.checker);
}
```

**Risk**: None. Nested async functions currently have TS return type `Promise<T>`, which `resolveWasmType` unwraps. But without registering in `asyncFunctions`, the `isEffectivelyVoidReturn` helper doesn't recognize them as async, so `async function foo() {}` (void return) wouldn't get the Promise.resolve wrapping from WI6.

---

#### WI8: Runtime _vecToArray for Promise combinators (runtime.ts)

**File: `src/runtime.ts`** — line ~3896 (verified 2026-05-21 — drifted from
original ~991; `_vecToArray` at 3896, `Promise_all` handler at 3946)

Already exists in current runtime. After the revert, re-add or verify the `_vecToArray` helper and the `Promise_allSettled`, `Promise_any`, `Promise_finally`, `Promise_then2`, `Promise_new` handlers.

The runtime should have:
```typescript
if (name === "Promise_all") return (arr: any) => Promise.all(_vecToArray(arr));
if (name === "Promise_race") return (arr: any) => Promise.race(_vecToArray(arr));
if (name === "Promise_allSettled") return (arr: any) => Promise.allSettled(_vecToArray(arr));
if (name === "Promise_any") return (arr: any) => (Promise as any).any(_vecToArray(arr));
if (name === "Promise_resolve") return (val: any) => Promise.resolve(val);
if (name === "Promise_reject") return (val: any) => Promise.reject(val);
if (name === "Promise_new") return (executor: any) => new Promise(executor);
if (name === "Promise_then") return (p: any, cb: any) => p.then(cb);
if (name === "Promise_then2") return (p: any, cb1: any, cb2: any) => p.then(cb1, cb2);
if (name === "Promise_catch") return (p: any, cb: any) => p.catch(cb);
if (name === "Promise_finally") return (p: any, cb: any) => p.finally(cb);
```

**Risk**: None — adding new import handlers that are only invoked when the compiler registers the corresponding import.

---

### Work item dependency order

```
WI1 (collectPromiseImports) ← no deps, can go first
WI8 (runtime handlers)      ← no deps, can go first
WI2 (static methods)        ← needs WI1 + WI8 for import registration
WI3 (instance methods)      ← needs WI1 + WI8 for import registration
WI4 (new Promise)           ← needs WI8 for runtime handler
WI5 (variable typing)       ← needs WI2/WI3 so expressions produce externref
WI6 (async void wrapping)   ← independent, needs WI1 for Promise_resolve import
WI7 (nested async)          ← independent, improves WI6 coverage
```

**Recommended implementation order**: WI1 → WI8 → WI2 → WI3 → WI4 → WI7 → WI6 → WI5

### Test verification

**Equivalence test**: Add `tests/issue-855.test.ts` with:
```typescript
// Test 1: Promise.resolve chains
`const p = Promise.resolve(42); /* basic resolve */`

// Test 2: Promise.allSettled
`Promise.allSettled([Promise.resolve(1), Promise.reject(2)])`

// Test 3: new Promise(executor)
`new Promise((resolve) => resolve(42))`

// Test 4: .then(cb1, cb2) two-callback form
`Promise.resolve(1).then(x => x + 1, err => 0)`

// Test 5: .finally()
`Promise.resolve(42).finally(() => {})`
```

**Test262 categories to verify** (remove from skip list one at a time):
- `built-ins/Promise` (151 of 210 failures)
- Focus on: `Promise/all`, `Promise/race`, `Promise/allSettled`, `Promise/any`, `Promise/resolve`, `Promise/reject`

## Regression Report (2026-04-05 bisect)

Commit `a337c268` (v2 implementation, merged sprint 38) introduced a **major regression**
confirmed by test262 bisect across 4 commits:

| Commit | Pass | Fail | CE | Delta pass |
|--------|------|------|----|-----------|
| `c97f0806` sprint 37 end | 18,791 | 20,969 | 2,002 | — |
| `87a943d7` #856 | 18,660 | 21,020 | 2,082 | −131 |
| `a337c268` **#1116** | 17,742 | 21,110 | 2,910 | **−918** |
| `6f672a2d` #822 partial fix | 17,704 | 21,199 | 2,859 | −38 |

**Root cause of regression**: `a337c268` introduced +828 compile errors (CE). The v2 receiver
type guard and variable typing changes are causing type mismatches downstream — the 828 new CEs
are not Promise-related tests; they are tests that compiled fine before v2 but now fail with
Wasm type mismatch errors. #822 (`6f672a2d`) partially fixed 51 of those CEs but introduced
38 more test failures, for a net loss of −1,087 passes vs sprint 37 peak.

**Action required**: The v2 implementation must be audited or reverted. The 828 new CEs need
root cause analysis — they are likely caused by the receiver type guard in WI3 or the variable
type override in WI5 producing externref in positions where downstream instructions expect a
different type (f64, ref T, etc.). A senior engineer should:
1. Run `harvest-errors` on the #1116 CE failures to identify the new CE patterns
2. Either fix the type guard / variable typing logic, or revert v2 and approach more surgically
3. Ensure any fix does not re-introduce the 1,451 regressions from v1

**This issue is moved back to ready for re-work.**

### Edge cases

1. **`Promise()` without `new`** → Should throw TypeError. Not handled in this plan (requires a separate `Promise_call_without_new` host import or a compile-time check).
2. **Promise subclassing** → Not supported. `class MyPromise extends Promise` requires prototype chain support beyond current capabilities.
3. **Thenable coercion** → `Promise.resolve(thenable)` where `thenable` has a `.then` method. Handled by the JS runtime's `Promise.resolve()` — no compiler change needed.
4. **Recursive Promise resolution** → `Promise.resolve(Promise.resolve(42))`. Handled by JS runtime.
5. **Compiled async function `.then()` chaining** → Falls through to general dispatch (may fail). Out of scope for this issue — requires architectural changes to make compiled async functions return real Promises.

---

## Status update (2026-05-21 — arch-async, task #79)

### Verified current line numbers and landed-WI inventory

Code-tree reorganised since v2 plan was authored. Verified locations:

- **WI1** `collectPromiseImports` — **`src/codegen/index.ts:4614`** (was ~7879). Already detects `allSettled` / `any` / `finally` / `then2` / `new Promise`. **LANDED.**
- **WI2** static-method dispatch — `src/codegen/expressions/calls.ts:compileCallExpression` (line 965). Add `allSettled`/`any` next to existing `all`/`race`/`resolve`/`reject` block. Partially landed (allSettled/any imports exist in runtime).
- **WI3** instance-method dispatch with receiver guard — **`src/codegen/expressions/calls.ts:3807-3809`** (the `Promise_then2` branch already exists). The receiver type guard required by v2 must precede this block. **Partially landed** — verify guard is present.
- **WI4** `compileNewExpression` `new Promise(executor)` — `index.ts:4719-4721` registers `Promise_new` import. Expression compiler emit-site: `src/codegen/expressions.ts:compileNewExpression`. **Import LANDED.**
- **WI5** `compileVariableStatement` + `isPromiseHostCall` — **`src/codegen/statements/variables.ts:141` / `:117`**. v2's narrow predicate (statics + `new Promise` only, no instance methods) is in place. **LANDED.**
- **WI6** async-void → `Promise.resolve(undefined)` wrap — `compileExpressionBody` line ~739 / `compileCallExpression` `isEffectivelyVoidReturn` block. Status uncertain; verify before re-implementing.
- **WI7** nested async fn detection — `compileNestedFunctionDeclaration` (in `statements.ts` family). Status uncertain.
- **WI8** runtime `Promise_*` handlers — **`src/runtime.ts:3956,3961,3968,3970,3972`**. **LANDED** (allSettled, any, new, then2, finally).

### Conflict notes — #820c overlap

#820c (async-gen object-method yield*, ~39 fails) is in-progress and edits:
- `src/codegen/expressions/calls.ts` — yield*/IteratorStep lowering (~line 4293).
  **No overlap** with #1116's `.then`/`.catch`/`.finally` dispatch block at 3807.
  Both editable in parallel; trivial rebase if both target the same file.
- `src/codegen/closures.ts` — async-gen trampoline. **No overlap** with #1116 (which
  does not touch closures.ts).
- `src/runtime.ts` — #820c adds `__yieldstar_async_*`. **No overlap** with #1116's
  `Promise_*` handler block (different sections).

**Recommended**: Run #820c and remaining-#1116-WIs in parallel; rebase whichever
lands second. Land order with #1042/#1151 — see #1042 status update.

### FAIL estimate (refreshed)

- Original v1 baseline: **210 tests** in `promise_error` category.
- v1 implementation (commit `bae201ef`) reached 191/652 Promise tests passing
  but caused **−1,451 net** regressions; reverted.
- v2 expected pass after full implementation: **≥100 of 210** (acceptance
  criterion). Realistic mid-point: ~120-140 with WI1-WI4 + WI8 alone (already
  partially landed); WI5+WI6+WI7 unlock another ~40-60.
- **Current pass delta vs baseline**: re-measure on current main (much of v2
  has landed). Likely already at +80 to +120 vs the 210 baseline. **Re-baseline
  before declaring remaining work scope.**

### Test cases (5 representative — for `tests/issue-1116.test.ts` if not present)

1. **Promise.allSettled mixed** — `Promise.allSettled([Promise.resolve(1), Promise.reject(2)]).then(r => expect(r).toEqual([{status:"fulfilled",value:1},{status:"rejected",reason:2}]))`
2. **Promise.any first-fulfilled** — `Promise.any([Promise.reject(1), Promise.resolve(2)]).then(v => expect(v).toBe(2))`
3. **new Promise(executor) resolve** — `new Promise(res => res(42)).then(v => expect(v).toBe(42))`
4. **.then(cb1, cb2) two-callback rejection** — `Promise.reject("x").then(v => 0, e => expect(e).toBe("x"))`
5. **.finally cleanup** — `let ran = false; Promise.resolve(7).finally(() => { ran = true; }).then(v => { expect(v).toBe(7); expect(ran).toBe(true); })`

Plus a **regression watch** entry: a generator function returning `Promise<T>` from
nested calls must not have its variable type silently promoted to externref via
hoisting (the v1 cascade root cause). Re-run `tests/equivalence.test.ts` after
each WI lands.

### Remaining sequencing

| WI | Status | Notes |
|----|--------|-------|
| WI1 | LANDED | verify all method names in detect-list |
| WI2 | partial | confirm allSettled/any dispatch in `calls.ts:compileCallExpression` |
| WI3 | partial | **verify receiver type guard is in place** before instance-method routing — this is the v1-regression-prevention rule |
| WI4 | partial | verify `compileNewExpression` emits the call when `Promise_new` import is present |
| WI5 | LANDED | predicate matches v2's narrow definition |
| WI6 | TODO | implement async-void wrap when caller expects externref |
| WI7 | TODO | mark nested async fns in `ctx.asyncFunctions` |
| WI8 | LANDED | verify `Promise_then2` handler signature in runtime |
