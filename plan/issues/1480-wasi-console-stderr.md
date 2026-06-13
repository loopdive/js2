---
id: 1480
title: "wasi: console.error and console.warn should write to stderr (fd=2)"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: console
goal: wasi-completeness
sprint: 52
related: []
---
## Problem

Under `--target wasi`, every `console.*` call routes through a single helper
`__wasi_write_string` that hardcodes **fd = 1 (stdout)**. As a result:

- `console.log("ok")` and `console.error("boom")` are indistinguishable to
  any wasmtime caller — both land on stdout.
- Shell pipelines like `node app.js 2>err.log` (or wasmtime equivalents
  `wasmtime app.wasm 2>err.log`) do not isolate diagnostics from program
  output.
- The JS-host `buildWasiPolyfill` in `src/runtime.ts:4884-4912` already
  routes `fd === 2` to `console.error`, so the polyfill is correct — only
  the codegen side is wrong.

## Current behavior

`src/codegen/index.ts:3164-3198` emits **one** helper
`__wasi_write_string(ptr, len)` that always calls `fd_write(1, ...)`.

`src/codegen/expressions/builtins.ts:1031-1093` (`compileConsoleCallWasi`)
ignores `_method` and dispatches every method (`log`, `warn`, `error`,
`info`, `debug`) to the single helper, so the fd-routing decision never
reaches the Wasm binary.

## Expected behavior

| method                  | fd | rationale                              |
|-------------------------|----|----------------------------------------|
| `console.log`, `info`, `debug` | 1  | stdout — primary output             |
| `console.warn`, `console.error` | 2  | stderr — diagnostics, like Node.js  |

`wasmtime app.wasm 2>err.log` should send `console.error` output to
`err.log` and leave `console.log` on the terminal.

## Implementation plan

1. **Generalise the writer helper.** In
   `src/codegen/index.ts:3164` rename `emitWasiWriteStringHelper` to emit
   a parameterised `__wasi_write_string_fd(fd: i32, ptr: i32, len: i32)`
   that uses the `fd` argument instead of the constant `1` at line 3183.
   Keep an `__wasi_write_string(ptr, len)` thin wrapper that calls
   `__wasi_write_string_fd(1, ptr, len)` so existing callers
   (`emitWasiWriteFileSyncHelper`, number/i32 writers in
   `builtins.ts:1153-1335`) keep working with no other changes.
   Register both helpers from `registerWasiImports` when `needsFdWrite`
   is true.

2. **Pick fd per method.** In `compileConsoleCallWasi`
   (`src/codegen/expressions/builtins.ts:1031`), turn the helper lookup
   into:
   ```ts
   const fd = (_method === "error" || _method === "warn") ? 2 : 1;
   const writeFdIdx = ctx.funcMap.get("__wasi_write_string_fd")!;
   // ... push i32.const fd before each call to writeFdIdx
   ```
   Replace every `{ op: "call", funcIdx: writeStringIdx }` in that
   function (and the helper bodies it composes via
   `emitWasiValueToStdout`, `ensureWasiWriteI32Helper`,
   `ensureWasiWriteF64Helper` at lines 1119, 1158, 1322) with the
   fd-parameterised path. The simplest shape: have the i32/f64 writers
   take `fd` as a leading parameter, and pass it through from
   `emitWasiValueToStdout`.

3. **Buffer flushing.** wasmtime line-buffers fd=2 differently from fd=1
   on some hosts — verify the trailing newline emit
   (`builtins.ts:1086-1090`) still flushes both fds. No change expected.

## Acceptance criteria

- Compile and run with wasmtime:
  ```ts
  console.log("stdout-line");
  console.error("stderr-line");
  ```
  `wasmtime app.wasm 1>/dev/null` prints only `stderr-line`.
  `wasmtime app.wasm 2>/dev/null` prints only `stdout-line`.
- `console.warn` lands on fd=2 (matches Node.js semantics).
- Equivalence test exists under `tests/equivalence.test.ts` (or a new
  WASI-targeted test) that compiles a fixture with mixed `log`/`error`,
  invokes `buildWasiPolyfill`, and asserts the JS polyfill's
  `console.error` and `console.log` were called with the right strings
  (the polyfill already splits by fd).
- `npm test -- tests/equivalence.test.ts` passes.

## Files to modify

- `src/codegen/index.ts` ~lines 3036–3198 (`registerWasiImports`,
  `emitWasiWriteStringHelper`, add `emitWasiWriteStringFdHelper`).
- `src/codegen/expressions/builtins.ts` ~lines 1031–1335
  (`compileConsoleCallWasi`, `emitWasiValueToStdout`,
  `ensureWasiWriteI32Helper`, `ensureWasiWriteF64Helper`).
- `src/codegen/expressions/calls.ts` ~line 1719 — no signature change,
  but verify the `_method` string is forwarded.
- New fixture under `tests/fixtures/wasi/console-stderr.ts` (or inline).
