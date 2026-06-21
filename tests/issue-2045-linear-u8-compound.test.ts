// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2045 C.8 — compound element writes and `++`/`--` on a linear-backed
 * `Uint8Array` (WASI) silently failed to update linear memory.
 *
 * `b[i] += rhs` routed through `compileElementCompoundAssignment`, which
 * materialised the buffer as a value (the GC representation) and wrote the result
 * back through the externref/GC path — never touching the linear memory, so the
 * byte kept its old value (read 5, computed 6, stored nowhere). `b[i]++` /
 * `++b[i]` / `b[i]--` routed through `compileMemberIncDec`, which required a
 * `ref` array and threw at runtime on a `(ptr,len)` buffer.
 *
 * Fix: `tryEmitLinearU8ElementCompound` / `tryEmitLinearU8ElementUpdate`
 * (linear-uint8-codegen.ts) emit a read-modify-write at a single
 * `addr = ptr + trunc(i)` (`i32.load8_u` → op → `i32.store8`), bounds-checked
 * like the get/set paths. Prefix yields the new value, postfix the old; the
 * store truncates to the byte (so `200 += 100` wraps to 44).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileWasi(source: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.map((e) => e.message).join("; ") ?? "unknown"}`);
  }
  return result.binary;
}

/** Run a WASI module's `main`/`_start`, capturing the bytes written to fd 1. */
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

/** Compile + run, returning the single byte the program writes to stdout. */
async function runByte(body: string): Promise<number> {
  const src = `declare const process: { stdout: { write(b: Uint8Array): void } };
    export function main(): void {
      const b = new Uint8Array(4);
      ${body}
      const out = new Uint8Array(1);
      out[0] = b[0];
      process.stdout.write(out);
    }`;
  const got = await runWasiMain(await compileWasi(src));
  return got[0]!;
}

describe("#2045 C.8 — linear Uint8Array compound element writes", () => {
  it("b[0] += 1 stores the incremented byte", async () => {
    expect(await runByte("b[0] = 5; b[0] += 1;")).toBe(6);
  });

  it("b[0] -= 2 stores the decremented byte", async () => {
    expect(await runByte("b[0] = 5; b[0] -= 2;")).toBe(3);
  });

  it("b[0] *= 3 stores the product", async () => {
    expect(await runByte("b[0] = 4; b[0] *= 3;")).toBe(12);
  });

  it("compound write truncates to the byte (200 += 100 → 44)", async () => {
    expect(await runByte("b[0] = 200; b[0] += 100;")).toBe(44);
  });

  it("b[0] &= mask stores the masked byte", async () => {
    expect(await runByte("b[0] = 0xff; b[0] &= 0x0f;")).toBe(0x0f);
  });
});

describe("#2045 C.8 — linear Uint8Array ++ / --", () => {
  it("b[0]++ stores the incremented byte", async () => {
    expect(await runByte("b[0] = 5; b[0]++;")).toBe(6);
  });

  it("++b[0] stores the incremented byte", async () => {
    expect(await runByte("b[0] = 5; ++b[0];")).toBe(6);
  });

  it("b[0]-- stores the decremented byte", async () => {
    expect(await runByte("b[0] = 5; b[0]--;")).toBe(4);
  });

  it("postfix b[0]++ evaluates to the OLD value", async () => {
    // capture the postfix result in b[1], then read it back.
    const src = `declare const process: { stdout: { write(b: Uint8Array): void } };
      export function main(): void {
        const b = new Uint8Array(4);
        b[0] = 5;
        b[1] = b[0]++;          // b[1] = 5 (old), b[0] = 6
        const out = new Uint8Array(2);
        out[0] = b[1];
        out[1] = b[0];
        process.stdout.write(out);
      }`;
    expect(await runWasiMain(await compileWasi(src))).toEqual([5, 6]);
  });

  it("prefix ++b[0] evaluates to the NEW value", async () => {
    const src = `declare const process: { stdout: { write(b: Uint8Array): void } };
      export function main(): void {
        const b = new Uint8Array(4);
        b[0] = 5;
        b[1] = ++b[0];          // b[1] = 6 (new), b[0] = 6
        const out = new Uint8Array(2);
        out[0] = b[1];
        out[1] = b[0];
        process.stdout.write(out);
      }`;
    expect(await runWasiMain(await compileWasi(src))).toEqual([6, 6]);
  });

  it("b[0]++ wraps at the byte boundary (255++ → 0)", async () => {
    expect(await runByte("b[0] = 255; b[0]++;")).toBe(0);
  });
});
