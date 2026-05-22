---
id: 1473
sprint: 52
title: "host-independence: eliminate JS host error/exception ops for standalone Wasm"
status: ready
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: exceptions, throw/try/catch
goal: host-independence
related: []
note: "Line numbers verified against main 2026-05-21: __throw_type_error registration moved 2464→2527; destructuring-params.ts:148, calls.ts:5600, expressions.ts:269, identifiers.ts:28 all still valid"
---

# #1473 — Eliminate JS host error/exception ops for standalone Wasm

## Problem

Every throw site, every `catch` block that inspects the caught value,
and every spec-mandated implicit error (ReferenceError on a TDZ
binding, TypeError on a bad coercion) currently routes through JS-
hosted constructors and a JS-side "last caught" sidecar. None of
this is available under wasmtime / standalone Wasm.

Imports with **no standalone fallback**:

1. **`__throw_type_error`** (`src/runtime.ts` 2527, verified 2026-05-21 —
   JS impl `throw new TypeError(msg)`). Emitted from:
   - `src/codegen/destructuring-params.ts:148,151` (parameter
     destructuring required-arg check)
   - `src/codegen/expressions/identifiers.ts:28,310,549` (TDZ /
     const-reassign error)
   - `src/codegen/expressions/calls.ts:5600`
   Used everywhere an internal coercion (`__unbox_number` on a
   Symbol, etc.) must propagate the spec-mandated TypeError.

2. **`__throw_reference_error`** (`runtime.ts` 2468 — JS impl
   `throw new ReferenceError(msg)`). Emitted at any unresolved
   identifier reference and TDZ violations
   (`identifiers.ts:28,310,549`). When the import is unavailable
   the codegen currently falls back to `unreachable`/trap — a
   silent crash with no observable error message.

3. **`__get_caught_exception`** (`runtime.ts` 4953, registered at
   `codegen/index.ts:4683`). Returns the JS `lastCaughtException`
   captured by every host import wrapper (`runtime.ts` 4974–4988).
   Invoked from `catch_all` blocks so the user code in `catch (e)
   {...}` can observe the host exception. With no JS wrapper, no
   `lastCaughtException`, no value to bind to `e`.

4. **JS-constructed Error types** — `throw new TypeError("…")` is
   compiled by routing through the JS `TypeError` constructor via
   `extern_class` import intent. Same for `RangeError`,
   `SyntaxError`, `URIError`, `EvalError`, plain `Error`. Each
   instance is a JS exception object with a `.stack` populated by
   V8.

5. **Wasm Exception tag** — the compiler emits a single
   `(tag $js_exception (param externref))` and `throw $js_exception`
   with the externref Error object on the stack. The Wasm
   Exceptions proposal is implemented in wasmtime ≥ 14, but the
   payload externref is unusable without a host: wasmtime cannot
   manufacture a value that looks like a `TypeError` to JS code
   that catches it.

6. **`RangeError` thrown by host wrappers** (`runtime.ts` 4976) —
   "Maximum call stack size exceeded" guard. The standalone module
   has no way to detect or surface stack overflow without trapping.

7. **`__assert_count` family** (`runtime.ts` 2181-2246) — test262
   `assert.throws` machinery; lives in JS and asks "did the body
   throw the right constructor?". Standalone test runs cannot
   answer.

Why this blocks standalone: any `try { … } catch(e) { … }` that
inspects `e.message`, `e instanceof TypeError`, or `e.constructor`
silently mis-behaves under wasmtime — the catch_all binds an opaque
`null` or `undefined` instead of an Error object, breaking nearly
every test262 negative test and any user-facing error reporting.

## Standalone alternative

The Wasm Exceptions proposal + WasmGC give us everything we need —
the policy just has to move out of JS:

- **Wasm-native Error structs**:
  ```
  struct $Error      { msg: ref $FlatString, stack: ref $FlatString }
  struct $TypeError  <: $Error
  struct $RangeError <: $Error
  struct $RefError   <: $Error
  struct $SyntaxErr  <: $Error
  ```
  Using WasmGC subtyping so `ref.test $TypeError` matches both for
  `instanceof TypeError` and for typed catch dispatch.

