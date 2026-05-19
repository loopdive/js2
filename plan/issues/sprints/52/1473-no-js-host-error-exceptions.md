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
---

# #1473 — Eliminate JS host error/exception ops for standalone Wasm

## Problem

Every throw site, every `catch` block that inspects the caught value,
and every spec-mandated implicit error (ReferenceError on a TDZ
binding, TypeError on a bad coercion) currently routes through JS-
hosted constructors and a JS-side "last caught" sidecar. None of
this is available under wasmtime / standalone Wasm.

Imports with **no standalone fallback**:

1. **`__throw_type_error`** (`src/runtime.ts` 2464 — JS impl
   `throw new TypeError(msg)`). Emitted from:
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
