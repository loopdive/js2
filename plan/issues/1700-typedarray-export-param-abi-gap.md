---
id: 1700
title: "TypedArray as exported Wasm function param fails JS↔Wasm marshalling (TypeError: type incompatibility)"
status: done
completed: 2026-06-12
created: 2026-05-28
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, runtime, abi
language_feature: typed-arrays, exports
goal: native-messaging, host-interop
sprint: Backlog
related: [389, 1187, 1654, 1667]
reporter: guest271314
---
# #1700 — TypedArray export-param ABI: JS callers cannot pass `Uint8Array` to a compiled function

## Problem

```ts
export function echoBytes(input: Uint8Array): Uint8Array {
  return input;
}
```

Calling the compiled export from JS:

```js
const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
instance.exports.echoBytes(new Uint8Array([97, 98, 99]));
//   TypeError: type incompatibility when transforming from/to JS
```

Reported by **guest271314** for the Native Messaging use case (#389). It
blocks passing binary buffers (the standard Native Messaging payload shape)
across the JS↔Wasm boundary as function arguments.

## Root cause

In WasmGC mode, `Uint8Array` parameters compile to a **WasmGC struct ref**,
not to externref. The emitted signature for the snippet above is:

```wat
(type $Arr (array (mut f64)))
(type $Vec (struct (field (mut i32)) (field (mut (ref null $Arr)))))
(func $echoBytes (param (ref null $Vec)) (result (ref null $Vec)) ...)
```

Note that:
- The struct holds `{ length: i32, data: (ref null (array (mut f64))) }`.
- The element type is **`f64`**, not `i8` — Uint8Array uses the same `f64`
  vec backing as plain `number[]` (a deliberate design choice; #1503's
  `__vec_set_byte` does the f64 conversion).
- A JS `Uint8Array` is not a WasmGC struct, so the JS↔Wasm coercion layer
  rejects it at the call boundary.

By contrast, an `(input: any)` param compiles to `externref`, and JS
`Uint8Array` passes through untouched (verified).

## What works today / what does not

| Param type | Wasm sig                   | JS call with Uint8Array |
|------------|----------------------------|-------------------------|
| `any`      | `externref`                | works (passes through)  |
| `number[]` | `(ref null $Vec[f64])`     | fails (same as below)   |
| `Uint8Array` | `(ref null $Vec[f64])`   | **fails — this issue**  |
| `string`   | externref / strref         | works (str_to_extern bridge) |
| `number`   | `f64`                      | works                   |

Return values of the same TypedArray type already work because
`wrapExports` (`src/runtime.ts:8243`) marshals struct/vec returns back to
plain JS via `_wasmToPlain` (`src/runtime.ts:1847`). The asymmetry is that
no inverse marshaller exists on the **input** side.

## Why this is not a one-line fix

Two ingredients are missing from the toolbox:

1. **No JS-callable vec constructor export.** Codegen emits `__vec_get`,
   `__vec_len`, `__vec_set_byte`, `__dv_byte_*`, but no
   `__new_vec_f64(len) -> externref` (or similar). The only way today to
   produce a `$Vec` struct is from inside compiled Wasm via
   `array.new_*` + `struct.new`. JS has no entry point.
2. **`wrapExports` only wraps return values.** It has no per-call argument
   coercion; it can't even know the Wasm parameter type from the JS side
   without metadata (parameter types are not currently surfaced on the
   `CompileResult`).

A complete fix touches both layers.

## Approach (proposed, this PR)

**Step 1 — Emit `__new_vec_f64(len: i32) -> externref` export** (codegen):
when at least one `f64`-element vec type is registered in `ctx.vecTypeMap`,
emit an export that allocates a fresh `$Vec` with a zeroed
`(array (mut f64))` of the requested length and returns it as externref.
Gate identically to `emitVecSetByteExport` to avoid bloating modules that
don't use TypedArrays.

**Step 2 — Marshal TypedArray arguments in `wrapExports`**: extend the
per-export wrapper closure to walk `args`; if an arg is a
`Uint8Array` (or generally `ArrayBufferView`) and the export accepts
struct-ref params, allocate a vec via `__new_vec_f64`, populate via
`__vec_set_byte`, and substitute the externref. The same return-side
`_wasmToPlain` already converts the vec result back to a JS array — for
strict Uint8Array fidelity in / Uint8Array out the wrapper additionally
post-processes the result.

**Step 3 — Test**: `tests/issue-1700.test.ts` covering
- `echoBytes(input: Uint8Array)`: round-trip identity
- multi-arg shapes
- `--target wasi` (different import shape)
- regression guard: existing externref/`any` callsite still passes through

## Open design questions (may carve to follow-up)

- **Element types**: Int8Array / Uint8ClampedArray / Int16Array /
  Uint16Array / Int32Array / Uint32Array / Float32Array / Float64Array all
  compile to `f64`-element vecs (current model), so the same
  `__new_vec_f64` works for all. BigInt64Array / BigUint64Array would need
  i64 — defer to the i64-bigint-brand spec (#1644).
- **Sharing vs copying**: the wrapper *copies* JS Uint8Array bytes into the
  vec. Mutations inside the compiled function are not reflected back to
  the caller's Uint8Array. A `marshal: "share"` mode is feasible but
  requires linear-memory backing (out of scope here).
- **Return-side Uint8Array fidelity**: current `_wasmToPlain` returns a
  plain Array for vec returns. Callers expecting `instanceof Uint8Array`
  from a `Uint8Array`-typed export must opt in (e.g.
  `marshal: { copy: "typedarray" }` or a per-export wrapper hint).

## Acceptance criteria

1. `export function echoBytes(input: Uint8Array): Uint8Array { return input; }`
   round-trips a JS `Uint8Array` through the compiled module without
   throwing.
2. `tests/issue-1700.test.ts` covers Uint8Array param, Uint8Array return,
   mixed-arg shapes, and one `--target wasi` case.
3. Existing externref / `any` callsites unaffected (regression guard).
4. Module size does not bloat when no Uint8Array vec is registered
   (export gated on `ctx.vecTypeMap.has("f64") && f64-vec is used as a
   param`).

## Files to modify

- `src/codegen/index.ts` — new `emitNewVecF64Export` (mirrors
  `_emitVecSetByteExportInner`)
- `src/runtime.ts` — `wrapExports` argument marshalling block
- `tests/issue-1700.test.ts` — new

## Related

- #389 — Native Messaging chrome.runtime use case (the reporter)
- #1187 — string param marshalling (the precedent for this asymmetry,
  solved via `__test_str_from_externref` / `__test_str_to_externref`)
- #1654 — DataView WASI fix (i32_byte backing; related vec-mechanics work)
- #1667 — `compile()` returns ready-to-pass `importObject` (the JS-side
  ergonomics work this builds on)

## Findings (2026-05-28, dev)

Reproduction confirmed on `main` (HEAD `1c9811e37`). `r.importObject`
correctly satisfies host imports; the failure is strictly the JS↔Wasm
parameter type coercion, not a missing import. Probe with `(input: any)`
verified that the boundary tolerates `Uint8Array` through externref. WAT
dump above is verbatim from `binaryen.readBinary(r.binary).emitText()`.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #849; frontmatter was stale at `in-progress`. Flipped to `done` during the sprint-62 issue review.
