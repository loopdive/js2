// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2045 — linear-backed `Uint8Array` (WASI) soundness holes, the two
 * silent-corruption routes found reviewing the #1886 Slice C merge:
 *
 *   A.1  Name-keyed buffer registry was scope-blind. A linear param `buf` plus
 *        an inner-block `const buf = new Uint8Array(...)` (a distinct symbol
 *        with the same text) collided in `fctx.linearU8Buffers`, so element
 *        access addressed the wrong buffer in both shadowing directions. The
 *        registry is now keyed by `ts.Symbol`.
 *
 *   A.2  `b[i]` / `b[i] = v` lowered to a raw `i32.load8_u`/`i32.store8` at
 *        `ptr + trunc(i)` with NO bounds check, so an OOB index silently
 *        read/wrote arbitrary linear memory (iovec scratch, string data, a
 *        caller's buffer under Slice C). The GC array path traps; the linear
 *        path now traps too (`idx (u32) >= len → unreachable`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const STDIN_DECL = `declare const process: {
  stdin: { read(b: Uint8Array, off?: number): number };
  stdout: { write(b: Uint8Array): void };
};`;

async function compileWasi(source: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return result.binary;
}

/** Run a WASI module's `main`/`_start`, capturing fd_write bytes. */
async function runWasiMain(binary: Uint8Array): Promise<number[]> {
  const module = await WebAssembly.compile(binary);
  const memRef: { value?: WebAssembly.Memory } = {};
  const out: number[] = [];
  const view = () => new DataView(memRef.value!.buffer);
  const memU8 = () => new Uint8Array(memRef.value!.buffer);
  const wasi = {
    fd_read: () => 0,
    fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const dv = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const p = dv.getUint32(base, true);
        const l = dv.getUint32(base + 4, true);
        for (const b of memU8().subarray(p, p + l)) out.push(b);
        total += l;
      }
      dv.setUint32(nwrittenPtr, total, true);
      return 0;
    },
    proc_exit: () => {
      throw new Error("__proc_exit");
    },
  };
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  memRef.value = exports.memory as WebAssembly.Memory;
  const entry = (exports.main ?? exports._start) as undefined | (() => void);
  if (!entry) throw new Error("no main/_start export");
  entry();
  return out;
}

describe("#2045 linear Uint8Array soundness", () => {
  // A.2 — out-of-bounds read traps instead of returning arbitrary memory.
  it("A.2: OOB read traps like the GC path", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        const x = buf[100];   // OOB — must trap
        const out = new Uint8Array(1);
        out[0] = x;
        process.stdout.write(out);
      }`;
    const bin = await compileWasi(src);
    await expect(runWasiMain(bin)).rejects.toThrow();
  });

  // A.2 — out-of-bounds write traps instead of scribbling into linear memory.
  it("A.2: OOB write traps like the GC path", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        buf[100] = 7;         // OOB — must trap
        process.stdout.write(buf);
      }`;
    const bin = await compileWasi(src);
    await expect(runWasiMain(bin)).rejects.toThrow();
  });

  // A.2 — a negative index is a huge u32 and must trap too.
  it("A.2: negative index traps", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        const i = -1;
        buf[i] = 9;           // negative → huge u32 — must trap
        process.stdout.write(buf);
      }`;
    const bin = await compileWasi(src);
    await expect(runWasiMain(bin)).rejects.toThrow();
  });

  // A.2 — the in-bounds happy path is unaffected (read-back through the bounds
  // check still returns the stored bytes).
  it("A.2: in-bounds access is unchanged", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(3);
        buf[0] = 10;
        buf[1] = 20;
        buf[2] = buf[0] + buf[1];   // 30, last index in range
        process.stdout.write(buf);
      }`;
    const out = await runWasiMain(await compileWasi(src));
    expect(out).toEqual([10, 20, 30]);
  });

  // A.1 — a linear param `buf` and an inner-block `const buf` (same text,
  // distinct symbols) must address their own buffers. Before the fix the inner
  // registration overwrote the param's entry, so the trailing write to the
  // param's `buf` scribbled the inner buffer instead.
  it("A.1: inner-block shadow does not corrupt the param buffer", async () => {
    const src = `${STDIN_DECL}
      function fill(buf: Uint8Array): void {
        buf[0] = 1;
        buf[1] = 2;
        buf[2] = 3;
        {
          const buf = new Uint8Array(2);
          buf[0] = 9;
          buf[1] = 8;
          process.stdout.write(buf);   // inner → [9, 8]
        }
        process.stdout.write(buf);     // param → [1, 2, 3], NOT [9, 8]
      }
      export function main(): void {
        const outer = new Uint8Array(3);
        fill(outer);
      }`;
    const out = await runWasiMain(await compileWasi(src));
    expect(out).toEqual([9, 8, 1, 2, 3]);
  });

  // A.1 — the reverse shadow: a local `buf` declared before a same-name inner
  // const must keep addressing its own buffer after the inner block ends.
  it("A.1: outer local keeps its buffer after a same-name inner const", async () => {
    const src = `${STDIN_DECL}
      export function main(): void {
        const buf = new Uint8Array(2);
        buf[0] = 4;
        buf[1] = 5;
        {
          const buf = new Uint8Array(1);
          buf[0] = 99;
          process.stdout.write(buf);   // inner → [99]
        }
        process.stdout.write(buf);     // outer → [4, 5]
      }`;
    const out = await runWasiMain(await compileWasi(src));
    expect(out).toEqual([99, 4, 5]);
  });
});
