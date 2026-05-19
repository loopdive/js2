---
id: 1493
sprint: 52
title: "nodejs: console.error / console.warn → stderr (fd=2) in WASI mode"
status: ready
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: host-imports
goal: nodejs-support
related: [578, 1035]
---

# #1493 — `console.error` / `console.warn` route to fd=2 (stderr), not stdout

## Problem

In **JS host mode** routing is correct: `src/runtime.ts:1781` maps
`console.warn` → `console.warn` and `console.error` → `console.error` per
variant. Native V8 sends those to stderr.

In **WASI / standalone mode**, however, ALL `console.{log,warn,error,info,
debug}` calls emit `__wasi_write_string`, which unconditionally writes to
**fd=1 (stdout)**:

- `src/codegen/expressions/builtins.ts:1031` `compileConsoleCallWasi` —
  ignores the method name, never differentiates fd.
- `src/codegen/index.ts:3097` only ever registers `fd_write` once and the
  helper at `emitWasiWriteStringHelper` is hard-wired with `fd=1` in the iov
  call site.

As a result a compiled CLI tool's diagnostic output (errors, warnings) is
indistinguishable from its normal output. Standard Unix tooling like `2>&1`,
`| grep`, `command > out.txt 2> err.txt` is broken for js2wasm-produced
binaries.

A related historical issue (#578) tracked the fact that fd routing was wrong
for `console.log`; that landed but the `error`/`warn` distinction was never
followed up.

## Use case

```ts
function main(): void {
  console.log("processing input...");
  console.error("WARNING: deprecated flag detected");
  console.log("done");
}
main();
```

```sh
$ js2wasm --target wasi prog.ts -o prog.wasm
$ wasmtime prog.wasm > out.txt 2> err.txt
$ cat out.txt          # expect: "processing input..." then "done"
$ cat err.txt          # expect: "WARNING: deprecated flag detected"
```

Today both lines land in `out.txt`.

## Implementation plan

1. **`src/codegen/expressions/builtins.ts`** (≈line 1031):
   `compileConsoleCallWasi` receives the method name as its 4th param
   (currently `_method`). Use it to pick which write helper to call:
   - `log` / `info` / `debug` → `__wasi_write_string` (fd=1, existing).
   - `warn` / `error` → new helper `__wasi_write_string_stderr` (fd=2).

2. **`src/codegen/index.ts`** (`emitWasiWriteStringHelper`, ≈line 3164):
   parameterise the helper to take fd, or emit a second helper
   `__wasi_write_string_stderr` that builds an iov and calls
   `fd_write(2, …)`. Registered alongside `__wasi_write_string` whenever
   `console.error` or `console.warn` is detected.

3. **Source detection** (`src/codegen/index.ts:3068`): the existing visitor
   already accepts `["log", "warn", "error"]`; extend tracking so the
   stderr-helper is registered only when `warn`/`error` is actually
   referenced (otherwise the wasm stays minimal).

4. **JS-host WASI polyfill** in `src/runtime.ts:4870` `buildWasiPolyfill`
   already routes fd=2 → `console.error` (line 4901). No change needed
   there; once the compiled code emits fd=2, the polyfill prints to stderr.

5. **CLI argv-style stderr** for the `--target node` path (if/when #1491
   lands a non-WASI compile path) — defer to a follow-up; this issue is
   scoped to WASI.

## Acceptance criteria

```ts
console.log("stdout-msg");
console.error("stderr-msg");
console.warn("stderr-warn");
```

Compiled with `--target wasi`, executed under `wasmtime` (or any WASI
runtime, including the bundled `buildWasiPolyfill`):
- `stdout-msg\n` appears on stdout.
- `stderr-msg\n` and `stderr-warn\n` appear on stderr.
- `2>&1` redirection merges them.

Test: `tests/wasi.test.ts` (or new) captures stdout+stderr separately and
asserts each lands in the right stream.

## Files to modify

- `src/codegen/expressions/builtins.ts` (≈line 1031–1090) — use `_method`
  to pick fd helper.
- `src/codegen/index.ts` (≈line 3097, 3164) — register and emit
  `__wasi_write_string_stderr` when warn/error are used.
- `src/runtime.ts:4870` — verify polyfill (already correct).
- `tests/equivalence.test.ts` or new `tests/wasi-stderr.test.ts` — assert
  stream routing.
