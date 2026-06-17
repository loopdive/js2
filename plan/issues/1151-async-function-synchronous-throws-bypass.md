---
id: 1151
title: "Async function synchronous throws bypass Promise.reject wrapping"
status: done
assignee: ttraenkler/dv1
completed: 2026-06-16
created: 2026-04-21
updated: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: high
task_type: architectural
language_feature: async-functions
goal: async-model
sprint: 62
es_edition: es2017
note: "Verified 2026-05-21: function-body.ts isAsync/effectiveRetType drifted from L127-130 to L567-569; wrapAsyncReturn from expressions.ts:163 → L184"
---
# #1151 — Async function synchronous throws bypass Promise.reject wrapping

## Problem

Per spec (ECMA-262 §27.7.5.2 AsyncFunctionStart), an async function must always return a Promise. Any abrupt completion during its body (synchronous throw) must be converted into a **rejected Promise**, not propagate to the caller.

Our compiler currently lets synchronous throws propagate past the async-function boundary:

1. An async function `async function fn() { ... }` compiles to a Wasm function whose return type is the unwrapped `T` (not `Promise<T>`). See `src/codegen/function-body.ts:567-569` (verified 2026-05-21 — was cited as 127-130):
   ```ts
   const isAsync = ctx.asyncFunctions.has(func.name);
   const effectiveRetType = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
   ```
2. At the call site, `wrapAsyncReturn` (`src/codegen/expressions.ts:184`, verified 2026-05-21 — was 163) wraps the returned `T` with `Promise.resolve(...)`.
3. If the body throws synchronously (`__throw_type_error`, Wasm `throw` tag, etc.), the throw propagates past `wrapAsyncReturn`. The caller sees a **trap**, not a rejected Promise.

Effect on callers:
```js
async function fn() { for await (const [[x]] of [[null]]) return; }  // throws TypeError on destructure
fn().then(_, handler)  // handler is never reached — fn() trapped synchronously
```

## Observable failures

26+ test262 tests fail the same way:
- `test/language/statements/for-await-of/async-func-dstr-*-{val-null,elision-iter-close,value-undef}.js` (18)
- `test/language/{expressions/class/dstr,statements/async-generator/dstr}/*-obj-ptrn-rest-skip-non-enumerable.js` (2)
- Plus any TDZ-in-async-default-param test, any `await null`-flavored test, etc.

Reported errors vary across test262 baselines:
- "Cannot convert object to primitive value" (caller destructures the unhandled trap value)
- "Cannot destructure 'null' or 'undefined'" (the TypeError message itself, surfacing as a trap)

Issue #1150 addressed a subset of these incrementally via null-checks in destructuring (PR #243). That is a valid symptom-level fix for specific patterns but does not close the architectural gap.

## Root cause

Async function bodies compile as if they were plain synchronous functions returning `T`. There is no try/catch boundary at the function edge. The language-level requirement "async function always returns a Promise, never throws synchronously" is not enforced by the compiler.

## Fix options

### Option 1 — Wrap async function body in Wasm try/catch (correct, architectural)

Change the async function return type from unwrapped `T` to `externref` (a JS Promise). Body emission becomes:

```
(func $fn (result externref)
  (try
    ...body...
    ;; on fall-through: call Promise_resolve on result
    (return_call $Promise_resolve)
  catch $exn_tag (param externref)
    ;; on catch: call Promise_reject on the caught value
    (return_call $Promise_reject)
  )
)
```

Requires:
- Change `effectiveRetType` for async functions everywhere (function-body.ts, closures.ts, class-bodies.ts, literals.ts, declarations.ts)
- Remove or no-op `wrapAsyncReturn` at call sites (expressions.ts:184)
- Ensure the exception tag used by `__throw_type_error` and all other throwing host imports is catchable at this boundary (it uses JS-thrown exceptions, which Wasm EH can catch via `catch_all` or the externref catch pattern)
- Audit every `unwrapPromiseType(retType, ctx.checker)` callsite to ensure we don't lose the Promise type downstream

Blast radius: moderate-to-large. Deserves an architect-spec.

Payoff: Fixes all 26+ current tests plus every future async-throws-synchronously test in one change. Correct per spec. No symptom whack-a-mole.

### Option 2 — Per-throw-site rejection helpers (incremental, not preferred)

