---
id: 2524
title: "Phase 1: process IO via linkable js2wasm:node-io shim (--node-io-shim)"
status: in-progress
created: 2026-06-19
updated: 2026-06-20
priority: high
feasibility: hard
reasoning_effort: max
goal: modularization
sprint: 65
assignee: senior-developer
---
# #2524 -- Phase 1: process IO via linkable `js2wasm:node-io` shim

> NOTE: the canonical #2524 issue body lives in PR #1787 (not yet on `main`).
> This file is the Phase 1 implementation record added on the impl branch; it
> will conflict-resolve when #1787 lands. Keep edits here minimal.

## Objective

Under `--target wasi --node-io-shim`, a module that uses
`process.std{in,out,err}` emits an **import of the stable `js2wasm:node-io`
interface** instead of inlining the `wasi_snapshot_preview1.fd_read`/`fd_write`
glue. A separately-compiled `node-shim.wasm` implements that interface over
WASI; the user module links against it and carries **no**
`wasi_snapshot_preview1` import for the stream-IO path. This proves the
modular linking pattern that generalizes to fs/path and to deno/browser shims.

## Interface (`js2wasm:node-io`, byte boundary over shared linear memory)

- `stdin_read  (ptr i32, len i32) -> i32`
- `stdout_write(ptr i32, len i32) -> i32`
- `stderr_write(ptr i32, len i32)`

## Memory-ownership decision (resolved + spiked)

The **shim owns + exports** the linear memory; the **user module imports** it
(memory index 0) plus the three IO functions. Instantiate the shim first (it
imports only `wasi_snapshot_preview1`), then the user with `{memory + io fns}`
from the shim — no instantiation cycle. Spiked with hand-written 2-module
binaryen assembly + linked under both Node (V8) and `wasmtime --preload` before
wiring the compiler (`.tmp/node-io-shim-spike.mjs`).

## Implementation (this branch)

- **Memory `ImportDesc` variant** (`{ kind: "memory"; min; max? }`) + binary
  encoder (kind byte `0x02`) + WAT emitter + validator `numMemories` count
  (`src/ir/types.ts`, `src/emit/binary.ts`, `src/emit/wat.ts`).
- **`nodeIoShim` option** threaded CLI → `CompileOptions` → `CodegenOptions` →
  `CodegenContext` (WASI-only; ignored otherwise). New flag `--node-io-shim`.
- **`registerWasiImports`** (`src/codegen/index.ts`): when on, import the memory
  + `stdin_read`/`stdout_write`/`stderr_write` from `js2wasm:node-io` (instead of
  declaring/exporting memory), and recompute the WASI syscall-import needs so
  the stream/console IO path pulls NO `fd_read`/`fd_write` (only a `writeFileSync`
  file write still does).
- **Emit redirects**: the console/string/Uint8Array/ArrayBuffer write helpers and
  the GC + linear stdin-read / stdout-write paths call the imported node-io fns
  over the shared memory instead of building an iovec + `fd_*`
  (`src/codegen/index.ts`, `node-process-api.ts`, `linear-uint8-codegen.ts`).
- **Strict-mode gate**: `js2wasm:node-io` added to `ALWAYS_ALLOWED_IMPORT_MODULES`
  (it is a canonical linkable Wasm interface, not a JS-host binding).
- **Shim generator** `scripts/build-node-io-shim.mjs` → `examples/native-messaging/node-shim.wasm`
  (+ `.wat`). Link doc: `examples/native-messaging/NODE-IO-SHIM.md`.
- **Test** `tests/issue-2524-node-io-shim.test.ts`: import-shape assertion,
  flag-off parity, and a real shim-linked framed round-trip (+ two-frame reuse).

## Acceptance — met

- Native-messaging-shaped module under `--node-io-shim`: imports only
  `js2wasm:node-io` (memory + io fns), zero `wasi_snapshot_preview1`, links
  `node-shim.wasm`, round-trips a framed message byte-for-byte (verified Node +
  `wasmtime --preload`).
- Default (flag off) behavior unchanged; existing WASI IO tests green.

## Out of scope

- Phase 2 (#2514): GC runtime boundary / canonical rec group across the link.
- Component Model packaging (#2525, deferred alternative).
