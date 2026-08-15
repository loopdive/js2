---
id: 4446
title: "standalone: Array.prototype.concat extern fallback leaks __array_concat_any/__js_array_new/__js_array_push — lower natively"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
assignee: claude/es6-standalone-session
priority: high
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: es6
goal: standalone-mode
related: [4444, 2961, 1359, 2860]
---

# #4446 — standalone native Array.prototype.concat fallback

## Problem

`compileArrayConcatExtern` (`src/codegen/array-methods.ts` ~L4113-4175) is the
fallback when any concat operand is not a statically-known WasmGC array (any-
typed receiver, `Symbol.isConcatSpreadable` objects, array-likes). It emits the
host imports `__array_concat_any` + `__js_array_new` + `__js_array_push`; in
the standalone lane the strict leak guard (#2961) turns that into a
compile_error: `standalone target emitted host imports: env::__array_concat_any…`.

**~30 non-passing ES2015 tests** under `built-ins/Array/prototype/concat/*`
(all CE), including every `isConcatSpreadable` protocol test. The same leaked
pair `__js_array_new`/`__js_array_push` also appears in Promise-combinator CEs
(owned by #2867 — out of scope here).

The native fast path directly above it (~L4090, WasmGC vec `array.copy` with
`emitBackingClampedArrayCopy`) already handles statically-typed array operands
— this issue is only the dynamic fallback.

## Implementation Plan (fable, 2026-08-15)

Spec (§23.1.3.1): result = ArraySpeciesCreate(O, 0); for O then each arg E:
if `IsConcatSpreadable(E)` (Object + `@@isConcatSpreadable` coerced via
ToBoolean, default IsArray(E)) append E's `0..ToLength(E.length)` elements via
HasProperty/Get; else append E itself. Final `Set(result, "length")`.

1. **Investigate the dynamic-object substrate first.** Standalone has a dynamic
   object runtime (`src/stdlib/object-runtime.ts`, `src/codegen/dyn-read.ts`)
   with property get/has and array-ness answers. Find the existing helpers for
   "is this dyn value an array", "get length", "indexed get", "indexed set /
   push" — the ES5 standalone lane already passes generic
   `Array.prototype.*` tests (#1461 array-like receivers is `done`), so
   these primitives exist. Reuse them; do NOT invent a second dyn-array ABI.
2. **Self-hosted or hand-emitted `__arr_concat_dyn`** taking the receiver and
   an args vec, implementing the spec loop over dyn values:
   spreadable-check (`@@isConcatSpreadable` read → ToBoolean, falling back to
   IsArray), ToLength on `length` (handles the
   `arg-length-exceeding-integer-limit.js` / `length-to-string-throws` abrupt
   cases), hole semantics via HasProperty (`concat` skips holes but counts
   them in length). Check how the standalone `slice`/`splice` generic paths
   (#1359, done) solved species + holes and mirror their approach; if a
   shared `ArraySpeciesCreate` helper exists, use it, else default-Array
   creation is acceptable for a first slice (species tests are a minority of
   the bucket — measure and say which remain).
3. **Rewire** `compileArrayConcatExtern` behind a target switch: standalone →
   the native lowering; JS-host (gc) → keep the existing host-import path
   unchanged (it is faster and complete there).
4. **Symbol plumbing**: `@@isConcatSpreadable` needs a well-known-symbol
   property read on a dyn object in standalone. Check how existing well-known
   symbol reads (`Symbol.iterator` in for-of dyn paths, `@@toStringTag`) are
   keyed in the object runtime and use the same keying. If Symbol keying is
   genuinely blocked on #2866 (Symbol carrier), implement the default
   IsArray(E) branch now, leave the @@isConcatSpreadable override subset
   failing, and record the residual count here.

## Validation

- Scoped run: `TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Array/prototype/concat" pnpm run test:262`
  Baseline: ~30 CE. Target: majority flip to pass; every remaining non-pass
  named in this file with its reason.
- Unit test `tests/issue-4446-concat-dyn-standalone.test.ts`: any-typed
  receiver concat, isConcatSpreadable=false array, spreadable object
  array-like, length-getter-throws abrupt — assert no `env::` imports in the
  emitted module (mirror an existing strict-leak assertion from #2961 tests).
- gc-lane equivalence: `npm test -- tests/equivalence.test.ts`.
