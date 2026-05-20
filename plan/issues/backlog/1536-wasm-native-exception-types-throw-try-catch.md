---
id: 1536
sprint: backlog
title: "Wasm-native exception types: $Error WasmGC struct + throw / try_table / catch_ref"
status: backlog
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: runtime
language_feature: errors
goal: standalone-wasm
related: [1535, 1470, 1471, 1472, 1473]
---

# #1536 — Wasm-native exception types ($Error + Wasm 3.0 EH)

## Problem
`new Error(msg)`, `__throw_type_error`, `__throw_reference_error`, and `__get_caught_exception` currently all bridge through the JS host (`runtime.ts`). This blocks standalone (WASI) mode from throwing or catching any exception cleanly: the compiled binary cannot construct a JS Error and the host must materialise an externref for every `throw`.

## Proposed solution
Adopt Wasm 3.0 exception handling end-to-end:

1. Define WasmGC struct types for `$ErrorBase`, `$TypeError`, `$ReferenceError`, `$RangeError`, `$SyntaxError` (extending `$ErrorBase`) — each carrying a `(field $message i16-array-ref)` (native string).
2. Declare Wasm `tag` exports (one per error class, or a single tag parameterised by a `ref $ErrorBase`).
3. Replace `__throw_type_error(msg)` / `__throw_reference_error(msg)` codegen with: `(struct.new $TypeError) ; throw $err_tag`.
4. Replace `try { ... } catch (e) { ... }` lowering: emit `try_table (catch $err_tag $catch_label)` ... `catch_ref $err_tag` block. Bind `e` as the caught `ref $ErrorBase`; downstream code uses `ref.test`/`ref.cast` for `instanceof TypeError` etc.
5. Keep a host-import fallback path for the JS-host mode where `new Error()` must produce a JS-visible Error (Node interop). Default to native in `--standalone` / `--wasi`.

## Library/approach
No external library — pure Wasm 3.0 EH. Binaryen wasm-opt has `exnref` support (with caveats — block-parameter limitation in issue #3114; may need legacy EH on first pass and migrate).

## Binary size impact
+2-3 KB Wasm (struct definitions + tag declarations + 3-4 emitter helpers). Net **reduction** vs current pipeline because we drop 3 host import shims (~1 KB each in the host glue) and remove the boxed externref allocations on every throw.

## Test262 impact (estimated)
- Today: many `try`/`catch` tests pass only because the JS host happens to round-trip the externref correctly. Standalone mode currently fails on any error.
- After: unlocks ~300-500 test262 tests that depend on cross-error-class `instanceof`/`name` properties in WASI mode (currently they all `Compile-Error` or `RuntimeError` in standalone).

## Implementation steps
1. Add `$ErrorBase` struct and class hierarchy to `src/codegen/registry/types.ts`.
2. Declare wasm tags via Binaryen `module.addTag(...)`.
3. Update `src/codegen/typeof-delete.ts` (or wherever `__throw_*` is emitted) to use `throw` / `throw_ref`.
4. Update try/catch lowering in `src/codegen/statements.ts` to `try_table` + `catch_ref`.
5. Migrate `__get_caught_exception` callers to read the caught `ref` directly.
6. Keep host imports as fallback under `if (ctx.jsHost && !ctx.wasi)`.
7. Add unit tests: throw → catch round-trip; cross-class `instanceof`; stack of try blocks; rethrow.

## Risk
Binaryen `exnref` is still rough; may need to land on legacy EH (`try`/`catch $tag`) first and migrate to `exnref` once Binaryen catches up.
