---
id: 2028
title: "new Promise(executor): invoking the host-provided resolve/reject from wasm traps null deref — executor pattern fully broken in JS-host mode"
status: done
assignee: ttraenkler/sen-b
completed: 2026-06-16
sprint: 63
created: 2026-06-10
updated: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: host-interop
language_feature: promises
goal: core-semantics
related: [1950, 1382, 1042, 1326]
origin: "2026-06-10 spec-conformance sweep (async agent): verified on main"
---

# #2028 — host functions flowing INTO wasm as callable params have no bridge

## Problem

```ts
return new Promise<string>((resolve) => { resolve("ok"); });
// wasm: RuntimeError: dereferencing a null pointer at __cb_0
//       (thrown synchronously during new Promise)
// node: promise resolving "ok"
```

Reject path identical — `.catch` receives the RuntimeError, not the
intended reason. Every executor probe (sync resolve, resolve-twice,
reject-after-resolve, via .then, throw-in-executor) hits the same trap.

## Root cause

`src/codegen/expressions/new-super.ts:1748` bridges the executor closure
to the host `Promise_new` import (`src/runtime.ts:7954`, wrapped via
`callback_maker` at `src/runtime.ts:8904`). Inside the lifted callback the
host JS functions `resolve`/`reject` arrive as plain externref, but the
call site compiles them through the WasmGC closure-struct path
(`src/codegen/expressions/calls-closures.ts:568` ref.test/ref.cast +
`struct.get` + `call_ref`) — the cast fails → null → trap.
Host-function-as-callable-param is the inverse of #1382 (wasm closure →
JS-callable) and the same trap mechanism as #1950 (different direction).

## Fix direction

In the closure call path, when the callee value is externref (or the cast
fails), fall back to a host `__call_extern_fn(fn, args)` import instead of
trapping. That bridge also unblocks other host-function-param patterns.

## Acceptance criteria

- Repro resolves "ok"; reject path delivers the reason to .catch
- resolve-twice / reject-after-resolve ignored per §27.2.1.3
- Wasm-closure params unchanged

## Dupe check

#1382 (done) opposite direction; #1950 (ready) wasm closures stored via
push/Map.set. No issue covers host functions as params. New.

## Note for #1042

The async agent also confirmed #1042's scope: `await` on real host
promises never unwraps (NaN values, "132" vs "123" ordering, uncatchable
rejections). #1042's claim that "trivial `Promise.resolve(x)` patterns
work" is stale — `await Promise.resolve(41)` now yields NaN inside wasm.

## Implementation Plan

### Root cause
`new Promise(executor)` (host mode) is bridged at `new-super.ts:1807-1826`: the
executor closure is passed to host `Promise_new` (`runtime.ts:9522`), which wraps
it via `_maybeWrapCallable`→`_wrapWasmClosure` (runtime.ts:1747) so the host can
call `executor(resolve,reject)`. The host JS `resolve`/`reject` are passed into the
wasm closure body as externref params. Inside, `resolve("ok")` is a call whose
callee is a parameter holding a foreign JS function as a plain externref. The
closure-call dispatch (`calls.ts:8970-9000`) compiles it through the WasmGC
closure-struct path (`any.convert_extern`→`emitGuardedRefCast`→`struct.get 0`→
`call_ref`); the guarded cast nulls (a host fn is not a `$closure` struct) and the
struct.get traps: "dereferencing a null pointer".

