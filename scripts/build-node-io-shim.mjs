// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2524 Phase 1 — build `node-shim.wasm`, the linkable implementation of the
 * `js2wasm:node-io` interface.
 *
 * The shim OWNS + exports the linear memory; a user module compiled with
 * `--node-io-shim` IMPORTS that memory (memory index 0) plus the three IO
 * functions, so the shim can read/write the user's bytes over the SAME memory
 * with no instantiation cycle (the shim imports only `wasi_snapshot_preview1`).
 *
 * Interface (`js2wasm:node-io`, byte boundary over the shared linear memory):
 *   stdin_read  (ptr i32, len i32) -> (i32)   // bytes read into mem[ptr..ptr+len)
 *   stdout_write(ptr i32, len i32) -> (i32)   // bytes written from mem[ptr..]
 *   stderr_write(ptr i32, len i32)            // (void)
 *
 * Memory layout: the shim reserves an 8-byte iovec scratch + a 4-byte
 * nread/nwritten cell at the very TOP of its address space (`SCRATCH_BASE`) so
 * it never collides with the user module's page-0 string-literal data, page-1
 * stdin buffer, page-2 write scratch, or page-4+ linear arena. (The user
 * module's own `__wasi_write_*` paths no longer touch memory[0..11] under the
 * shim — they hand `(ptr, len)` straight to these imports — so a dedicated
 * high scratch keeps the two modules' linear-memory usages disjoint.)
 *
 * `min: 3` matches the user module's reserved memory (`registerWasiImports`);
 * the shim grows on demand as the user module does, so its exported memory is
 * always large enough for the scratch at the top of the current size.
 *
 * Usage: `node scripts/build-node-io-shim.mjs [outPath]`
 *   default outPath: examples/native-messaging/node-shim.wasm
 * Also writes the `.wat` source next to the binary for inspection / wasmtime.
 */
import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// The iovec (8 bytes) + nread/nwritten cell (4 bytes) live in a fixed scratch
// region. memory[0..15] is reserved by the user module's iovec scratch in the
// inline path; under the shim the user module no longer writes there, but we
// keep the shim's scratch at memory[0..11] for symmetry with the inline ABI and
// because the user module's page-0 string-literal arena starts at offset 1024.
const IOVEC = 0; // [0]=buf_ptr [4]=buf_len
const NCELL = 8; // [8]=nread/nwritten

export const NODE_IO_SHIM_WAT = `(module
  ;; js2wasm:node-io shim — implements the byte-boundary IO interface over WASI.
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))

  ;; The shim owns + exports the shared linear memory. min 3 pages matches the
  ;; user module's reservation; grows on demand.
  (memory (export "memory") 3)

  ;; write(fd, ptr, len) -> bytes written. Builds an iovec at [${IOVEC}] pointing
  ;; at the CALLER's bytes (same memory) and issues fd_write.
  (func $write (param $fd i32) (param $ptr i32) (param $len i32) (result i32)
    (i32.store (i32.const ${IOVEC}) (local.get $ptr))
    (i32.store (i32.const ${IOVEC + 4}) (local.get $len))
    (drop (call $fd_write (local.get $fd) (i32.const ${IOVEC}) (i32.const 1) (i32.const ${NCELL})))
    (i32.load (i32.const ${NCELL})))

  (func (export "stdout_write") (param $ptr i32) (param $len i32) (result i32)
    (call $write (i32.const 1) (local.get $ptr) (local.get $len)))

  (func (export "stderr_write") (param $ptr i32) (param $len i32)
    (drop (call $write (i32.const 2) (local.get $ptr) (local.get $len))))

  ;; read(ptr, len) -> bytes read. iovec points at the caller's destination.
  (func (export "stdin_read") (param $ptr i32) (param $len i32) (result i32)
    (i32.store (i32.const ${IOVEC}) (local.get $ptr))
    (i32.store (i32.const ${IOVEC + 4}) (local.get $len))
    (drop (call $fd_read (i32.const 0) (i32.const ${IOVEC}) (i32.const 1) (i32.const ${NCELL})))
    (i32.load (i32.const ${NCELL}))))`;

/** Assemble the shim WAT to a validated wasm binary (Uint8Array). */
export function buildNodeIoShim() {
  const m = binaryen.parseText(NODE_IO_SHIM_WAT);
  m.setFeatures(binaryen.Features.All);
  if (!m.validate()) {
    m.dispose();
    throw new Error("node-io shim: binaryen validation failed");
  }
  const bin = m.emitBinary();
  m.dispose();
  return bin;
}

// CLI entry — only runs when invoked directly (not on import).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(repoRoot, "examples/native-messaging/node-shim.wasm");
  const bin = buildNodeIoShim();
  writeFileSync(out, bin);
  writeFileSync(out.replace(/\.wasm$/, ".wat"), NODE_IO_SHIM_WAT + "\n");
  console.log(`wrote ${out} (${bin.length} B) + .wat source`);
}
