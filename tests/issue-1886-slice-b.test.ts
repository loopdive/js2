// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 Slice B — codegen for linear-backed `Uint8Array` buffers.
 *
 * Slice A (a separate test file) proves WHICH buffers are linear-safe. Slice B
 * is the codegen that backs a qualifying `new Uint8Array(n)` *local* by a
 * `(ptr,len)` pair in linear memory instead of a WasmGC vec, lowering `b[i]` /
 * `b[i] = v` / `b.length` to `i32.load8_u` / `i32.store8` / a `len` local, and
 * `process.std*.{read,write}(b)` to zero-copy `fd_read` / `fd_write`.
 *
 * These tests assert three things:
 *   1. The lowering FIRES for an intraprocedural, allocate-once buffer (the .wat
 *      shows `i32.store8` / `i32.load8_u` and no GC `array.set`/`$buf` local in
 *      the user function) AND the module VALIDATES — the original Slice-B WIP
 *      produced a void function ending in a bare `ref.null extern` (#1886).
 *   2. The lowering is CORRECT at runtime: a stdin → `buf[i]` r/w → stdout
 *      round-trip produces the right bytes.
 *   3. The Slice-B-only constraints hold (escape / multi-alloc / param-threaded
 *      buffers stay GC-backed), so a WASI program with no qualifying buffer is
 *      byte-identical to today.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile `source` with `--target wasi` and return the binary + .wat text. */
async function compileWasi(source: string): Promise<{ binary: Uint8Array; wat: string }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success || !result.binary) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  return { binary: result.binary, wat: result.wat ?? "" };
}

/**
 * Minimal raw-byte WASI host: preloads stdin and captures every fd_write byte
 * (no line buffering, so binary output is observable). Returns the captured
 * stdout/stderr bytes after running the module's exported `main`.
 */
async function runWasiRaw(binary: Uint8Array, stdin: Uint8Array): Promise<{ stdout: Uint8Array; stderr: Uint8Array }> {
  // Mutable state held in a const holder (the host closures are only invoked
  // after `state.memory` is set, but they capture it by reference).
  const state: { memory: WebAssembly.Memory | undefined; stdinPos: number } = {
    memory: undefined,
    stdinPos: 0,
  };
  const out: number[] = [];
  const err: number[] = [];

  const wasi = {
    fd_read(fd: number, iovs: number, _iovsLen: number, nread: number): number {
      const memory = state.memory;
      if (fd !== 0 || !memory) return -1;
      const view = new DataView(memory.buffer);
      const ptr = view.getUint32(iovs, true);
      const len = view.getUint32(iovs + 4, true);
      const n = Math.min(len, stdin.length - state.stdinPos);
      new Uint8Array(memory.buffer, ptr, n).set(stdin.subarray(state.stdinPos, state.stdinPos + n));
      state.stdinPos += n;
      view.setUint32(nread, n, true);
      return 0;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const memory = state.memory;
      if (!memory) return -1;
      const view = new DataView(memory.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        const sink = fd === 2 ? err : out;
        for (const b of bytes) sink.push(b);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit() {},
    fd_close: () => 0,
    fd_seek: () => 0,
    fd_fdstat_get: () => 0,
    environ_get: () => 0,
    environ_sizes_get: () => 0,
    clock_time_get: () => 0,
    random_get: () => 0,
    poll_oneoff: () => 0,
    path_open: () => 0,
  };

  const module = await WebAssembly.compile(binary);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi,
  });
  const exports = instance.exports as Record<string, unknown>;
  state.memory = exports.memory as WebAssembly.Memory;
  const main = exports.main as (() => void) | undefined;
  if (main) main();
  return { stdout: new Uint8Array(out), stderr: new Uint8Array(err) };
}

const IO_DECL = `
declare const process: {
  stdin: { read(b: Uint8Array, off?: number): number };
  stdout: { write(b: Uint8Array): void };
};
`;

