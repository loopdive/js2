// #1655 — process.stdout.write must also accept a bare ArrayBuffer (and a
// non-literal Uint8Array / .subarray view) under --target wasi, not just the
// new Uint8Array([...literal]) form from #1651. The AssemblyScript Native
// Messaging reference host writes its framed response via
// `process.stdout.write(arrayBuffer)`; without this the matcher fell through
// to the generic path and emitted invalid Wasm (illegal cast of i32_byte vec
// to f64 vec) or nothing at all.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Run a compiled WASI module, returning the raw bytes written to a given fd. */
function runWasiCaptureFd(binary: Uint8Array, fd: number): Uint8Array {
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
        if (wfd === fd) for (const b of new Uint8Array(ref.mem!.buffer, ptr, len)) captured.push(b);
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

describe("#1655 process.stdout.write(ArrayBuffer) under --target wasi", () => {
  it("writes a bare ArrayBuffer's bytes verbatim (no transform, no newline)", async () => {
    // Build a 4-byte LE length prefix in an ArrayBuffer via DataView, then
    // hand the buffer itself to stdout.write. This is the AssemblyScript
    // Native Messaging frame shape.
    const src = `declare const process: {
      stdout: { write(c: ArrayBuffer | Uint8Array | string): void };
    };
    export function main(): void {
      const buf = new ArrayBuffer(5);
      const dv = new DataView(buf);
      dv.setUint8(0, 0xde);
      dv.setUint8(1, 0xad);
      dv.setUint8(2, 0xbe);
      dv.setUint8(3, 0xef);
      dv.setUint8(4, 0x00);
      process.stdout.write(buf);
    }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureFd(result.binary, 1);
    expect(Array.from(out)).toEqual([0xde, 0xad, 0xbe, 0xef, 0x00]);
  });

  it("writes a non-literal Uint8Array verbatim", async () => {
    const src = `declare const process: {
      stdout: { write(c: Uint8Array | string): void };
    };
    export function main(): void {
      const u = new Uint8Array(3);
      u[0] = 7;
      u[1] = 8;
      u[2] = 9;
      process.stdout.write(u);
    }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureFd(result.binary, 1);
    expect(Array.from(out)).toEqual([7, 8, 9]);
  });

  it("writes a Uint8Array.subarray view honouring [begin, end)", async () => {
    const src = `declare const process: {
      stdout: { write(c: Uint8Array | string): void };
    };
    export function main(): void {
      const u = new Uint8Array([10, 20, 30, 40, 50]);
      process.stdout.write(u.subarray(1, 4));
    }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureFd(result.binary, 1);
    expect(Array.from(out)).toEqual([20, 30, 40]);
  });

  it("does not regress the existing string path", async () => {
    const src = `declare const process: { stdout: { write(c: string): void } };
      export function main(): void {
        process.stdout.write("ok");
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureFd(result.binary, 1);
    expect(Array.from(out)).toEqual([0x6f, 0x6b]);
  });

  it("does not regress the existing Uint8Array-literal path (#1651)", async () => {
    const src = `declare const process: { stdout: { write(c: Uint8Array | string): void } };
      export function main(): void {
        process.stdout.write(new Uint8Array([0, 1, 255, 10, 13]));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureFd(result.binary, 1);
    expect(Array.from(out)).toEqual([0, 1, 255, 10, 13]);
  });

  it("routes ArrayBuffer through stderr when called on process.stderr", async () => {
    const src = `declare const process: {
      stderr: { write(c: ArrayBuffer | string): void };
    };
    export function main(): void {
      const buf = new ArrayBuffer(3);
      const dv = new DataView(buf);
      dv.setUint8(0, 0x01);
      dv.setUint8(1, 0x02);
      dv.setUint8(2, 0x03);
      process.stderr.write(buf);
    }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureFd(result.binary, 2);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
