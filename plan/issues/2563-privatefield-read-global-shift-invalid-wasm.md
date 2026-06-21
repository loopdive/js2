---
id: 2563
title: "Private-field/getter brand-check read on a closed-over module global emits invalid wasm (global-index desync)"
status: done
sprint: 64
created: 2026-06-20
updated: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: class-private-fields
goal: correctness
---

## Problem

Several test262 files under
`test/language/statements/class/elements/` made js2wasm emit an **invalid
Wasm module** — `WebAssembly.instantiate(): Compiling function
#N:"__anonClass_0_f" failed: any.convert_extern[0] expected type shared
externref, found global.get of type f64`. Confirmed PRE-EXISTING (reproduces
identically at 118a3542e, before #1787's DCE work — not a recent regression).

Affected (compile_error → fixed):
- `privatefieldget-typeerror-5.js`
- `privatefieldget-success-1.js`
- `privatename-valid-no-earlyerr.js`
- `privatefieldset-evaluation-order-3.js` (compile_error → now valid wasm; the
  residual assertion failure is a separate behavioral gap, see "Out of scope")

## Root cause

The private-name brand-check **read** path in
`src/codegen/property-access.ts` (both the struct-field path ~L2420 and the
getter/method path ~L2480) does:

1. `compileExpression(ctx, fctx, expr.expression)` — compiles the receiver.
   When the receiver is a module-level variable (e.g. a closed-over `self`),
   this emits **`global.get $self`** into `fctx.body`.
2. A raw body swap to capture the failure/throw branch:
   `const savedBody = fctx.body; fctx.body = []`.
3. `emitThrowTypeError(ctx, fctx, "Cannot read private member #x …")` — this
   adds the message as a **late string-constant import**, which runs
   `fixupModuleGlobalIndices` (registry/imports.ts). That fixup bumps every
   module-global index by +1 and rewrites the `global.get/set` indices in all
   *registered* bodies.

The fixup walks `fctx.savedBodies` (among others) — but the raw swap in step 2
**never registered `savedBody` there**. Because `fctx === ctx.currentFunc`, the
swap reassigned `ctx.currentFunc.body` to the new empty buffer, so the fixup's
`ctx.currentFunc.body` walk hit the empty array and the real body holding
`global.get $self` (now detached in `savedBody`) was skipped. The receiver's
`global.get` kept its **pre-shift** index and pointed one global too low — at an
`f64` module global (`__mod___assert_count`) instead of the externref `self`
(`__mod_self`) → `any.convert_extern` got an f64 → invalid Wasm.

This is the exact swap-pattern hazard the codebase already guards elsewhere via
the canonical `pushBody`/`popBody` helpers (`src/codegen/context/bodies.ts`),
which register the saved buffer on `fctx.savedBodies` for the duration of the
swap. The brand-check read paths hand-rolled the swap and missed registration.

## Fix

Replace the raw swaps in both brand-check read paths with `pushBody(fctx)` /
`popBody(fctx, savedBody)` so the swapped-out real body is on
`fctx.savedBodies` and the receiver's `global.get` shifts with the late import.
One-line import addition (`pushBody`) + two call-site conversions.

Files: `src/codegen/property-access.ts`.

## Validation

- `tests/issue-2563-privatefield-global-shift.test.ts` — new regression
  (fails on clean main with invalid wasm, passes after the fix).
- test262 `class/elements` subdir sweep: **+25 pass, −4 compile_error, −21
  fail** vs clean main; **zero pass→fail or pass→CE regressions**. The +25
  includes 22 `*-rs-private-setter*` files (FAIL→pass) plus the three
  invalid-wasm files above. `privatefieldset-evaluation-order-3.js` improved
  CE→FAIL (now valid wasm).
- `tsc --noEmit` clean, `prettier --check` clean. Existing brand/private
  vitest suites unaffected (pre-existing `string_constants` import-object
  harness failures in `classes.test.ts`/`class-expressions.test.ts` are
  identical on clean main).

## Out of scope (filed separately)

- `privatefieldset-typeerror-3.js` — distinct invalid-wasm bug: polymorphic
  receiver method-dispatch resolves the result blockType to the function-
  wrapper struct (`$func.0`) for a method returning a class expression →
  `fallthru` type mismatch. Filed as **#2564**.
- `privatefieldget-typeerror-1.js` / `privatefieldset-typeerror-1.js` — a
  behavioral gap (returns 2 instead of throwing TypeError) for reading a
  private field inside its own class field-initializer before the slot is
  populated; **not** invalid wasm. Tracked under the same #2564 follow-up.
