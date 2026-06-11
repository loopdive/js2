---
id: 2047
title: "unify standalone Array.isArray: inline snapshot predicate diverges from direct calls; #1904's native __extern_is_array is dead code; both over-claim non-array carriers"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: arrays, built-ins
goal: standalone-mode
related: [1904, 1907, 1888, 1678]
origin: "2026-06-10 sprint-61 code review: PRs for #1904 and #1907 merged ~1h apart with two competing standalone Array.isArray implementations — the live one has a first-read snapshot bug, the dead one was built to fix exactly that."
---

# #2047 — Unify the standalone Array.isArray predicate

## Problem

Two sprint-61 PRs solved standalone `Array.isArray` dispatch concurrently
and merged without integrating:

1. **The live path has a snapshot bug** (#1907, `dec22e1a6`):
   the value-read closure (`src/codegen/property-access.ts:311-315`) and the
   shared inline predicate (`emitArrayIsArrayExternrefPredicate`,
   `property-access.ts:193-234`) bake a `ctx.vecTypeMap` `ref.test` chain
   **at first emission** and cache it in `funcMap`. Only externref/f64 vecs
   are eagerly registered (`src/codegen/context/create-context.ts:209-210`);
   i32 (boolean[]), typed-array storage, and struct-element vec kinds
   register lazily. Concrete divergence:
   `const f = Array.isArray; const b: boolean[] = [true]; f(b as any)` →
   `false`, while a direct `Array.isArray(b as any)` after the declaration →
   `true`. Silent wrong value; a value read must behave identically to a
   direct call.
2. **The fix for that is dead code** (#1904, PR 1259): the native
   `__extern_is_array` helper (`fillExternIsArray`,
   `src/codegen/object-runtime.ts:3956-3998`) is filled at **finalize** with
   the complete carrier list — exactly the late-binding answer to the
   snapshot bug — but the only call site
   (`property-access.ts:195-198`) is gated `!noJsHost(ctx)`, so under
   standalone/wasi nothing ever calls it. It still ships in every
   standalone module that touches the object runtime, pinning all `__vec_*`
   types live through dead-type elimination.
3. **Both predicates over-claim carriers**: they sweep in every
   `vecTypeMap` entry and `__vec_*` struct, including `__vec_i32_byte`
   (ArrayBuffer/DataView backing), `__vec_i8_byte` (native Uint8Array), and
   `__vec_f64` (TypedArray carrier) — ECMA-262
   [§7.2.2 IsArray](https://tc39.es/ecma262/#sec-isarray) requires **false**
   for all of these. The codebase's own precedent excludes `i32_byte` vecs
   from array treatment (`src/codegen/type-coercion.ts:1566-1582`).
   (`__vec_f64` is inherently ambiguous — number[] shares the struct — and
   may need a brand bit; `i32_byte`/`i8_byte` are exclusively non-array and
   are a pure filter fix.)

## Suggested fix

1. Route **both** standalone dispatch sites — direct call
   (`src/codegen/expressions/calls.ts:3461`) and value-read closure
   (`property-access.ts:315`) — through the native `__extern_is_array`
   helper, deleting the call-site snapshot chain. The finalize-fill pattern
   already handles the late-import index-shift class correctly (reviewed:
   reserve-then-fill, no captured funcIdx).
2. Filter `i32_byte` / `i8_byte` carriers out of
   `collectStandaloneArrayCarrierTypeIdxs` (`object-runtime.ts:3943-3955`);
   decide and document the `__vec_f64` ambiguity (test262 implications:
   `Array.isArray(new Float64Array(1))` must be false).
3. If instead the inline path is kept, delete the dead helper — but the
   helper is the better design; prefer (1).
4. Add the missing coexistence tests: value-read + direct call of the same
   builtin in one module; boolean[]/typed-array receivers through the
   closure (`tests/issue-1904.test.ts` currently passes via the rival
   implementation and would survive deletion of the code it pins).

## Acceptance criteria

- `const f = Array.isArray` agrees with direct `Array.isArray` for every
  carrier kind (externref, f64, i32/boolean, typed-array storage,
  struct-element vecs), regardless of declaration order.
- `Array.isArray` is false for ArrayBuffer/DataView/Uint8Array carriers in
  standalone mode.
- Exactly one standalone isArray implementation remains; no dead helper
  shipping in modules (or it is the only implementation).
- No host-mode changes; equivalence + issue-1904/1907 tests green with the
  new coexistence cases.