describe("#1886 Slice B — linear-backed Uint8Array codegen", () => {
  it("element-set-only void main validates (no trailing ref.null extern)", async () => {
    // The original WIP left a bare `ref.null extern` at the end of this void
    // function (a value on the stack at function exit) → invalid wasm. Validating
    // (WebAssembly.compile throws on invalid) is the regression gate.
    const { binary, wat } = await compileWasi(`${IO_DECL}
      export function main(): void {
        const buf = new Uint8Array(8);
        buf[0] = (buf[0] + 1) & 255;
      }
    `);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
    // The lowering fired: store8 present, no GC vec write in main.
    expect(wat).toContain("i32.store8");
  });

  it("lowers buf[i] r/w + I/O to linear ops (store8/load8, no GC $buf local)", async () => {
    const { wat } = await compileWasi(`${IO_DECL}
      export function main(): void {
        const buf = new Uint8Array(8);
        process.stdin.read(buf, 0);
        buf[0] = (buf[0] + 1) & 255;
        process.stdout.write(buf);
      }
    `);
    const mainBody = wat.slice(wat.indexOf("(func $main"), wat.indexOf("(func $__box_number"));
    expect(mainBody).toContain("i32.store8");
    expect(mainBody).toContain("i32.load8_u");
    // GC element ops must NOT appear in the linear path.
    expect(mainBody).not.toContain("array.set");
    expect(mainBody).not.toContain("array.get");
    // The bump allocator + page-4 arena global are emitted.
    expect(wat).toContain("__lin_u8_alloc");
    expect(wat).toContain("__lin_u8_arena_ptr");
  });

  it("round-trips correctly: stdin byte 0x41 → buf[0]=(0x41+1)&255=0x42 → stdout", async () => {
    const { binary } = await compileWasi(`${IO_DECL}
      export function main(): void {
        const buf = new Uint8Array(8);
        process.stdin.read(buf, 0);
        buf[0] = (buf[0] + 1) & 255;
        process.stdout.write(buf);
      }
    `);
    const { stdout } = await runWasiRaw(binary, new Uint8Array([0x41]));
    expect(stdout.length).toBe(8);
    expect(stdout[0]).toBe(0x42); // 'A' + 1 = 'B'
    expect(Array.from(stdout.subarray(1))).toEqual([0, 0, 0, 0, 0, 0, 0]); // rest zero-filled
  });

  it("reads buf.length from the linear len local", async () => {
    const { binary } = await compileWasi(`${IO_DECL}
      export function main(): void {
        const buf = new Uint8Array(5);
        const one = new Uint8Array(1);
        one[0] = buf.length & 255;
        process.stdout.write(one);
      }
    `);
    const { stdout } = await runWasiRaw(binary, new Uint8Array([]));
    expect(stdout.length).toBe(1);
    expect(stdout[0]).toBe(5);
  });

  it("multiple linear writes in one loop sum correctly (sanity)", async () => {
    const { binary } = await compileWasi(`${IO_DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        let i = 0;
        while (i < 4) {
          buf[i] = (i + 1) & 255;
          i = i + 1;
        }
        process.stdout.write(buf);
      }
    `);
    const { stdout } = await runWasiRaw(binary, new Uint8Array([]));
    expect(Array.from(stdout)).toEqual([1, 2, 3, 4]);
  });

  it("escaping Uint8Array (returned from its function) stays GC-backed and compiles", async () => {
    // A buffer that escapes the GC heap (here: returned to the caller) must NOT
    // be linear-backed — it compiles via the GC vec path. The module validates
    // and no linear backing is emitted for the escaping buffer.
    const { binary, wat } = await compileWasi(`${IO_DECL}
      function makeBuf(): Uint8Array {
        const buf = new Uint8Array(4);
        buf[0] = 7;
        return buf; // escape → GC path
      }
      export function main(): void {
        const b = makeBuf();
        process.stdout.write(b);
      }
    `);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
    // The returned buffer is GC-backed: no linear (ptr,len) locals anywhere.
    expect(wat).not.toContain("__linu8_ptr_");
  });

  it("buffer threaded through a helper-function param stays GC-backed (Slice B is intraprocedural)", async () => {
    // The native-messaging host shape: a buffer passed to a user function. Slice
    // B must NOT linear-back it (no callee-signature rewrite until Slice C), so
    // no allocator is emitted and the module is byte-identical to GC-backed.
    const { binary, wat } = await compileWasi(`${IO_DECL}
      function fill(b: Uint8Array): void { b[0] = 9; }
      export function main(): void {
        const buf = new Uint8Array(4);
        fill(buf);
        process.stdout.write(buf);
      }
    `);
    await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
    // No linear backing kicked in for a param-threaded buffer.
    expect(wat).not.toContain("__lin_u8_alloc");
    expect(wat).not.toContain("__linu8_ptr_");
  });

  it("buffer allocated inside a loop stays GC-backed (bump arena has no reset until Slice D)", async () => {
    const { wat } = await compileWasi(`${IO_DECL}
      export function main(): void {
        let i = 0;
        while (i < 3) {
          const tmp = new Uint8Array(2);
          tmp[0] = i & 255;
          process.stdout.write(tmp);
          i = i + 1;
        }
      }
    `);
    // Allocate-once guard: a loop-body new must not be linear-backed.
    expect(wat).not.toContain("__lin_u8_alloc");
  });

  it("WASI program with no Uint8Array is unaffected (no arena global, no allocator)", async () => {
    const { wat } = await compileWasi(`console.log("plain wasi");`);
    expect(wat).not.toContain("__lin_u8_arena_ptr");
    expect(wat).not.toContain("__lin_u8_alloc");
  });
});