- **Multiple Wasm tags** (one per error type, or one tag with a
  payload-type discriminator). With the Exceptions proposal, the
  compiler emits `(tag $exc (param (ref $Error)))` and uses
  `catch $exc` / `ref.test` in the handler to discriminate by
  subtype. No externref involvement.

- **`__throw_type_error` / `__throw_reference_error`** → pure-Wasm
  helper functions that allocate a `$TypeError` / `$RefError`
  struct (msg from the literal string pool) and `throw $exc`. Wired
  the same way `_throw_type_error` is wired today, but the
  funcIdx points at an in-module function instead of an import.

- **`__get_caught_exception`** → replaced by the `catch` block
  binding the popped exnref directly. Today's codegen pops the
  caught value via the JS sidecar so it can support catch_all
  without an exnref; the standalone path uses
  `catch_ref $exc` / `local.set` directly. (Some peephole logic
  already does this in IR fast path; extend it.)

- **`.stack` population**: hard. Without engine cooperation, the
  best we can do is the source-line annotation (we already emit
  DWARF). For now, leave `.stack` as an empty string — most
  test262 tests don't check it, and wasmtime supports
  `--debug-trace` for the user.

- **`assert.throws` (test262 harness)**: the harness itself is JS
  test runner code, not compiled output. Standalone modules
  produced for shipping do not run the test262 harness; the
  harness keeps using JS-mode compilation. No change needed here
  for shipping, but document the constraint.

- **`RangeError` for stack overflow**: wasmtime traps with
  "call stack exhausted" — a Wasm trap, not a catchable JS
  exception. Mark this as a known divergence in the standalone
  docs (matches the wasm32 platform behavior of every other
  language).

## Acceptance criteria

- [ ] `--standalone` build emits zero `env::__throw_type_error`,
      `env::__throw_reference_error`, `env::__get_caught_exception`,
      `env::TypeError_new`, `env::ReferenceError_new`,
      `env::RangeError_new`, `env::SyntaxError_new`, `env::Error_new`
      imports.
- [ ] `wasmtime run` succeeds for: `throw new TypeError("x")` caught
      and `e.message === "x"`; `try { null.foo } catch(e) { e
      instanceof TypeError }`; TDZ: `let { try {x} catch(e) {e
      instanceof ReferenceError} let x; }`.
- [ ] Subtype discrimination works: `try { throw new RangeError("r") }
      catch (e) { e instanceof TypeError /* false */ }`.
- [ ] `instanceof Error` returns true for every standalone-thrown
      error subtype.
- [ ] Test262 `language/statements/try/**` and
      `language/expressions/throw/**` do not regress in default mode;
      a `--standalone` subset is tracked.

## Files to modify

- `src/codegen/expressions/identifiers.ts` (lines 28, 310, 549) —
  switch standalone path to in-module `$__throw_ref_err` / `$__throw_type_err`.
- `src/codegen/destructuring-params.ts` (line 148) — same.
- `src/codegen/expressions/calls.ts` (line 5600) — same.
- `src/codegen/typeof-delete.ts` (lines ~287-311) — `throw new
  RegExp(...)` and other constructor-style throws.
- New: `src/codegen/wasm-helpers/exceptions.ts` — emit the
  `$Error` / `$TypeError` / `$RangeError` / `$RefError` /
  `$SyntaxErr` struct types (WasmGC subtyping), the
  `$__throw_type_err($msg)`, `$__throw_ref_err($msg)`,
  `$__throw_range_err($msg)` helpers, and the `$exc` tag.
- `src/codegen/statements.ts` (try/catch) — emit `catch $exc` with
  exnref-bound local instead of `catch_all` + `__get_caught_exception`
  when `ctx.standalone`.
- `src/codegen/index.ts` line 4683 — gate
  `__get_caught_exception` import on `!ctx.standalone`.
- `src/runtime.ts` (host-mode error wrappers) — unchanged; only
  invoked in JS-host mode.

