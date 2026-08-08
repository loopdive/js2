---
id: 4216
title: "standalone pako: packed i16 storage type leaks into a value position at binary emit"
status: in-review
sprint: Backlog
created: 2026-08-08
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: emit
goal: standalone-gap
related: [743, 4157, 679]
loc-budget-allow:
  # +3 lines in the vec-element inc/dec arm: the write-back temp's declared
  # type routed through unpackedElemType plus the constraint comment. The fix
  # IS the type-selection site inside makeStoreLocal — there is no satellite
  # module a one-line local-type correction can live in.
  - src/codegen/expressions/unary-updates.ts
func-budget-allow:
  # Same +3 lines, seen per-function: the temp's type is chosen inside this
  # arm; splitting the function is #3399-class work, not a bugfix rider.
  - src/codegen/expressions/unary-updates.ts::compileMemberIncDec
origin: "2026-08-08 — found by the #743 second-corpus census (pako 2.1.0 standalone compile)"
---

# #4216 — standalone pako: packed `i16` leaks into a value position at binary emit

## Problem

Compiling pako 2.1.0's self-contained dist bundle (`dist/pako.esm.mjs`, 226 KB,
zlib port) with `target: "standalone"` fails at binary emit with exactly one
error:

```
Binary emit error: Error: encodeValType: packed storage type "i16" is not valid
in a value position (only struct fields / array elements) — a packed type leaked
into a param/result/local/global
    at encodeValType (src/emit/binary.ts:855)
    at encodeFunctionWithSourceMap (src/emit/binary.ts:667-669)   ← locals vector
    at emitBinaryWithSourceMapUnguarded (src/emit/binary.ts:571)
```

The frame at `binary.ts:667-669` is the function-locals vector, so some
function declares a **local** of packed type `i16`. Packed types (`i8`/`i16`)
are storage-only in WasmGC; a local/param/result/global must widen to `i32`.
The emit-time guard (which is doing its job) was added precisely to catch this
class of leak — this is the first real-corpus reproduction.

Codegen itself completes: the fnctor field-provenance census runs to the end
(122 slots recorded) and this is the **only** error in the compile. pako is
heavy on `Uint16Array`/`Uint8Array` and the native-strings backend uses i16
arrays (#679), so the likely source is an array-element read whose result type
was taken as the storage type instead of the widened `i32` — but the emitting
function has not been identified yet; that is the first step.

## Repro

```bash
cd /tmp && npm pack pako@2.1.0 && tar xzf pako-2.1.0.tgz
# then compile package/dist/pako.esm.mjs with:
#   compile(source, { fileName: "pako.mjs", skipSemanticDiagnostics: true,
#                     target: "standalone" })
```

(Probe used by the census: see #743 "2026-08-08 — second-corpus measurement".)

## Why it matters

pako is the chosen **second dogfood corpus** for the #743/#4157 representation
program (same size class as acorn's bundle, function-ctor classes, numeric/
typed-array-heavy — the contrast corpus to acorn's string/object shape). This
one error is all that blocks it from becoming a compiled, runnable standalone
corpus with its own perf lane; until then it is census-only.

## Acceptance criteria

- [x] pako 2.1.0 `dist/pako.esm.mjs` compiles to a valid standalone binary
      (Wasm validation passes; no packed types in value positions).
- [x] A minimal fixture pins the widening (i16-array element read flowing into
      a local/param/result) as a regression test.
- [ ] A smoke canary (deflate → inflate round-trip of a short string inside the
      module) returns the expected checksum. — **out of scope for this fix**
      (emit-blocker only); needs its own runtime-canary harness pass.

## Results (2026-08-08)

- **Identified function**: `__closure_90` in the pako standalone module — three
  locals `__incdec_store_{46,112,158}` declared with packed `{kind:"i16"}`.
  These are Uint16Array element `++`/`--` sites (pako's hash-chain
  `head`/`prev` arrays in deflate).
- **Root cause**: the vec-element inc/dec arm's `makeStoreLocal` (#3024,
  `src/codegen/expressions/unary-updates.ts:901`) allocates the write-back temp
  with the raw array **element** type. For a packed i8/i16 element that is a
  storage-only kind — `coerceType` correctly leaves an **i32** on the stack
  (its packed→i32 mapping, `type-coercion.ts:1822`), but the local's DECLARED
  type stayed `i16`, tripping the emit guard (`src/emit/binary.ts:855`, #1939)
  in the function-locals vector.
- **Fix site**: `src/codegen/expressions/unary-updates.ts:905` — declare the
  temp with `unpackedElemType(elemType)` (the canonical #2648/#2934 helper).
  One-line typing correction; no stack-value changes, emit guard untouched.
- **pako after fix**: 0 errors, binary = **1,172,849 bytes**,
  `WebAssembly.compile` OK.
- **Regression test**: `tests/issue-4216-pako-i16-local.test.ts` — standalone
  `Uint16Array` element `++`/prefix-`++`/`--`; asserts compile success, module
  validation, and runtime semantics incl. u16 wraparound (`0--` → 65535).
  Verified to fail with the pre-fix codegen and pass with the fix.
- **Scoped suites**: packed/typedarray/native-strings/inc-dec test files all
  green (issue-1787, 2593, 2648, 2934×3, 3024×2, 4079, native-strings×4 —
  183 tests passed). Full `tests/equivalence/` OOMs in this container (known);
  ran the typed-array/inc-dec/compound-assignment equivalence subset instead
  (30 passed). 4 failures in `arguments-nested-and-loops` /
  `logical-conditional-identity` are pre-existing (identical on baseline
  HEAD, A/B-verified) — unrelated to this change.
