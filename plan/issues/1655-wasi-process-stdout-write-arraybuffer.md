---
id: 1655
title: "wasi: process.stdout.write(ArrayBuffer) — accept ArrayBuffer arg, not only Uint8Array literal"
status: done
created: 2026-05-24
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: easy
reasoning_effort: low
task_type: feature
area: wasi, codegen
language_feature: stdout, process, arraybuffer
goal: wasi-completeness
sprint: Backlog
depends_on: [1654]
related: [1651, 1653, 1654]
---

## Problem

#1651 added `process.stdout.write(str)` and
`process.stdout.write(new Uint8Array([…literal…]))` under `--target wasi`.

The AssemblyScript reference host
([`nm_assemblyscript.ts`](https://github.com/guest271314/native-messaging-webassembly/blob/main/nm_assemblyscript.ts))
writes its framed response with `process.stdout.write(arrayBuffer)` (and via
`Uint8Array.buffer`). js2wasm's WASI `process.stdout.write` lowering does not
accept a bare `ArrayBuffer`, nor a non-literal `Uint8Array` / `.subarray`
view — only the literal-array `Uint8Array` form.

## Proposed implementation

Extend the WASI `process.stdout.write` lowering (in
`src/codegen/expressions/calls.ts`, alongside the #1651 matching) to accept:

- an `ArrayBuffer` argument — copy its backing bytes to the page-2 write
  scratch region and issue one `fd_write`;
- a non-literal `Uint8Array` and `.subarray(...)` view — same copy-to-scratch
  + single `fd_write`, honouring the view's `byteOffset`/`length`.

Raw bytes verbatim, no transform, no trailing newline — same contract as the
#1651 `Uint8Array`-literal path.

## Dependencies

Depends on **#1654** — `ArrayBuffer` must produce a valid standalone/WASI
module before its bytes can be written. Until #1654 lands, an `ArrayBuffer`
argument can't even be constructed validly under `--target wasi`.

## Acceptance criteria

- `process.stdout.write(arrayBuffer)` compiles under `--target wasi` and emits
  exactly the buffer's bytes (no newline, no transform) under wasmtime.
- `process.stdout.write(uint8.subarray(a, b))` emits exactly `b - a` bytes from
  the correct offset.
- A non-literal `Uint8Array` (e.g. `new Uint8Array(arrayBuffer)`) writes its
  bytes verbatim.
- No regression to the #1651 string / `Uint8Array`-literal paths.
- The Native Messaging host can frame its response via
  `process.stdout.write(arrayBuffer)`, matching the reference (retirement of
  the literal workaround tracked in #1530).