## Implementation Plan

### Root cause
Exception emission has two intertwined host dependencies:

1. **Spec-mandated implicit throws** (`__throw_type_error`,
   `__throw_reference_error`) call `new TypeError(msg)` / `new
   ReferenceError(msg)` in JS. Standalone mode has no JS, so the
   import is unsatisfied and `wasmtime instantiate` fails.
2. **catch-binding for foreign exceptions** uses `catch_all` +
   `__get_caught_exception` (`statements/exceptions.ts:526`) to
   read the JS-side `lastCaughtException` sidecar populated by
   every host import wrapper (`runtime.ts:4974–4988`). Without
   the JS host there is no sidecar — the caught value is `null`.

The Wasm Exceptions proposal (`throw`/`catch $tag`/`catch_ref`)
plus the existing `$Error_struct` infrastructure (#1104,
`registry/error-types.ts`) provide everything needed to fix both —
the policy just has to move out of JS.

### Existing infrastructure to reuse

- **`$Error_struct`** (already registered in
  `src/codegen/registry/error-types.ts`):
  ```
  (type $Error_struct (struct
    (field $tag       i32)               ;; BUILTIN_TYPE_TAGS
    (field $message   (mut externref))
    (field $name      externref)))
  ```
- **`emitWasiErrorConstructor(ctx, errorName, argCount)`** — emits
  `__new_<Name>` Wasm functions for the 8 built-in Error
  constructors (`registry/error-types.ts:107`). Already wasi-safe;
  works as a `funcIdx` in `ctx.funcMap`.
- **`emitThrowTypeError(ctx, fctx, message)`** in
  `expressions/helpers.ts:93` — already does the right shape for
  `__new_TypeError(msg) + throw tagIdx`, but falls through to
  `__throw_type_error` host import in `destructuring-params.ts`
  and `identifiers.ts`. We need to make every TDZ/coercion throw
  site use the same helper.
- **`ensureExnTag(ctx)`** (`registry/imports.ts`) — registers the
  single `(tag $exc (param externref))` used by all throws.
  Standalone mode keeps this exact tag shape — no migration to
  multiple tags or to `ref $Error_struct` payload needed in
  Phase 1.

