---
name: project_linear_backend_no_console_log
description: "Linear backend (target:\"linear\", non-WASI) drops console.log; it is return-value-oriented — cross-backend/diff testing must assert return values, not stdout"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

The **linear-memory backend** (`compile(src, { target: "linear" })`, the
non-WASI linear target) has **no `console.log` host import**. A linear-compiled
program emits **zero imports** and **no output mechanism** in its WAT, so it
runs but prints **nothing** — `console.log` is silently dropped. (Verified
2026-06-16 while implementing #1854: a numeric corpus program compiled cleanly
on linear but produced empty stdout.)

The linear backend's only observable surface (without WASI) is the **exported
function's return value** — which is exactly how `tests/linear-*.test.ts`
assert it (they `WebAssembly.instantiate(binary)` with **no imports** and check
return values).

**Why:** the WasmGC backend uses `wasm:js-string` + JS host imports (incl.
console) built by `buildImports`/`instantiateWasm` in `src/runtime.ts`; the
linear backend doesn't wire those. WASI mode (`target: "wasi"`) routes console
output through `fd_write`, but plain `target: "linear"` does not.

**How to apply:** any cross-backend or differential testing that includes the
linear backend must compare **return values**, never stdout. The
stdout-driven `tests/differential/corpus/` (used by `scripts/diff-test.ts`)
cannot exercise the linear backend — a stdout diff would false-mismatch the
whole corpus. #1854 shipped a return-value differential
(`tests/cross-backend-diff.test.ts` + `tests/cross-backend/corpus.ts`) for
exactly this reason. See [[project_standalone_collections_arch]] and
[[project_standalone_emit_layer_bug_classes]] for related standalone/linear
emit-layer notes.