Continue adding null-checks and other pre-throw guards at specific spec violations (what PR #243 did for destructuring null). Leaves the architectural gap open; each new throwing construct needs its own fix.

## Acceptance criteria

- All 26 Bucket C tests (see #1150) pass
- TDZ-in-async-default-param tests pass without per-site null-check
- No regressions in sync-function exception tests, Promise chaining tests, or existing async tests
- PR includes architect spec before implementation

## Key files
- `src/codegen/function-body.ts` — main async return-type decision (`effectiveRetType`)
- `src/codegen/expressions.ts` — `wrapAsyncReturn` at call sites
- `src/codegen/closures.ts` — async arrow/expression parity
- `src/codegen/class-bodies.ts`, `literals.ts` — async methods parity
- `src/codegen/declarations.ts` — function signature registration
- `src/runtime.ts` — `Promise_resolve`, `Promise_reject` imports (already exist)

## Investigation notes (from Bucket C smoke test, 2026-04-21)

11/11 sampled for-await-of + async-gen dstr tests trap synchronously with `"Cannot destructure 'null' or 'undefined'"` from `__throw_type_error`, never reaching their rejection handler. Confirmed that the trap bypasses `wrapAsyncReturn`. No caller-side mitigation is possible without Wasm exception handling at the call boundary, which is equivalent complexity to wrapping the body itself.

## Update — post-#1150 investigation (2026-04-21)

After #1150 (PR #243) merged, the 11 listed for-await-of async-func-dstr tests now PASS. `wrapAsyncCallInTryCatch` in `expressions.ts:201` wraps every async-call site with `try ... catch_all → Promise_reject(__get_caught_exception)`. Body-level sync throws in async functions are properly converted to rejected Promises. Option 1 (body-wrap in try/catch) is therefore NOT required to close the remaining failures.

### Actual remaining gap — async-generator destructure param
6 of 7 async-generator-dstr tests (`test/language/{expressions,statements}/async-generator/dstr/*-val-null.js`, `*-value-undef.js`, `*-named-ary-ptrn-elem-ary-val-null.js`) still fail. Root cause is NOT an async-throws-bypass issue:

These tests use the pattern:
```js
var f = async function*([[x]]) { };
assert.throws(TypeError, () => f([null]));   // param destructure should throw SYNC
```

The spec path is:
1. Call `f([null])` — FunctionDeclarationInstantiation binds param `[[x]]` against `[null]`
2. Destructuring nested pattern `[x]` against null throws TypeError **synchronously** (before generator creation)
3. Test wants sync throw, not rejected Promise

What our compiler does:
- In `closures.ts:878`, `const paramType = ctx.checker.getTypeAtLocation(p)` for an unannotated binding-pattern parameter resolves (via `resolveWasmType`) to **`f64`** rather than `externref`. This is a TS-type-inference artifact for pattern-only params.
- Result: the closure's lifted function signature is `(param f64) (result externref)`.
- In the param-destructure dispatch at `closures.ts:1338`, the `paramType.kind === "externref"` branch is therefore skipped.
- Fallthrough at `closures.ts:1463` calls `allocBindingLocals(param.name)` — this **silently allocates locals without emitting destructure or null-guard code**.
- The WAT for the lifted closure function is a no-op body wrapped in try/catch, producing an async generator with an empty buffer. `f([null])` returns the generator; `assert_throws(fn)` records a failure because `fn()` did not throw.

Verified via WAT inspection: the body of `$__closure_0` for `async function*([[x]]) { }` is just `call __gen_create_buffer; ref.null.extern local.set pendingThrow; try {} catch {} call __create_async_generator`. No param extraction, no null guard.

This is NOT specific to async generators. All function-expression shapes (plain `function`, arrow, `function*`, `async function`, `async function*`) hit the same bug when the param is a binding pattern with no explicit structured annotation. Because callers usually pass a well-typed array/object, the caller-side coercion succeeds, but the destructure null-guard required by spec is missing — any caller passing `null`/`undefined` silently gets no-throw + uninitialized locals.

### Scope of the NEW fix
The fix is narrower and orthogonal to Option 1:

**In `closures.ts:875-886` (`compileArrowAsClosure`): when a parameter's `p.name` is a `BindingPattern` (Array or Object) AND the resolved `wasmType` is not ref/ref_null/externref, override `wasmType` to `externref`.**

Rationale:
- A binding-pattern param inherently destructures an object/array. A numeric or primitive type for the param is nonsensical — you cannot destructure a number.
- Forcing externref routes the destructure into `destructureParamArray` / `destructureParamObject`'s externref branch, which starts with `emitExternrefDestructureGuard` (synchronous TypeError on null/undefined) and then handles every vec-type variant with ref.test guards.
- The call site already passes externref-or-coercible values. Callers that pass well-typed arrays (e.g. `[[1,2]]` literal of shape `__vec_externref`) go through standard `extern.convert_any` coercion. No call-site change needed.

### Files to change
- `src/codegen/closures.ts:878-886` — guard: if `ts.isArrayBindingPattern(p.name) || ts.isObjectBindingPattern(p.name)`, override `wasmType = { kind: "externref" }` unless it's already ref/ref_null (a known struct/vec type).
- Revalidate `closures.ts:1330-1465` — the `destructureParamArray(ctx, liftedFctx, paramIdx, param.name, paramType)` externref branch should now fire for these cases.

### Tests
- The 6 listed async-gen-dstr tests
- Any regressions in existing vec-typed param destructure tests (callers that pass typed `[1,2,3]`)
- Sync generator + plain function-expression destructure tests (currently also silently broken per probe)
- Equivalence tests to catch unrelated breakage

### Scope NOT in this fix
- Option 1 (async-function body-wrap) is DECLINED — #1150 already closes the body-throw path via call-site catch. Re-opening this costs significant rework with no clear added benefit.
- Async-method destructure params in class bodies / object literals (`class-bodies.ts`, `literals.ts`) have their own param-destructure code paths. Likely share the same inference bug; flag as follow-up if regressions surface.

## Implementation Plan — Dev-Ready Summary (task #88, 2026-05-21)

**Read this first.** Joint cluster strategy at
`plan/issues/sprints/53/async-cluster-architect-spec.md` §1.5 + §3 Phase 1A
— but a dev only needs this issue file. The deep architect spec lives below
under §"Implementation Plan (architect spec, 2026-05-20)"; this section
crystallises what is **still actionable**.

### Status snapshot (verified 2026-05-21)

The original framing (sync throws past async boundary causes wasm traps)
was **closed by #1150 / PR #243** via `wrapAsyncCallInTryCatch` at
`src/codegen/expressions.ts:236`. The 11 sampled for-await-of async-func
dstr tests now PASS. **Option 1 (body-wrap, return type → externref) is
DECLINED** per joint spec §6.1 — too much rework, no clear added benefit.

Three narrower gaps remain. Land in this order:

### Gap B — binding-pattern param coercion (ship FIRST, ~8 LOC)

**File:** `src/codegen/closures.ts`

**Site:** the param-type resolution block of `compileArrowAsClosure`. The
fix already EXISTS in tree at lines 1186-1189 per the joint spec verification:

```ts
const hasBindingPattern = ts.isArrayBindingPattern(p.name) || ts.isObjectBindingPattern(p.name);
if (hasBindingPattern && wasmType.kind !== "externref") {
  wasmType = { kind: "externref" };
}
```

**Action**: verify the guard is present and tightens to `kind !== "externref" && kind !== "ref" && kind !== "ref_null"` per the architect-spec §"Changes" version below — a `ref`/`ref_null` to a known struct/vec type IS a valid destructure source and should NOT be widened.

**Mirror sites to audit** (likely have the same bug):

- `src/codegen/class-bodies.ts` ~line 1174 (class-method closure builder)
- `src/codegen/literals.ts` ~line 1303 (object-literal method closure builder)
- `src/codegen/closures.ts:2356-2357` (second `compileArrowAsClosure`-shaped block — `compileFunctionExpression` / class-method shape)

Apply the same coercion to each. Per the 2026-04-21 investigation note,
this bug is NOT async-specific — plain `function`, arrow, `function*`,
`async function`, `async function*` all hit it when the param is an
un-annotated binding pattern.

**Expected delta**: +6 to +35 pass (6 named async-gen-dstr tests + an
unknown count of sync-generator / plain-function / arrow variants).

### Gap A1 — broaden `isAsyncCallExpression` (ship SECOND, ~15 LOC)

**File:** `src/codegen/expressions.ts`

**Site:** function `isAsyncCallExpression` at line 154.

**Current behaviour**: matches an identifier call where `ctx.asyncFunctions.has(name)`, OR resolves the signature and checks the declaration's modifiers for `AsyncKeyword`.

**Misses**:
1. Variable holding an async function ref — TS type carries `Promise<T>` return but the declaration is `const f = asyncFn`, not `async function`.
2. Externref-typed function callbacks `cb: () => Promise<T>` — signature is anonymous, no decl modifiers.
3. Anonymous IIFE / synthetic builders.

**Fix**: after the existing check, add a fallback that asks
`ctx.checker.getTypeAtLocation(expr.expression)`, iterates
`type.getCallSignatures()`, and returns true if any signature's return type
satisfies `unwrapPromiseType(retType, ctx.checker) !== retType` AND the
parent is NOT a `NewExpression`.

**Edge case**: also re-check `decl?.asteriskToken` (async generators are excluded — they return AsyncGenerator, not Promise).

**Edge case**: gate on `!ts.isNewExpression(expr.parent)` — `new` always allocates an object, never a Promise from a constructor return.

**Wasm IR pattern (already in place — do NOT re-emit; just verify the broadened detector fires through to it)**:

```wasm
(try (result externref)
  ;; ... call to async function, leaves T on stack ...
  ;; coerce T → externref if needed
  call $Promise_resolve     ;; from wrapAsyncReturn
catch_all
  call $__get_caught_exception
  call $Promise_reject
end)
```

Standalone (WASI) mode emits a `$Promise` struct.new with state=REJECTED in the catch_all instead.

**Expected delta**: 0-30 pass tests (residual sync-throw traps from indirect async calls). Measure after Gap B lands. **If zero**, leave Gap A2 (body-wrap safety net) closed.

### Gap C — IR scaffolding (DEFERRED — bundle with #1373b gate flip)

**File:** `src/ir/lower.ts`, at the `IrInstrAsyncThrow` lowering site (currently a throwing stub per #1373b Slice 1's gate=false default).

**Action when #1373b flips the gate**: emit a wasm `throw` of the value's externref payload (NOT a `Promise.reject` struct). The enclosing call-site `wrapAsyncCallInTryCatch` already converts wasm throws to rejected Promises — keep it as the single source of truth and avoid double-wrap.

Add a 3-line comment + assertion in the IR lower documenting this contract. Do NOT ship until #1373b's gate-flip PR.

### Files modified summary

| File | Gap | Action |
|------|-----|--------|
| `src/codegen/closures.ts:1186-1189` | B | verify / tighten existing guard |
| `src/codegen/closures.ts:2356-2357` | B | mirror the guard if absent |
| `src/codegen/class-bodies.ts:~1174` | B | mirror the guard |
| `src/codegen/literals.ts:~1303` | B | mirror the guard |
| `src/codegen/expressions.ts:154` | A1 | add `getCallSignatures` fallback |
| `src/ir/lower.ts` (`IrInstrAsyncThrow`) | C | comment + assertion (defer until #1373b gate flip) |

**Total: ~45 LOC + regression-test fixtures.**

### Pre-merge checks

- Run `tests/equivalence.test.ts` (no regressions).
- Add `tests/issue-1151.test.ts` with the 5 representative cases listed in §"Test cases (5 representative)" near the bottom of this file.
- Compile + run targeted test262: `language/{statements,expressions}/async-function/`, `language/{statements,expressions}/async-generator/dstr/`, `language/expressions/class/dstr/async-*`.
- Spot-check pre-existing async-callback-as-variable tests; Gap A1 may newly wrap calls that previously left raw T on the stack — confirm consumers tolerate externref.
- Regression budget: **−5 ≤ Δ ≤ +30**.

### Critical rules

- **Do NOT implement Option 1 (body-wrap)**. It's declined per joint spec §6.1 and architect-spec §"Recommendation" below. Reopen only if a residual cluster of sync-throw traps remains after Gap A1 measures.
- **Do NOT touch `wrapAsyncCallInTryCatch` (`expressions.ts:236`)** — it's the load-bearing safety net from #1150/PR #243. Both the broadened detector (A1) and Gap B feed into it; the wrap itself stays unchanged.
- **Do NOT touch `effectiveRetType` (`function-body.ts:567-569`)**. Changing it is Option 1, which is declined.
- **Do NOT change `await asyncCall()` fast-path** (`expressions.ts:926-929`). The intentional skip of `wrapAsyncCallInTryCatch` when parent is `AwaitExpression` is required for await's passthrough lowering.

### Coordination

- **#820c overlap**: edits `closures.ts` (`__obj_meth_tramp_*` async-gen trampoline) and `expressions/calls.ts` (yield* IteratorStep at ~line 4293). Different functions, same file. Gap B is small (1-line guard + 3 mirrors); rebase second-merging PR. No textual conflict with `compileArrowAsClosure` at line 1151.
- **#1116 overlap**: none with Gap B; potential overlap with Gap A1 if `compileCallExpression`'s dispatch order moves. Verify before edit.
- **#1042 dependency**: Phase 2A (#1042) eventually changes async function return types to externref via CPS. When that lands, Gap A1's broadened detector becomes less critical (every async call gets CPS-wrapped at the body level). Do NOT pre-emptively skip Gap A1 — it must work in the legacy path before #1042 rolls out.

---

## Implementation Plan (architect spec, 2026-05-20) — detailed reference

### Status review

The original framing — "async function bodies throw past the function boundary; caller sees a wasm trap" — was **closed in #1150 (PR #243)** via call-site try/catch wrapping. The current behaviour:

1. **Async function bodies** still compile with unwrapped result type `T` (`function-body.ts:569`, `closures.ts:1208`, `class-bodies.ts:369`, `literals.ts:1308`, `declarations.ts:2219`). No body-level try/catch is emitted.
2. **Async call sites** that the codegen recognises as async are wrapped by `wrapAsyncCallInTryCatch` (`expressions.ts:236`) immediately after `wrapAsyncReturn`. The wrap is gated on `isAsyncCallExpression(ctx, expr)` returning true. Throws emerging from the call become `Promise.reject(__get_caught_exception)` (host mode) or a `$Promise` struct in `REJECTED` state (standalone/WASI mode).
3. **`await asyncCall()`** intentionally skips the wrap (`expressions.ts:926-929`) so the raw `T` is left on the stack for the await's passthrough lowering. A sync throw at this site rethrows in the outer async function, which is itself wrapped by ITS caller — correct per spec, as long as the outer caller's wrap fires.

The 26+ Bucket C failures the ticket was opened for now pass.

### Remaining gaps (this spec covers all three)

1. **Gap A — `isAsyncCallExpression` false negatives.** The detector resolves the call's signature via `expr.expression` identifier or `checker.getResolvedSignature(expr).getDeclaration()`. It misses:
   - Indirect calls through a variable holding the async function: `const f = asyncFn; f();` resolves to the variable's TS type; if the declared type isn't `async`, no `AsyncKeyword` modifier is found on the declaration, and no wrap is emitted.
   - Calls through an externref-typed function reference (closure passed as callback): `cb()` where `cb: () => Promise<T>`. The signature is anonymous; no decl modifiers.
   - Synthetic builder calls in async-generator/async-iter machinery where `expr.expression` is a parenthesised IIFE.
   Symptom in test262: sync throws from these call shapes still trap at the wasm boundary.

2. **Gap B — binding-pattern param without explicit type annotation** (already specified above; covered in `closures.ts:875-886`). Surfaces as the 6 `async-generator/dstr/*-val-null.js` / `*-value-undef.js` family — non-throwing because the destructure was never emitted, not because the throw escaped.

3. **Gap C — compatibility with #1373b Slice 1 (IR async CPS lowering).** Once `supportsAsyncIr` flips on, async-function bodies route through `src/ir/lower.ts` and bypass the legacy `function-body.ts:569` path entirely. The legacy call-site `wrapAsyncCallInTryCatch` still fires (it's keyed on the TS-level signature, not the wasm-level lowering), but the IR lowering may emit its own `Promise.reject` path for `IrInstrAsyncThrow` and double-wrap. We must either (a) have the IR lower emit raw throws and let the call-site wrap convert, or (b) have IR lower emit the rejected promise and have the call-site detect IR-claimed callees and skip the call-site wrap.

### Recommendation: close all three gaps, defer body-wrap (Option 1) indefinitely

Option 1 (wrap the entire async body in `try/catch` and change the return signature to `externref`) is **DECLINED** as a primary fix because:
- It requires changing the return type at 5 codegen sites + every call-site that consumes the unwrapped `T` (await's passthrough lowering, `then`-chain coercions).
- It removes the `await` fast-path that returns raw `T`, forcing every awaited call to extract the value from a Promise struct — a regression vs. today's `await asyncCall()` direct-value lowering.
- The same correctness is achievable at the call site for ~95% of cases via `wrapAsyncCallInTryCatch`. The remaining ~5% (Gap A) is fixable by broadening the detector.

We will instead:
- **A1**: broaden `isAsyncCallExpression` to recognise variable-typed async refs and call_ref dispatches via the TS type's call signatures, falling back to "treat as async if the TS return type is `Promise<T>`".
- **A2**: as a safety net for the remaining detector misses (anonymous IIFEs, builder-synthesised calls), add a generic **opt-in body-wrap** for async functions that are statically reachable from non-await consumers and that contain a sync-throw construct (TDZ access, default-param throw, top-of-body destructure of a binding pattern). This is a narrow Option 1 — emitted only when needed.
- **B**: implement the `closures.ts:878-886` binding-pattern coercion already detailed above.
- **C**: when `supportsAsyncIr` is on, the call-site wrap must remain emitted, but the IR lower's `IrInstrAsyncThrow` must throw a wasm exception (not construct a rejected promise) so the wrap converts it. Gate documented in `src/ir/lower.ts` comment.

### Changes

**File: `src/codegen/expressions.ts`** (Gap A1, ~15 LOC)
- Function `isAsyncCallExpression` (line 154):
  - After the existing identifier + signature-declaration check, add a fallback: ask the TS checker for `getTypeAtLocation(expr.expression)`; iterate `type.getCallSignatures()`; if any signature's return type matches `unwrapPromiseType(retType, ctx.checker) !== retType` (i.e. return is `Promise<T>`) AND the call is NOT directly under `new`, return true.
  - Pattern follows the existing async-generator exclusion logic — re-check `decl?.asteriskToken` if present.
  - Edge case: callees that explicitly return `Promise<T>` from a sync function will now also get wrapped. This is semantically correct — synchronous throws from a function declared to return a Promise still violate the contract.

**File: `src/codegen/expressions.ts`** (Gap A2 safety net, ~10 LOC — DEFERRED until A1 is measured)
- After the wrap site at line 935, no change. Body-wrap is only needed if a follow-up audit finds residual `[in __async_*() ← test]` runtime traps after A1 lands. Track as a separate sub-issue with concrete failing tests rather than implementing speculatively.

**File: `src/codegen/closures.ts`** (Gap B, ~8 LOC — already specified in earlier section)
- Function `compileArrowAsClosure` near line 878:
  ```ts
  let wasmType = resolveWasmType(ctx, paramType);
  // Binding patterns require an externref to destructure; primitive types
  // (f64/i32 from TS inference of an un-annotated pattern param) yield a
  // silent no-op body. Coerce to externref so the destructure routes
  // through emitExternrefDestructureGuard's sync-throw path.
  if (
    (ts.isArrayBindingPattern(p.name) || ts.isObjectBindingPattern(p.name)) &&
    wasmType.kind !== "externref" &&
    wasmType.kind !== "ref" &&
    wasmType.kind !== "ref_null"
  ) {
    wasmType = { kind: "externref" };
  }
  ```
- Mirror change in `class-bodies.ts` near line 1174 and `literals.ts` near line 1303 if the same pattern (`compileMethodAsClosure` / `compileObjectMethodAsClosure`) constructs the param list independently.

**File: `src/ir/lower.ts`** (Gap C scaffolding, comment + assertion only, ~5 LOC)
- At the `IrInstrAsyncThrow` lowering site (currently stub-throwing per #1373b Slice 1's gate=false default):
  - Add a comment: when `supportsAsyncIr` is true, emit a wasm `throw` of the value's externref payload (NOT a `Promise.reject` struct). The enclosing call-site `wrapAsyncCallInTryCatch` (`expressions.ts:236`) will convert it to a rejected promise.
  - Rationale: keeps the call-site wrap as the single source of truth for sync-throw → reject conversion. Avoids double-wrap if both legacy and IR paths are active during the gate-flip transition.

### Wasm IR pattern (already in place — verify, do not re-emit)

```wasm
;; Existing pattern at every async call site (host mode):
(try (result externref)
  ;; ... call to async function, leaves T on stack ...
  ;; coerce T → externref if needed
  call $Promise_resolve     ;; from wrapAsyncReturn
catch_all
  call $__get_caught_exception   ;; pulls the wasm exception value as externref
  call $Promise_reject
end)
```

Standalone (WASI) mode emits a `$Promise` struct.new with state=REJECTED instead.

### Edge cases

- `await asyncCall()` parent → wrap skipped (intentional fast-path). Outer async function's caller wrap catches any sync throw rethrown by await. **No change needed.**
- `new AsyncCtor()` — async ctors are not legal JS, but TS allows declared types with `Promise<T>` return. Skip the wrap for `NewExpression`s. The A1 broadened check must gate on `!ts.isNewExpression(expr.parent)`.
- Async generators (`async function*`) — `isAsyncCallExpression` already excludes via `asteriskToken`. Their semantics are different (return AsyncGenerator, not Promise). Gap B's binding-pattern coercion still applies to them.
- TDZ default-param throw — already handled correctly via the wrap; verified in #1150 PR #243.

### Regression gate

- Compile + run all `test/language/statements/async-function/`, `test/language/expressions/async-function/`, `test/language/statements/async-generator/dstr/`, `test/language/expressions/async-generator/dstr/`, `test/language/expressions/class/dstr/async-*`.
- Spot-check `tests/equivalence.test.ts` for any pre-existing async function expression / arrow tests that pass an async callback as a variable (Gap A1 may newly wrap calls that previously left raw T on the stack — confirm consumers tolerate externref).
- Net regression budget for the PR: −5 ≤ Δ ≤ +30 (B is small and additive; A1 may swing slightly negative if any test relied on the previous no-wrap behaviour for sync return-as-promise).

### Lines of change estimate

- Gap A1: ~15 LOC in `expressions.ts:isAsyncCallExpression`.
- Gap B: ~8 LOC × 3 files (`closures.ts`, `class-bodies.ts`, `literals.ts`) ≈ 24 LOC.
- Gap C scaffolding: ~5 LOC comment + assertion in `src/ir/lower.ts`.
- Total: ~45 LOC plus regression-test fixtures.

### Sequencing

- B is **independent** of A — ship it first. It closes the 6 binding-pattern dstr failures with the lowest risk.
- A1 ships second, broadening the detector. Re-measure test262 after both.
- Open Gap A2 (body-wrap safety net) ONLY if a residual cluster of sync-throw traps remains after A1.
- Gap C scaffolding ships with whatever PR flips `supportsAsyncIr` from default-off to default-on (currently #1373b-claim).

---

## Status update (2026-05-21 — arch-async, task #79)

### Verified line numbers after code reorganisation

The Gap B target is the param-resolution block inside `compileArrowAsClosure`.
Verified its current location:

- **`src/codegen/closures.ts:1151`** — `export function compileArrowAsClosure(...)`
- **`src/codegen/closures.ts:1169-1170`** — the `paramType = getTypeAtLocation(p)` / `wasmType = resolveWasmType(...)` lines. This is **where the Gap B override goes**, not the cited `:875-886` (which referred to an earlier file layout).
- **`src/codegen/closures.ts:2356-2357`** — second `compileArrowAsClosure`-shaped param block (likely `compileFunctionExpression` or class-method closure builder). Audit whether the same fix needs mirroring here for plain `function` / `function*` / class-method shapes — the post-#1150 investigation note explicitly flagged that the bug is NOT specific to async generators.
- **`src/codegen/expressions.ts:154`** — `isAsyncCallExpression` (Gap A1).
- **`src/codegen/expressions.ts:236`** — `wrapAsyncCallInTryCatch` (already shipped, do not touch).
- **`src/codegen/function-body.ts:567-569`** — `effectiveRetType` for async (do not change; Option 1 declined).

### Conflict notes — #820c overlap

#820c (async-gen object-method yield* iterator-protocol, ~39 fails) edits
**`src/codegen/closures.ts`** (async-gen trampoline) AND
**`src/codegen/expressions/calls.ts`** (yield* IteratorStep guard).

- **closures.ts conflict zone**: #820c targets `__obj_meth_tramp_*` emission;
  Gap B targets `compileArrowAsClosure` param-type block at line 1170. These
  are **different functions in the same file** — no textual overlap, but a
  rebase is required for the second-merging PR.
- **No conflict** with #1151 Gap A1's edit (`expressions.ts:isAsyncCallExpression`
  is in `expressions.ts`, not `expressions/calls.ts`).

**Recommendation**: Gap B (one-line `closures.ts` change) is small enough to
land first or second in any order with #820c. Coordinate via `[CONFLICT]`
TaskList item only if the rebase fails.

### FAIL estimate (refreshed)

- Original Bucket C scope: **26+ tests** (for-await-of async-func-dstr family).
  Per the post-#1150 investigation note, the 11 sampled tests now PASS via the
  call-site wrap. The architectural body-wrap (Option 1) is **DECLINED**.
- **Gap B (binding-pattern param coercion)** — **6 tests** in
  `language/{expressions,statements}/async-generator/dstr/*-val-null.js`,
  `*-value-undef.js`, `*-named-ary-ptrn-elem-ary-val-null.js`. Also unblocks
  any sync-generator / plain-function / arrow-function variants that share
  the silent-no-op bug (unknown count; could be +10-30 additional).
- **Gap A1 (broaden `isAsyncCallExpression`)** — **0-30 tests** (residual
  sync-throw traps from indirect async calls, anonymous IIFE async, callbacks
  typed `() => Promise<T>`). Measure after Gap B lands.
- **Gap C (IR scaffolding)** — **0 tests today** (gate is off); pays off only
  when #1373b flips the gate.

Total expected pass delta: **+6 to +35 tests**, regression budget per joint
spec §5: ≤ 10 regressions, no single bucket > 50. Net target: **−5 ≤ Δ ≤ +30**
(per existing "Regression gate" subsection above).

### Test cases (5 representative — for `tests/issue-1151.test.ts`)

1. **Gap B — async-gen null destructure** — `var f = async function*([[x]]) {}; assert.throws(TypeError, () => f([null]))` — must throw SYNCHRONOUSLY, not return a generator.
2. **Gap B — plain function variant** — `function f([[x]]) {} ; assert.throws(TypeError, () => f([null]))` — same bug, non-async surface (confirms fix isn't async-specific).
3. **Gap B — arrow with object destructure** — `const f = ({a}) => a; assert.throws(TypeError, () => f(null))` — externref guard must trip for object pattern too.
4. **Gap A1 — indirect async call** — `async function ax() { throw 1; } const f = ax; f().then(_, e => expect(e).toBe(1))` — variable-typed call must still get wrapped.
5. **Existing pass — for-await-of async-func dstr** (regression watch) — one of the 11 tests from the post-#1150 investigation; confirm still passes after Gap A1 broadens the wrap.

### Sequencing summary

| Gap | Owner | Status |
|-----|-------|--------|
| B — `closures.ts:1170` binding-pattern coercion | dev (1-line + mirror) | DONE (landed on main; guard at closures.ts:1229) |
| A1 — `expressions.ts:154` detector broadening | dev (~15 LOC) | DONE (dev-1587, this PR) |
| A2 — body-wrap safety net | defer | open sub-issue only if residual traps remain |
| C — `src/ir/lower.ts` comment + assertion | senior-dev | bundled with #1373b gate flip |

## Gap A1 implementation (dev-1587, 2026-05-23)

Shipped the detector broadening in `src/codegen/expressions.ts`
`isAsyncCallExpression`. After the existing identifier + decl-modifier checks,
added a fallback: inspect the callee type's CALL signatures
(`ctx.checker.getTypeAtLocation(expr.expression).getCallSignatures()`) and
return true if any return type satisfies `isPromiseType(...)`. Construct
signatures are excluded by `getCallSignatures()` (so `new Foo()` callees never
match); async generators return AsyncGenerator (not Promise) so they remain
excluded.

**Reproduction (verified on current main before the fix):** a callback param
typed `() => Promise<T>` whose body throws synchronously **trapped** at the
wasm boundary — `isAsyncCallExpression` returned false (anonymous signature, no
`async` decl modifier) so `wrapAsyncCallInTryCatch` never fired. After the fix,
the call is recognised as async and the throw surfaces as a rejected Promise.

**Tests:** `tests/issue-1151-gap-a1.test.ts` (4 cases): Promise-returning
callback param, variable-aliased async fn, sync-fn-returns-Promise (still
wrapped — correct per spec), and a negative guard (non-Promise callback NOT
wrapped).

**Regression check:** local async/promise equivalence suites have pre-existing
failures (the `assertEquivalent` harness cannot await Wasm Promise returns) —
verified identical fail set on clean main; my change reduced failed files 5→4
(net-neutral-to-positive). `effectiveRetType`, `wrapAsyncCallInTryCatch`, and
the `await asyncCall()` fast-path were NOT touched, per the critical rules.

**Not in scope / deferred:** Gap A2 (body-wrap safety net) — open only if a
residual sync-throw cluster remains after CI measures A1. Gap C (`src/ir/lower.ts`
`IrInstrAsyncThrow`) — bundled with the #1373b gate flip (senior-dev).

## Gap B residual closed (dv1, 2026-06-16) — object-pattern param RequireObjectCoercible

Gap B (binding-pattern param coercion) was marked DONE, but a residual remained:
the coercion forces `wasmType = externref` for binding-pattern params, yet the
`compileFunctionExpression` arrow/function-expression path
(`closures.ts` → object-pattern arm) routes an externref object pattern to
**`destructureParamObjectExternref`**, which — unlike the array param helper
(`destructureParamArray`, guards at destructuring-params.ts:922) and the
function-DECLARATION path (`destructureParamObject`, guards at :584) — did **not**
emit the spec-mandated RequireObjectCoercible null/undefined guard
(ECMA-262 §8.6.2 step 1).

Symptom (verified on current main, host + standalone):
- `(({a}) => a)(null)` / `(undefined)` → silently returned `undefined`
  instead of throwing a synchronous TypeError.
- `(({}) => 0)(null)` → same (empty pattern must throw too).
- Array-pattern arrows (`([a]) => a`) and `function f({a}){}` declarations
  already threw correctly — asymmetric.

**Fix:** emit `emitExternrefDestructureGuard(ctx, fctx, paramIdx)` at the top of
`destructureParamObjectExternref` (`src/codegen/destructuring-params.ts`). The
guard only throws on null/undefined; valid objects and the two
`destructureParamObject` delegation sites (which already guard first) pass
through unchanged — a second guard on a non-null value is a no-op. +12 LOC.

**Tests:** `tests/issue-1151.test.ts` (8 cases) — arrow object pattern throws on
null/undefined, empty pattern throws on null, nested array pattern regression
watch, and four valid-argument cases (field read, nested read-through, default
key, rest) confirming no false-positive throws. tsc clean; biome clean. The
pre-existing `tests/basic-destructuring.test.ts` etc. failures are a broken
`./helpers.js` harness import (missing in tree, fails identically on main), not
a regression from this change.
