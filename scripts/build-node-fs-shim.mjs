// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2631 — build `node-fs.wasm`, a linkable provider of the `node:fs` import
 * interface (the fd-based synchronous primitives `readSync` / `writeSync`).
 *
 * The user module declares `import { readSync, writeSync } from "node:fs"`,
 * which js2wasm lowers to wasm imports `(import "node:fs" "readSync" …)` /
 * `(import "node:fs" "writeSync" …)`. The module declares WHAT host API it needs
 * (`node:fs`), not HOW it's satisfied; this shim is ONE provider of that
 * interface (over WASI fd_read / fd_write). A native WASI host or the real
 * `node:fs` module (under a JS host) are other providers.
 *
 * The shim OWNS + exports the linear memory; a user module compiled with
 * `--link node:fs` that uses ONLY node:fs (no process/console IO) IMPORTS
 * that memory (memory index 0) plus the two IO functions, so the shim can
 * read/write the user's bytes over the SAME memory with no instantiation cycle
 * (the shim imports only `wasi_snapshot_preview1`).
 *
 * Interface (`node:fs`, js2wasm pointer ABI over the shared linear memory):
 *   readSync (fd i32, ptr i32, len i32) -> (i32)   // bytes read into mem[ptr..ptr+len)
 *   writeSync(fd i32, ptr i32, len i32) -> (i32)   // bytes written from mem[ptr..]
 *
 * These are fd-based (integer fd 0/1/2), NOT path-based — they map 1:1 to
 * fd_read / fd_write with no path_open, no preopens, NO filesystem. (Only the
 * path-based `fs` family — readFileSync(path) — needs a filesystem.)
 *
 * `min: 3` matches the user module's reserved memory (`registerWasiImports`);
 * the shim grows on demand as the user module does.
 *
 * Usage: `node scripts/build-node-fs-shim.mjs [outPath]`
 *   default outPath: examples/native-messaging/node-fs.wasm
 * Also writes the `.wat` source next to the binary for inspection / wasmtime.
 */
import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// iovec (8 bytes) + nread/nwritten cell (4 bytes) scratch at memory[0..11].
const IOVEC = 0; // [0]=buf_ptr [4]=buf_len
const NCELL = 8; // [8]=nread/nwritten

export const NODE_FS_SHIM_WAT = `(module
  ;; A provider of the \`node:fs\` import interface (fd-based readSync / writeSync)
  ;; implemented over WASI fd_read / fd_write. (#2631)
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))

  ;; The shim owns + exports the shared linear memory. min 3 pages matches the
  ;; user module's reservation; grows on demand.
  (memory (export "memory") 3)

  ;; writeSync(fd, ptr, len) -> bytes written. Builds an iovec at [${IOVEC}]
  ;; pointing at the CALLER's bytes (same memory) and issues fd_write to \`fd\`.
  (func (export "writeSync") (param $fd i32) (param $ptr i32) (param $len i32) (result i32)
    (i32.store (i32.const ${IOVEC}) (local.get $ptr))
    (i32.store (i32.const ${IOVEC + 4}) (local.get $len))
    (drop (call $fd_write (local.get $fd) (i32.const ${IOVEC}) (i32.const 1) (i32.const ${NCELL})))
    (i32.load (i32.const ${NCELL})))

  ;; readSync(fd, ptr, len) -> bytes read. iovec points at the caller's
  ;; destination; issues fd_read from \`fd\`.
  (func (export "readSync") (param $fd i32) (param $ptr i32) (param $len i32) (result i32)
    (i32.store (i32.const ${IOVEC}) (local.get $ptr))
    (i32.store (i32.const ${IOVEC + 4}) (local.get $len))
    (drop (call $fd_read (local.get $fd) (i32.const ${IOVEC}) (i32.const 1) (i32.const ${NCELL})))
    (i32.load (i32.const ${NCELL}))))`;

/** Assemble the shim WAT to a validated wasm binary (Uint8Array). */
export function buildNodeFsShim() {
  const m = binaryen.parseText(NODE_FS_SHIM_WAT);
  // This shim only uses MVP instructions. Binaryen 132's `Features.All` also
  // enables CompactImports, causing `emitBinary()` to produce a module that
  // stock Wasmtime 46 rejects unless that experimental proposal is enabled.
  m.setFeatures(binaryen.Features.MVP);
  if (!m.validate()) {
    m.dispose();
    throw new Error("node-fs shim: binaryen validation failed");
  }
  const bin = m.emitBinary();
  m.dispose();
  return bin;
}

// CLI entry — only runs when invoked directly (not on import).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : resolve(repoRoot, "examples/native-messaging/node-fs.wasm");
  const bin = buildNodeFsShim();
  writeFileSync(out, bin);
  writeFileSync(out.replace(/\.wasm$/, ".wat"), NODE_FS_SHIM_WAT + "\n");
  console.log(`wrote ${out} (${bin.length} B) + .wat source`);
}