The existing `__call_function` host fallback (#1712, calls.ts:9063-9159) handles
exactly this but is gated by `calleeMayBeHostCallable` (calls.ts:909), which only
fires for a var initialized from a host-builtin member — the executor's
resolve/reject arrive as function PARAMETERS, so the gate returns false and no
fallback arm is emitted.

### Fix direction
Widen the host-callable fallback so a callee that is a function parameter whose
runtime value may be a foreign callable gets the `__call_function` arm instead of
trapping. `__call_function(fn,thisArg,argsArray)` is already wired — no new import.

### Changes
- `calls.ts` `calleeMayBeHostCallable` (909): add a clause returning true when
  `expr` is an Identifier resolving to a PARAMETER whose local wasm type is
  `externref` (not a `ref $closure`) and whose declared type is a call signature.
  Be conservative: only externref params (a closure-struct param keeps the fast
  `call_ref` path and must NOT pull host imports — #1941 dual-mode constraint).
- Dispatch arm 9063-9159 already builds the guarded `__call_function` fallback;
  with the gate widened the executor call emits both arms (cast succeeds→call_ref;
  cast nulls→__call_function). Reuse the #1712 structure verbatim.
- `new-super.ts:1807-1826`: no change to the bridge; add a comment cross-ref.
- `runtime.ts` `__call_function`: confirm it tolerates a host fn; if it assumes a
  wasm-closure fn, add a `typeof fn === "function"` direct-call fast-path.

### Edge cases
sync resolve→"ok"; reject(reason)→`.catch` gets reason not RuntimeError;
resolve-twice/reject-after-resolve→ignored, host `new Promise` enforces
`[[AlreadyResolved]]` (§27.2.1.3) once the call reaches __call_function — no wasm
guard; sync throw in executor→host wrapper rejects per §27.2.3.1 step 9 (verify the
wasm exception surfaces as a thrown JS value across `__call_fn_2`; if it traps,
note as separate hardening); non-callable executor→host throws TypeError;
**dual-mode**: keep the widened arm host-mode-only (`!standalone && !wasi`, already
the gate at calls.ts:9083) — standalone `new Promise` is the native-`$Promise` path
(#1326); ensure the widened clause does not fire in standalone; **#1941 regression
guard**: pure local-closure programs must NOT pull `__js_array_new`/`__call_function`
(externref-only param restriction ensures this).

### Test-gate plan
`tests/issue-2028.test.ts`: `new Promise<string>((resolve)=>resolve("ok"))`→"ok";
reject delivers reason; resolve-twice ignored; throw-in-executor rejects. test262
`built-ins/Promise/executor-*.js`, `resolve-function-*`, `reject-function-*`,
`create-resolving-functions-resolve.js`/`-reject.js`,
`exception-after-resolve-in-executor.js`. Regression: `tests/equivalence/*closure*`
show no new host imports for pure local-closure cases (assert no `__js_array_new`).

### Spec citations
Promise constructor + resolving functions §27.2.3.1 steps 8-10; CreateResolvingFunctions
`[[AlreadyResolved]]` §27.2.1.3; resolve/reject §27.2.1.3.2/§27.2.1.3.1.

## Root-cause re-analysis (se1, 2026-06-16, sprint 62) — SPEC IS STALE

The documented root cause ("`resolve("ok")` traps null-deref via the closure-
struct dispatch; widen `calleeMayBeHostCallable`") **no longer reproduces on
current main** (`90d965220`). Verified end-to-end:

- The synchronous `RuntimeError: dereferencing a null pointer` is **gone**.
  `new Promise<string>((resolve) => resolve("ok"))` now returns a real host
  `Promise` (instanceof Promise) that **never settles** — no trap, no throw,
  the `.then`/`.catch` callbacks never fire.
- Instrumenting an observable side effect in the executor body (`log = 1;
  resolve("ok"); log = 2;`) shows **`log === 0` after `makeOk()`** — i.e. the
  **executor body never runs at all**.

### What actually happens

`new-super.ts:1848-1867` lowers `new Promise(executor)` as
`compileExpression(executor, externref)` → `call Promise_new`. The executor
arrow is compiled to a **synthetic callback** (`$__cb_0`, registered via
`__make_callback`), NOT a closure struct. At runtime the raw value arriving at
the host `Promise_new` is already `typeof === "function"` (the `__make_callback`
wrapper), so `_maybeWrapCallable(fn, 2)` returns it as-is and native
`new Promise(fn)` calls `fn(resolve, reject)`.

But calling that `__make_callback`-produced wrapper with two real JS functions
**does not dispatch `exports.__cb_0`** — resolve/reject are never invoked and no
exception is thrown (confirmed by hooking every host import: only
`__make_callback` fires during `makeOk()`; `__js_array_new` / `__call_function`
never fire even though `$__cb_0`'s body contains the host-call arm). So the bug
is in the **`__make_callback` id-dispatch / `Promise_new` executor-invocation
bridge** (the #1042/#1326 synthetic-callback machinery), upstream of and
unrelated to the closure-call `struct.get` trap the spec targeted.

### Disposition

- The spec's `calleeMayBeHostCallable` widening was implemented and **does
  correctly remove the (no-longer-occurring) null-deref trap class** for an
  externref-typed callable parameter — a safe hardening — but it is **not
  sufficient**: the executor body never executes, so widening the in-body call
  dispatch can't make resolve/reject settle the promise. Implemented change
  reverted to avoid shipping a behaviourally-inert diff under a "fixed" label.
- **Needs re-spec.** The real fix lives in the `__make_callback` /
  `compileSyntheticAsyncContinuation` host-side dispatch (why does invoking the
  wrapper not reach `__cb_0`?) and/or the `new-super.ts` Promise-executor bridge
  (should the executor be lowered as a closure struct passed to `Promise_new`
  rather than a synthetic `__cb` callback?). This is entangled with the
  async-cps continuation infrastructure (#1042/#1326) — route to architect for a
  fresh `## Implementation Plan` against current main before re-dispatch.
- Acceptance criteria (resolve "ok" / reject reason / resolve-twice ignored)
  remain UNMET; left at `ready` with this updated analysis.

### Blocks dropping the #1796 combinator exclusion (sen-b, 2026-06-16)

#1796 (flip `ASYNC_CPS_ENABLED` on) shipped with `await Promise.all/race/any/allSettled(...)`
**excluded from CPS** (`awaitedExprIsPromiseCombinator` in `async-cps.ts`) because
routing those through the CPS state machine surfaces a host-method
argument-marshaling gap: `await Promise.all(src.getPromises())` mis-marshals the
`declare`-class method `getPromises()` (it compiles to `__get_undefined`, so
`Promise.all` receives `undefined` → "undefined is not iterable"). The same
defect already fails `tests/promise-combinators.test.ts` ×2 on main today
(verified gate-off), independent of #1796 — so these are #2028's failures, not a
#1796 regression. **Once #2028 lands, drop the `awaitedExprIsPromiseCombinator`
exclusion** so combinator awaits CPS-lower too, and the 2 combinator tests should
go green. This is the concrete consumer that re-spec should keep in scope:
host-`declare`-class-method values flowing as arguments into a wasm-side
combinator/host call, not only the executor `resolve`/`reject` callable-param case.

## Re-spec (arch1, 2026-06-16 — against upstream/main 319d43460, with live WAT repro)

**Both prior analyses are partly wrong. Live repro corrects them.** I compiled
`new Promise<string>((resolve) => { resolve("ok"); })` with `compileToWat` on
current main and inspected `$__cb_0`:

- The executor lowers to an exported synthetic callback `$__cb_0` with signature
  `(param externref externref)` = `(captures, resolve)`. It **IS exported**
  (`(export "__cb_0" (func 5))`) and **the host wrapper DOES invoke it** — so the
  se1 "executor body never runs" conclusion is an artifact of the test only
  observing a side-effect that is itself skipped by the trap (see below). The
  body runs.
- Inside `$__cb_0`, the call `resolve("ok")` is compiled through the **WasmGC
  closure-struct dispatch**, NOT a host call:
  ```wat
  local.get 1            ;; the `resolve` param (externref host fn)
  any.convert_extern
  local.tee 4
  ref.test (ref 14)      ;; is it a $closure struct? NO — it's a host JS fn
  (if (result (ref null 14))
    (then ... ref.cast null (ref null 14))
    (else ref.null 14))  ;; cast fails → null
  local.set 2            ;; $__callable_param_0 = null
  ...
  local.get 2
  ref.is_null
  (if (then local.get 4 ref.is_null (if (then global.get 4 throw 0))))  ;; THROWS $__exn
  local.get 6
  struct.get 14 0        ;; (or traps null-deref here on the non-throw path)
  ```
  The `resolve` param holds a real host JS function. `ref.test (ref 14)` (the
  `$closure` struct test) fails, the guarded cast yields null, and the body
  **throws `$__exn` (the #1536 wasm exception) at the null-guard** — which the
  host wrapper propagates as a thrown JS value into native `new Promise`'s
  executor invocation. Native Promise catches it and **rejects the promise with
  that wasm RuntimeError**; `resolve("ok")` is never reached, so the promise
  never fulfils and any post-`resolve` side-effect is skipped. That is precisely
  why se1 saw `log === 0` (the `throw` aborts the body before the second
  assignment) and why the `.then`/`.catch` fulfil path never fires.

### Root cause (definitive)
The **original spec's root cause was correct**: `resolve`/`reject` arrive into
`$__cb_0` as plain externref host functions and the in-body call site dispatches
them through the closure-struct `ref.test`/`ref.cast`/`struct.get`/`call_ref`
path, which fails on a foreign callable. The **fix location** the original spec
named (`calleeMayBeHostCallable`) is also correct, but the gate widening it
prescribed was **not actually implemented in a way that fires for this case** —
`calleeMayBeHostCallable` (`expressions/calls.ts:975-1007`) requires the callee
to be a **`VariableDeclaration` with an initializer referencing a host builtin**
(line 979: `!ts.isVariableDeclaration(decl) || !decl.initializer → return
false`). The executor's `resolve`/`reject` are **`ParameterDeclaration`s**, so
the gate returns `false`, no `__call_function` arm is emitted, and the call
traps. se1's "implemented then reverted as inert" was because the widening they
tried did not cover the parameter case (or covered it but the test's observation
masked the now-correct behaviour).

### Fix (definitive)
Widen `calleeMayBeHostCallable` (`src/codegen/expressions/calls.ts:975`) to ALSO
return `true` when the callee identifier resolves to a **function parameter**
(`decl` is a `ts.ParameterDeclaration`) whose **lowered wasm local type is
`externref`** (NOT a `ref $closure` — a closure-struct param keeps the fast
`call_ref` path) and whose **declared TS type has a call signature**
(`checker.getTypeAtLocation(expr).getCallSignatures().length > 0`). Be
conservative — the externref-typed restriction is what preserves the #1941
dual-mode guarantee (pure local-closure programs whose params are wrapped as
closure structs must NOT pull `__js_array_new`/`__call_function` host imports).

With the gate widened, the existing dispatch arm at
`expressions/calls.ts:9227-9300` (the #1712 `hostCallFallback` block) emits BOTH
arms automatically: the guarded `ref.test (ref 14)` succeeds → `call_ref` fast
path; the cast nulls (host fn) → `__call_function(resolve, undefined, ["ok"])`.
The arm is already gated `!ctx.standalone && !ctx.wasi` (line 9247-9248), so
standalone stays on the native `$Promise` path (#1326) — no change there. **No
new host import**: `__call_function` / `__js_array_new` / `__js_array_push` are
all already wired.

### Why this is sufficient now (vs se1's doubt)
se1 doubted the fix because they believed the body never ran. The WAT proves it
does — the ONLY thing wrong is the in-body `resolve`/`reject` dispatch. Widening
the gate so those two calls take the `__call_function` arm makes `resolve("ok")`
actually invoke the host resolve function, settling the promise. No
`__make_callback`/`Promise_new` bridge change is needed — that bridge already
correctly hands the executor wrapper to native `new Promise`, and native Promise
already passes real host `resolve`/`reject` into `$__cb_0`. The defect is purely
the closure-struct mis-dispatch of those two externref params.

### Changes (file:line, verified on 319d43460)
- **`src/codegen/expressions/calls.ts:975-1007`** (`calleeMayBeHostCallable`):
  after the existing `VariableDeclaration` clause, add:
  ```ts
  // (#2028) A function parameter typed as an externref callable (e.g. the
  // `resolve`/`reject` params of a `new Promise(executor)` — host JS fns
  // arriving as plain externref) must take the __call_function arm, not the
  // closure-struct call_ref path which traps on a foreign callable.
  if (decl && ts.isParameter(decl)) {
    const localIdx = /* resolve via fctx.localMap or symbol */;
    // Only externref-typed params (NOT ref $closure) — preserves #1941.
    const wasmType = /* the param's lowered ValType */;
    if (wasmType?.kind === "externref") {
      const t = ctx.checker.getTypeAtLocation(expr);
      if ((t?.getCallSignatures?.()?.length ?? 0) > 0) return true;
    }
  }
  ```
  NOTE: `calleeMayBeHostCallable` currently takes only `(ctx, expr)` and has no
  `fctx`; the param's lowered wasm type must be obtained from the call site that
  invokes it (the dispatch block at 9227 has `fctx` + `matchedClosureInfo`).
  Implementer choice: either thread `fctx` into `calleeMayBeHostCallable`, or
  add the parameter-callable check inline at the `hostCallFallback` computation
  (line 9245-9257) where `fctx` and the matched closure shape are already in
  scope (this is the lower-risk option — keeps `calleeMayBeHostCallable` pure).
- **`src/codegen/expressions/calls.ts:9245-9257`** (`hostCallFallback`
  computation): this is the recommended single edit point — replace the
  `calleeMayBeHostCallable(ctx, expr.expression)` conjunct with
  `(calleeMayBeHostCallable(ctx, expr.expression) || calleeIsExternrefCallableParam(ctx, fctx, expr.expression))`
  where the new helper does the parameter-typed-externref + call-signature check
  using `fctx.localMap` / `fctx.params` for the lowered type.
- **`src/codegen/expressions/new-super.ts:1848-1867`**: no change to the bridge;
  add a comment cross-referencing this fix.
- **`src/runtime.ts`** `__call_function`: confirm it tolerates a host fn (it
  already does `typeof fn === "function"` direct-call). No change expected.

### Edge cases
- sync `resolve("ok")` → promise fulfils "ok"; `.then` fires.
- `reject(reason)` → `.catch` receives `reason`, not a RuntimeError.
- resolve-twice / reject-after-resolve → ignored. Native `new Promise` enforces
  `[[AlreadyResolved]]` (§27.2.1.3) once the call reaches the host resolve fn —
  no wasm guard needed.
- sync `throw` in executor → with `resolve`/`reject` now dispatching correctly,
  a genuine `throw` in the executor body still surfaces as `$__exn`; the host
  wrapper propagates it and native `new Promise` rejects per §27.2.3.1 step 9.
  Verify the wasm exception crosses `exports.__cb_0(...)` as a thrown JS value
  (it does — #1536 maps `$__exn` to a thrown JS value at the export boundary).
- non-callable executor → native `new Promise` throws TypeError (host-enforced).
- **#1941 dual-mode guard**: a pure local-closure program (`const f = (cb) =>
  cb(); f((x) => x)`) must NOT pull `__call_function` — the externref-only param
  restriction ensures the closure-struct param keeps the `call_ref` path.
  Regression-assert no `__js_array_new` import for such programs.
- **standalone**: the arm is gated `!ctx.standalone && !ctx.wasi`; standalone
  `new Promise` is the native-`$Promise` path (#1326) — confirm the widened
  clause does not fire there.

### Test-gate plan
`tests/issue-2028.test.ts`:
`new Promise<string>((resolve) => resolve("ok"))` → "ok";
`new Promise((_,reject) => reject(new Error("x")))` → `.catch` gets the Error;
resolve-twice → first wins; throw-in-executor → rejects.
test262: `built-ins/Promise/executor-*.js`, `resolve-function-*`,
`reject-function-*`, `create-resolving-functions-resolve.js`/`-reject.js`,
`exception-after-resolve-in-executor.js`.
Regression: `tests/equivalence/*closure*` — assert NO new `__js_array_new` /
`__call_function` imports for pure local-closure cases.

### Spec citations
Promise constructor + resolving functions §27.2.3.1 steps 8-10;
CreateResolvingFunctions `[[AlreadyResolved]]` §27.2.1.3;
resolve/reject §27.2.1.3.2 / §27.2.1.3.1.

### Disposition
**Dispatchable to senior-dev.** Single, well-isolated codegen change with a
verified WAT-level root cause. Lower risk than the prior analyses suggested —
no `__make_callback` bridge surgery required.

---

## Implementation (sen-b, 2026-06-16) — DONE

Implemented arch1's fix in `src/codegen/expressions/calls.ts`. Repro confirmed
on main first (`new Promise((resolve)=>resolve("ok"))` → "dereferencing a null
pointer" when awaited), then fixed.

### What landed
- New helper `calleeIsPromiseExecutorParam(ctx, expr)` next to
  `calleeMayBeHostCallable`. Returns true when the callee identifier resolves to
  a parameter of a **Promise executor** — an arrow/function-expression that is a
  direct argument of `new Promise(...)`. Those params (`resolve`/`reject`) are
  host-supplied JS functions arriving as externref.
- Wired into the `hostCallFallback` gate (`calls.ts` ~9257) as
  `calleeMayBeHostCallable(...) || calleeIsPromiseExecutorParam(...)`. The
  existing `#1712` dispatch block then emits both arms: the closure-struct
  `ref.test` fast path AND the `__call_function(fn, undefined, args)` arm taken
  when the cast nulls (the host-fn case). Arm stays gated `!standalone && !wasi`.
- `tests/issue-2028.test.ts`: resolve→"ok", reject→reason, resolve-twice→first
  wins, resolve+await→derived value, and the #1941 dual-mode guard.

### Critical refinement vs the spec (arch1's externref-type gate was too broad)
arch1's spec proposed gating on "param whose lowered wasm type is externref +
has a call signature". **That is NOT a safe discriminator** — I verified that an
*ordinary* callable param (`cb` in `function apply(cb, v){ return cb(v); }`) is
ALSO lowered as `externref` (the closure struct is recovered dynamically at the
call site via `ref.test (ref $closure)`). Gating on externref-typed-callable
re-emitted the `__call_function`/`__js_array_new` arm for pure local-closure
programs — the exact **#1941 dual-mode regression** the spec warned against
(confirmed: the imports reappeared). The precise, safe discriminator is that the
param's *declaring function is a Promise executor* (direct `new Promise` arg),
whose params are genuinely host-bound. The final helper gates on that.

### Scope finding — the 2 `promise-combinators.test.ts` failures are NOT in scope
The lead/spec expected this fix to recover `tests/promise-combinators.test.ts`
×2 (`Promise.all(src.getPromises())`). It does **not**, and they are a *separate*
defect: `src.getPromises()` is a `declare class` **instance-method** call whose
return value compiles to `__get_undefined` (no host import is even emitted for
the method — verified in WAT). That is host-`declare`-class-method-return
marshaling, unrelated to the executor `resolve`/`reject` *parameter* dispatch
fixed here. Those 2 tests pre-exist red on main and remain red — they need a
distinct fix. **Consequence: the #1796 `awaitedExprIsPromiseCombinator`
exclusion must STAY** until that separate host-method-return marshaling gap is
fixed; #2028 does not enable dropping it. Recommend filing the combinator-arg
marshaling as its own issue.

### Edge cases verified
- resolve → fulfils; reject(Error) → `.catch`/rejects with the Error; resolve
  twice → first wins (native `[[AlreadyResolved]]`).
- sync `throw` in executor → promise rejects (correct), but the rejection reason
  is the bare `WebAssembly.Exception` (message undefined), identical to main —
  a pre-existing #1536 exception-boundary fidelity detail, out of #2028 scope.
- #1941 dual-mode: pure local-closure program pulls NO
  `__call_function`/`__js_array_new` imports (asserted in the test).
- tsc clean; no regressions across async-await / promise-chains / async-function
  / issue-1042 suites (43 passed).
