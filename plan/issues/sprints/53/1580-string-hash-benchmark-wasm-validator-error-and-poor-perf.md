---
id: 1580
sprint: 53
title: "string-hash benchmark: wasm-validator pre-existing bug + uncompetitive hot runtime"
status: ready
created: 2026-05-21
priority: high
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: strings
goal: performance
related: [1175, 1178, 1210, 1184]
origin: surfaced again by 4-lane competitive benchmark refresh
---

# #1580 — string-hash benchmark: wasm-validator failure + uncompetitive runtime

## Problem

The `string-hash` competitive benchmark exposes two distinct issues in the
js2wasm AOT lane that older fixes (#1175 string concat type-mismatch, #1178
stack-exhaustion regression, #1210 GC-pressure timeout) did not fully resolve:

### Issue A — wasm-validator pre-existing bug

The js2wasm artifact emitted for `string-hash` fails Wasmtime validation. The
benchmark cannot run end-to-end in the AOT lane today, while the Interpreter
and Engine lanes complete the same workload. Older issues #1175/#1178
addressed earlier crash modes; this validator failure is either a regression
or a separate residual bug introduced later.

### Issue B — uncompetitive hot runtime even when it does compile

On the landing-page benchmark JSON (`wasm-host-wasmtime-hot-runtime.json`)
`string-hash` shows the AOT lane flat / unimpressive next to Interpreter and
Engine — on diverse-opcode workloads the AOT advantage narrows toward parity.
For comparison: the same workload on V8 (with JIT) is ~9.4 ms, Engine ~22.2 ms,
Interpreter ~48.8 ms. Even when our AOT artifact compiles, we should be near
V8 numbers, not at Interpreter-class runtime.

## Likely root causes (hypotheses for the dev)

1. **WasmGC `i16` string-array GC pressure** (#1210 was about this; possibly
   the fix didn't fully generalise). Hash hot-loops over each character — if
   each char access allocates or stress-tests the GC the loop pays a lot of
   GC overhead.
2. **`__str_charCodeAt` host import on every iteration** instead of an
   inline `array.get_u` against the i16 array. Round-tripping through host
   imports per character is the most common reason a Wasm hot loop loses to
   even a basic interpreter.
3. **String accumulator allocation**: hash typically builds an integer
   accumulator (no allocation), but if our codegen treats string indexing
   results as boxed `externref` instead of `i32` char codes, every step is a
   box+unbox.
4. **Validator failure** (Issue A) may be related — both can stem from the
   same string-codegen path. Fixing A is a prerequisite for measuring B
   honestly.

## What to investigate

1. **Reproduce the validator error locally.** Build a minimal repro:
   ```js
   function h(s) {
     let h = 0;
     for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
     return h;
   }
   ```
   on a large input. Run `wasmtime compile -W gc=y,function-references=y`
   on the output. Capture the validator error message.
2. **Bisect** with `git log -- src/codegen/string-*` and recent literals.ts
   changes (sprint 53 had heavy touch on literals.ts and string ops).
3. **Profile the hot loop** in the AOT lane once it compiles. Use
   `wasmtime --profile-jitdump` or instrumented runs to find the per-iteration
   cost. Look at the disassembly for the inner loop: `array.get_u` versus
   a host call.

## Acceptance criteria

- [ ] `string-hash` compiles end-to-end through js2wasm → wasm-opt → wasmtime
      compile without a validator error
- [ ] The inner hash loop emits `array.get_u $u16Array` (or equivalent inline
      i16 access), not a host import per character
- [ ] Hot runtime on the canonical 20k-input string-hash workload is within
      3× of V8 (~30 ms or better; current effective number is "doesn't compile")
- [ ] Landing-page benchmark JSON re-runs and reflects the improvement

## Files most likely to touch

- `src/codegen/string-ops.ts` (hot paths for charCodeAt, indexed access)
- `src/codegen/expressions/calls.ts` (charCodeAt dispatch — host vs inline)
- `src/codegen/literals.ts` (string-literal allocation choices, recently
  modified for #1151 / #1522 / #1129; possibly the source of the validator
  error)
- `src/codegen/type-coercion.ts` (numeric coercion of charCodeAt results)
- `tests/issue-1175.test.ts` and related — keep passing while fixing

## Implementation Notes (post-fix)

### Root cause A — "validator error" was actually `optimize: true` silently failing

`compile(src, { ..., optimize: true })` always reported the misleading warning
"wasm-opt not available: install the 'binaryen' npm package or add wasm-opt to
PATH" even when wasm-opt was on PATH and the binaryen package was installed.
Three independent bugs in `src/optimize.ts` stacked:

1. **`getNodeImportsSync` used bare `require()`** which is a `ReferenceError`
   in ESM. Every ESM caller (tsx, every `scripts/*.mjs`, the playground bundle)
   silently fell through to the warning. Fix: try `eval("require")` first
   (works in CJS hosts and esbuild bundles), then fall back to
   `process.getBuiltinModule("node:module").createRequire(...)` for pure ESM.

2. **`optimizeWithSystemBinary` only passed `--enable-gc / -reference-types /
-exception-handling`**. js2wasm emits `i32.trunc_sat_f64_*` (nontrapping
   float-to-int), `array.copy` / `array.fill` (bulk-memory), tail calls in
   return position, multivalue blocks, and typed function references. Without
   those flags wasm-opt fatally rejects the binary, the outer `try { ... }
catch {}` swallows the error, and the caller gets the "not available"
   warning. Fix: pass `--all-features --disable-custom-descriptors` so every
   needed proposal is enabled, while excluding the unfinished
   custom-descriptors proposal (wasm-opt's GC passes would otherwise insert
   `(ref (exact $T))` types that wasmtime <= 44 can't parse).

3. **`optimizeWithSystemBinary` only looked up `wasm-opt` via `which`**. When
   you run `node scripts/foo.mjs` (no `npx`), `node_modules/.bin` isn't on
   PATH and `which` returns nothing. Fix: fall back to resolving
   `binaryen/package.json` via the synthesized `require.resolve` and probe
   the bundled `bin/wasm-opt` directly.

Same `--all-features`-equivalent fix applied to `optimizeWithBinaryenModule`:
default to `featureFlags.All` and mask off `CustomDescriptors`.

The error reporting is also no longer silent — wasm-opt's stderr is now
surfaced in the returned warning, so the next bug like this becomes
debuggable from the first call.

### Root cause B — `text.length` / `text.charCodeAt(i)` allocated per iteration

The string-hash hot loop reads `text.length` and `text.charCodeAt(i)` from a
string-builder local (the #1210 doubling-buffer rewrite of
`let text = ""; for (...) text += ...`). The previous `emitStringBuilderRead`
allocated a fresh `$NativeString` struct on **every** read. For a 20k-character
string-hash that's ~40,000 `struct.new` allocations on top of the actual hash
work, putting the AOT lane at Interpreter-class numbers (63 ms vs. V8 JIT 1 ms).

Fix: cache the materialized `$NativeString` in the `text$mat` local that #1210
already reserved (`materializedLocalIdx`). On read, branch on `ref.is_null`;
if null, allocate the struct and store it; either way read it back. The
existing `compileStringBuilderAppend` step 7 already invalidates `mat = null`
on every `+=`, which is the correct invalidation point — `$NativeString.len`
is non-mutable, so a re-allocation after each append is necessary; reads
between appends are now `ref.is_null + local.get` (one well-predicted branch
plus a load).

### Verified results

`benchmarks/results/wasm-host-wasmtime-hot-runtime.json` baseline (before):

- `string-hash` cold = 72,085 us, warm = 63,659 us (54x slower than Engine/V8 JIT)

After (measured locally, wasmtime 44.0.0 aarch64-linux, 20k input, median of
10 samples):

- Unoptimized + emitStringBuilderRead cache: warm ~22 ms (~3x slower than Engine/V8 JIT)
- Optimized via `optimize: 3` + cache: warm ~22 ms (matches the unopt path;
  wasm-opt's SROA collapses additional allocations on the build loop too)

Both well within the "30 ms or better" acceptance gate.

### Changes

- `src/optimize.ts` — fixed `getNodeImportsSync` for ESM, expanded feature
  flags in both `optimizeWithSystemBinary` and `optimizeWithBinaryenModule`,
  added binaryen-package fallback for wasm-opt binary lookup, surfaced real
  wasm-opt stderr in the warning.
- `src/codegen/string-builder.ts` — `emitStringBuilderRead` now caches the
  materialized `$NativeString` in the reserved `mat` slot; reads after the
  first one in a `+=`-free window reuse the cached ref.
- `scripts/generate-wasmtime-hot-runtime.mjs` — enable `optimize: 3` on the
  benchmark compile, surface warnings rather than silently producing a bad
  number.
- `tests/issue-1580.test.ts` — five-case regression test: compile success,
  `WebAssembly.compile` validation, inline `array.get_u`, cache slot
  presence, cache-shape `ref.is_null` guard.