### Prerequisite (depends on #1470, #1471)
- `ctx.standalone` flag (from #1470)
- `$__box_num_wasm` / boxing infra (from #1471) — `Error.message`
  is anyref; boxing a string literal into externref via
  `stringConstantExternrefInstrs` is already standalone-safe via
  the native-strings bridge.

### Changes

**(1) `__throw_type_error` — `src/codegen/destructuring-params.ts`
line 148, `expressions/calls.ts` line 5600**

Replace the body of every site that does:

```ts
const throwIdx = ensureLateImport(ctx, "__throw_type_error",
  [{ kind: "externref" }], []);
// ... push message externref ...
fctx.body.push({ op: "call", funcIdx: throwIdx });
```

with a call to the existing `emitThrowTypeError(ctx, fctx,
message)` helper (`expressions/helpers.ts:93`). That helper already
calls `__new_TypeError(msg)` + `ensureExnTag` + `throw`. Verify it
works in standalone mode — `__new_TypeError` is `emitWasiErrorConstructor`
when `ctx.wasi || ctx.standalone`.

In `destructuring-params.ts:148` the literal site is:
```ts
const throwIdx = ensureLateImport(ctx, "__throw_type_error",
  [{ kind: "externref" }], []);
fctx.body.push({ op: "call", funcIdx: throwIdx });
```

Replace with:
```ts
emitThrowTypeError(ctx, fctx, missingArgMessage);
// (caller no longer pushes the message — emitThrowTypeError does it)
```

Same surgery at `expressions/calls.ts:5600` and any other site
matched by:
```
rg 'ensureLateImport.*__throw_type_error' src/codegen/
```

**(2) `__throw_reference_error` — `expressions/identifiers.ts`
lines 28, 310, 549**

Add a sibling helper to `emitThrowTypeError` in
`expressions/helpers.ts`:

```ts
/**
 * Emit a throw of a ReferenceError instance for TDZ / unresolved
 * identifier reference. In WASI / standalone mode, builds the error
 * via $__new_ReferenceError (an in-module function emitted by
 * emitWasiErrorConstructor). In JS-host mode, the same import name
 * resolves to the JS ReferenceError constructor.
 *
 * Either way the throw is observable to the user's catch block via
 * the existing $exc tag.
 */
export function emitThrowReferenceError(
  ctx: CodegenContext, fctx: FunctionContext, message: string
): void {
  // In standalone mode, ensure the Wasm constructor is emitted
  if (ctx.wasi || ctx.standalone) {
    emitWasiErrorConstructor(ctx, "ReferenceError", 1);
  }
  addStringConstantGlobal(ctx, message);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, message));
  const newRefErrIdx = ensureLateImport(
    ctx, "__new_ReferenceError",
    [{ kind: "externref" }], [{ kind: "externref" }]
  );
  flushLateImportShifts(ctx, fctx);
  if (newRefErrIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: newRefErrIdx });
  }
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}
```

Replace all three sites (`identifiers.ts:28, 310, 549`):

```ts
// OLD
const throwRefErrIdx = ensureLateImport(ctx, "__throw_reference_error",
  [{ kind: "externref" }], []);
// push message ...
fctx.body.push({ op: "call", funcIdx: throwRefErrIdx });

// NEW
emitThrowReferenceError(ctx, fctx, `Cannot access '${name}' before initialization`);
```

The function body change in `emitLocalTdzCheck` /
`emitStaticTdzThrow` becomes one line. Sites that already
constructed a message via separate string ops get folded into the
helper's message arg.

**(3) `__get_caught_exception` — `statements/exceptions.ts:526`,
`expressions.ts:269`**

The current code structure:

```ts
// try { ... } catch (e) { ... }
// Two-branch emission: typed catch ($exc) for Wasm-throws,
// catch_all for any other engine-raised exception (including JS).
catches = [{ tagIdx, body: typedCatchBody }];   // already binds the externref
catchAllBody = [
  // get the externref from JS sidecar:
  call $__get_caught_exception,
  local.set $exnLocalIdx,
  ...catchBody clone
];
```

In standalone / WASI mode, there is no JS sidecar AND no engine-
raised exception that doesn't come through our `$exc` tag (Wasm
traps are not catchable). Therefore the `catch_all` branch is
**dead code** in standalone mode — drop it.

Surgery at `statements/exceptions.ts:515–595`:

```ts
const noJsHost = ctx.wasi || ctx.standalone;
if (noJsHost) {
  // Single typed catch only — no catch_all branch.
  // The $exc tag already pushes the externref payload that
  // typedCatchBody binds via local.set.
  fctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: tryBody,
    catches: [{ tagIdx, body: typedCatchBody }],
    catchAll: undefined,  // OMIT in standalone
  });
} else {
  // Existing dual-branch emission with catch_all + __get_caught_exception
  fctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: tryBody,
    catches,
    catchAll: catchAllBody,
  });
}
```

Also at `src/codegen/expressions.ts:269` (the lone other call
site of `ensureLateImport(ctx, "__get_caught_exception", …)`) —
audit the context: that file may have an `await catch_all`
adapter that also needs gating. If the site is inside a generator
/ async block, ensure the typed-catch path still binds the
exception local correctly (`statements/exceptions.ts` already
handles this via `exnLocalIdx`).

**(4) Verify `$exc` tag payload is wasi-safe**

The tag is `(tag $exc (param externref))`. In standalone mode, the
externref payload is the `$Error_struct` produced by
`emitWasiErrorConstructor`, converted via `extern.convert_any` at
line 130 of `registry/error-types.ts`. Catch-side code reads the
fields via:

- `e.message` → `__extern_get(e, "message")` — but in standalone
  this needs the direct struct.get path. `property-access.ts:914`
  already handles this: when `ctx.errorStructTypeIdx >= 0` and
  the receiver type matches, it emits `ref.cast $Error_struct +
  struct.get message` directly. **No change needed**.
- `e instanceof TypeError` → walks `$tag` field comparison. Phase
  3 work in `registry/error-types.ts:21` — already wired for
  WASI mode.

**(5) `RangeError` for stack overflow**

Document as a known divergence in `plan/method/standalone-divergences.md`
(new file): wasmtime traps with `call stack exhausted` rather than
throwing a catchable `RangeError`. Matches every other
wasm32-targeting language; no action needed beyond docs.

**(6) `assert.throws` (test262 harness)**

The test262 harness is JS test runner code, never compiled. No
change — but document that standalone-mode `tests/standalone-*.test.ts`
must NOT use `assert.throws`; instead, the runner asserts on
the wasmtime exit code (non-zero = uncaught throw).

### Wasm IR patterns

For the typed-catch path (standalone mode, `try {…} catch (e) {…}`):

```wat
(try
  (do
    ;; ... tryBody ...)
  (catch $exc
    ;; $exc payload (externref) is on the stack
    local.set $exnLocalIdx
    ;; ... catchBody — references $exnLocalIdx via local.get ...))
```

For `throw new TypeError("msg")`:

```wat
;; ... build "msg" externref via stringConstantExternrefInstrs ...
call $__new_TypeError      ;; → externref ($Error_struct)
throw $exc
```

For TDZ `let x; x;` (before `x` is initialized):

```wat
;; Check TDZ flag (existing emitLocalTdzCheck pattern):
local.get $x_tdz_flag
i32.eqz
if
  ;; build "Cannot access 'x' before initialization" externref
  global.get $__str_const_<idx>     ;; from stringConstantExternrefInstrs
  call $__new_ReferenceError
  throw $exc
end
```

### Test approach

- **Existing**: `tests/equivalence.test.ts` covers throw/catch,
  TDZ, instanceof TypeError. All must remain green in default mode
  and under `--target standalone`.
- **New**: `tests/standalone-throw.test.ts` (wasmtime smoke):
  - `try { throw new TypeError("x") } catch (e) { return e.message }`
    → expect `"x"`
  - `try { throw new RangeError("r") } catch (e) {
        return e instanceof TypeError ? "wrong" : "ok" }`
    → expect `"ok"` (subtype discrimination via `$tag` field)
  - `try { let z; z = x; let x = 1; } catch (e) {
        return e instanceof ReferenceError }` → expect `true`
  - Nested try/catch with rethrow — verifies the typed-catch path
    preserves the externref payload across re-throw
- **Import-section assertion** (shared helper from #1470): zero
  `env::__throw_type_error`, `env::__throw_reference_error`,
  `env::__get_caught_exception`. Note that `env::__new_TypeError`
  / `__new_ReferenceError` ARE expected to be ABSENT in
  standalone (they're emitted as in-module functions by
  `emitWasiErrorConstructor`); verify they show up in the
  function table, not the import section.
- **Test262**: `language/statements/try/**` and
  `language/expressions/throw/**` — re-run in standalone mode;
  track delta against default-mode dashboard.

### Dependency ordering

Within #1473:

1. **`emitThrowReferenceError` helper + identifier-site retargeting** —
   smallest piece; ~80 LOC across `helpers.ts` and `identifiers.ts`.
2. **`emitThrowTypeError` retargeting at non-helper call sites**
   (`destructuring-params.ts:148`, `expressions/calls.ts:5600`) —
   another ~30 LOC.
3. **Catch-block standalone simplification** (`exceptions.ts:515-595`,
   `expressions.ts:269`) — ~50 LOC; subtle because of
   savedBodies bookkeeping. Test extensively before merge.

Cross-issue ordering:

- #1470 lands first (CLI flag).
- #1471 lands before #1473 — `emitThrowTypeError` / `emitThrowReferenceError`
  push externref message values; boxing must be standalone-ready.
  In practice `stringConstantExternrefInstrs` already works in
  WASI mode (uses the native-string bridge), so the gate is more
  about consistency than correctness.
- #1473 is independent of #1472; can land in parallel.
