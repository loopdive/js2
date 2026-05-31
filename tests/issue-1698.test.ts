// #1698 — `ArrayBuffer.prototype.slice(begin, end)` under --target wasi.
//
// In standalone / WASI mode there is no JS host runtime. Previously the
// extern-class dispatch for `slice` returned a degraded `ref.null extern`
// (args dropped) so a subsequent `new Uint8Array(sliced)` trapped with
// `illegal cast`. This test pins the native Wasm-only slice path against a
// CI-portable raw-byte WASI shim (the same shim used for the sibling
// #1654 DataView/ArrayBuffer test).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function runWasiCaptureStdout(binary: Uint8Array): Uint8Array {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const memView = () => new DataView(ref.mem!.buffer);
  const captured: number[] = [];
  const wasi = {
    fd_read(): number {
      return 0;
    },
    fd_write(wfd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = memView();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        if (wfd === 1) for (const b of new Uint8Array(ref.mem!.buffer, ptr, len)) captured.push(b);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit(): void {},
    random_get(): number {
      return 0;
    },
    clock_time_get(): number {
      return 0;
    },
  };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(binary), {
    wasi_snapshot_preview1: wasi,
    env: {},
  });
  ref.mem = inst.exports.memory as WebAssembly.Memory;
  (inst.exports.main as () => void)();
  return Uint8Array.from(captured);
}

const DECL = `declare const process: { stdout: { write(c: Uint8Array): void } };`;
const PRELUDE = `${DECL}
function fill(ab: ArrayBuffer): void {
  const dv = new DataView(ab);
  dv.setUint8(0, 0x41);
  dv.setUint8(1, 0x42);
  dv.setUint8(2, 0x43);
  dv.setUint8(3, 0x44);
}`;

describe("#1698 ArrayBuffer.prototype.slice under --target wasi", () => {
  it("compiles to a valid module (no `illegal cast` trap)", async () => {
    const src = `${PRELUDE}
      export function main(): void {
        const ab = new ArrayBuffer(4);
        fill(ab);
        const sliced = ab.slice(1, 3);
        process.stdout.write(new Uint8Array(sliced));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("basic slice(1, 3) returns bytes 0x42 0x43", async () => {
    const src = `${PRELUDE}
      export function main(): void {
        const ab = new ArrayBuffer(4);
        fill(ab);
        const sliced = ab.slice(1, 3);
        process.stdout.write(new Uint8Array(sliced));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(Array.from(runWasiCaptureStdout(result.binary))).toEqual([0x42, 0x43]);
  });

  it("omitted end defaults to byteLength (slice(1) → tail)", async () => {
    const src = `${PRELUDE}
      export function main(): void {
        const ab = new ArrayBuffer(4);
        fill(ab);
        const sliced = ab.slice(1);
        process.stdout.write(new Uint8Array(sliced));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(Array.from(runWasiCaptureStdout(result.binary))).toEqual([0x42, 0x43, 0x44]);
  });

  it("negative begin resolves from end (slice(-2) → last 2 bytes)", async () => {
    const src = `${PRELUDE}
      export function main(): void {
        const ab = new ArrayBuffer(4);
        fill(ab);
        const sliced = ab.slice(-2);
        process.stdout.write(new Uint8Array(sliced));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(Array.from(runWasiCaptureStdout(result.binary))).toEqual([0x43, 0x44]);
  });

  it("negative end resolves from end (slice(1, -1))", async () => {
    const src = `${PRELUDE}
      export function main(): void {
        const ab = new ArrayBuffer(4);
        fill(ab);
        const sliced = ab.slice(1, -1);
        process.stdout.write(new Uint8Array(sliced));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(Array.from(runWasiCaptureStdout(result.binary))).toEqual([0x42, 0x43]);
  });

  it("out-of-bounds end is clamped to byteLength (slice(2, 100))", async () => {
    const src = `${PRELUDE}
      export function main(): void {
        const ab = new ArrayBuffer(4);
        fill(ab);
        const sliced = ab.slice(2, 100);
        process.stdout.write(new Uint8Array(sliced));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(Array.from(runWasiCaptureStdout(result.binary))).toEqual([0x43, 0x44]);
  });

  it("begin >= end produces an empty buffer (slice(3, 1))", async () => {
    const src = `${PRELUDE}
      export function main(): void {
        const ab = new ArrayBuffer(4);
        fill(ab);
        const sliced = ab.slice(3, 1);
        process.stdout.write(new Uint8Array(sliced));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(Array.from(runWasiCaptureStdout(result.binary))).toEqual([]);
  });

  it("the slice is independent — mutating the source after slice does not affect it", async () => {
    const src = `${PRELUDE}
      export function main(): void {
        const ab = new ArrayBuffer(4);
        fill(ab);
        const sliced = ab.slice(0, 2);   // [0x41, 0x42]
        const dv = new DataView(ab);
        dv.setUint8(0, 0xFF);              // mutate source
        dv.setUint8(1, 0xFF);
        process.stdout.write(new Uint8Array(sliced));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(Array.from(runWasiCaptureStdout(result.binary))).toEqual([0x41, 0x42]);
  });
});
