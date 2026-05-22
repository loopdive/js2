---
id: 1481
sprint: 52
title: "wasi: support reading stdin via fd_read"
status: done
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, runtime
language_feature: stdin
goal: wasi-completeness
related: []
---

## Problem

`--target wasi` programs cannot read from standard input. There is no
`fd_read` import, no `process.stdin`, no `readline`, and no Wasm-native
helper that pulls bytes from fd=0. Filter-style CLIs
(`cat | wasmtime app.wasm`), REPLs, and conformance suites that pipe a
fixture into the binary all break silently.

`grep -rn "fd_read\|stdin" src/` confirms there is **zero** code path
for stdin in either codegen or runtime.

## Current behavior

- Any reference to `process.stdin` or `readline.createInterface` fails
  at compile time (extern resolution) or at runtime with an undefined
  global.
- `import * as readline from "readline"` is in the
  `import-resolver.ts` allow-list (line 40) for the Node-host path
  only — under `--target wasi` there is no replacement helper, so the
  call site falls through to a missing import.
- Programs that need a single line of input have no escape hatch.

## Expected behavior

Provide a minimal, ergonomic stdin path in standalone mode:

1. A built-in `readStdin(): string` (or `__wasi_read_stdin_line`) that
   reads UTF-8 bytes from fd=0 until EOF (or first `\n` for the line
   variant) and returns a JS string.
2. Optional: map `process.stdin` reads or a small `readline`
   pseudo-module onto the same helper so existing TS source compiles.

The wasmtime call `echo "hello" | wasmtime app.wasm` should let the
program read `"hello\n"` as a string.

## Implementation plan

1. **Register the import.** In `src/codegen/index.ts:3036`
   (`registerWasiImports`) gate-detect `process.stdin`, `readline`, or
   a new builtin `readStdin`. Add:
   ```ts
   const fdReadType = addFuncType(ctx,
     [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
     [{ kind: "i32" }],
     "$wasi_fd_read");
   addImport(ctx, "wasi_snapshot_preview1", "fd_read",
     { kind: "func", typeIdx: fdReadType });
   ctx.wasiFdReadIdx = ctx.funcMap.get("fd_read")!;
   ```
   (`ctx.wasiFdReadIdx` needs to be added to the `CodegenContext` type
   in `src/codegen/context/types.ts` next to `wasiFdWriteIdx`.)

2. **Emit a `__wasi_read_stdin_all` helper** that loops `fd_read` over
   a growing scratch region (start at offset 1024 + reserved data,
   grow by re-bumping `__wasi_bump_ptr`), terminating on
   `nread === 0`. Return a `NativeString` (anyStrTypeIdx) populated
   from the bytes, matching how `nativeStrings` mode constructs
   strings elsewhere.

3. **Wire the front-end.** Three options, pick one:
   - **Builtin call**: recognise `readStdin()` in
     `src/codegen/expressions/calls.ts` (next to the `process.exit`
     branch at line 1722) and emit a call to the helper.
   - **process.stdin shim**: map a small set of `process.stdin` APIs
     (`readSync`, async iteration) to the helper.
   - **readline shim**: synthesise a minimal `readline` module that
     calls the helper line-by-line.

   Recommend starting with the `readStdin()` builtin — smallest
   surface, easy to test, no async ceremony.

4. **JS polyfill.** Extend `buildWasiPolyfill` in
   `src/runtime.ts:4870` to provide `fd_read(fd, iovs, iovs_len, nread)`
   that pulls from `process.stdin` (Node) or a queued buffer set by
   the test harness.

## Acceptance criteria

- `echo "hello world" | wasmtime app.wasm` where `app.ts` does
  `console.log(readStdin())` prints `hello world` and exits 0.
- Repeated `readStdin()` calls drain bytes correctly (no infinite
  loop on EOF).
- `buildWasiPolyfill` exposes a configurable input source so the
  vitest suite can feed deterministic bytes.
- New equivalence/integration test under `tests/wasi-stdin.test.ts`
  passes.

## Files to modify

- `src/codegen/context/types.ts` — add `wasiFdReadIdx: number`.
- `src/codegen/index.ts` ~3036 `registerWasiImports` — add fd_read
  import + emit `__wasi_read_stdin_all` helper near
  `emitWasiWriteStringHelper`.
- `src/codegen/expressions/calls.ts` ~1722 — recognise `readStdin()`.
- `src/runtime.ts` ~4870 `buildWasiPolyfill` — add `fd_read` shim.
- New: `tests/wasi-stdin.test.ts` + fixture.

## Suspended Work

- **PR**: https://github.com/loopdive/js2/pull/400
- **Branch**: `issue-1481-wasi-stdin`
- **Worktree**: `/workspace/.claude/worktrees/issue-1481-wasi-stdin`
- **HEAD SHA**: `04ade449ed5d31390ec7347a8d9c75115e2b3968`
- **Status when suspended**: in CI-wait — re-merged main after quality check rejected stale branch

### What's implemented
- `wasiFdReadIdx?: number` added to `CodegenContext`.
- `registerWasiImports` (`src/codegen/index.ts`) detects `readStdin()` calls and registers `wasi_snapshot_preview1.fd_read`.
- `__wasi_read_stdin_all` helper emitted: loops `fd_read` on fd=0 into linear-memory scratch (start 1024, 1KB chunks, 60KB cap) until EOF, then copies bytes into a fresh `NativeString` (`__str_data` i16 array).
- `compileCallExpression` (`src/codegen/expressions/calls.ts`) routes `readStdin()` under `ctx.wasi` to the helper.
- `collectExternDeclarations` (`src/codegen/index.ts:~6734`) skips the `declare function readStdin` → `env.readStdin` stub so the helper path takes over.
- `buildWasiPolyfill` (`src/runtime.ts:~4870`): added `fd_read(fd,iovs,iovs_len,nread)` shim + `setStdin(bytes|string)` hook.
- New `tests/wasi-stdin.test.ts` — 5 tests all passing.

### Resume steps
1. Check `/workspace/.claude/ci-status/pr-400.json` — if `head_sha` matches `f2879c74f` and `net_per_test > 0`, ratio <10%, no bucket >50: `gh pr merge 400 --merge --admin`.
2. If regressions, run `/dev-self-merge 400` to see analysis.
3. After merge: set `status: done` in this file, `rm /workspace/.claude/agent-status/issue-1481-wasi-stdin.json`, `git worktree remove /workspace/.claude/worktrees/issue-1481-wasi-stdin`.
