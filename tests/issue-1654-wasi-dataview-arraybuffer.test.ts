// #1654 — ArrayBuffer / DataView-backed TypedArrays under --target wasi.
//
// Previously, `new ArrayBuffer(n)` + `DataView.setUint32(…, true)` +
// `new Uint8Array(arrayBuffer)` COMPILED but produced an INVALID module:
// wasmtime rejected it with `unknown global: global index out of bounds`.
// Root cause: the ArrayBuffer-length RangeError path emitted `global.get -1`
// (the nativeStrings sentinel) instead of materialising the message string
// inline, AND the DataView accessors + `new Uint8Array(arrayBuffer)` had no
// standalone (no-JS-host) implementation — the writes were silently dropped
// and the Uint8Array was created empty.
//
// This pins: (a) the module is VALID and instantiable, (b) DataView
// get/set{Uint,Int}{8,16,32} round-trip little- AND big-endian, and
// (c) `new Uint8Array(arrayBuffer)` views the buffer's bytes. Validated
// against a raw-byte WASI shim (the same shim shape verified under real
// wasmtime during development).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Run a compiled WASI module, returning the raw bytes written to fd=1. */
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

describe("#1654 ArrayBuffer/DataView under --target wasi", () => {
  it("compiles to a VALID, instantiable module (no `unknown global`)", async () => {
    const src = `${DECL}
      export function main(): void {
        const header = new ArrayBuffer(4);
        const dv = new DataView(header);
        dv.setUint32(0, 11, true);
        process.stdout.write(new Uint8Array(header));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    // The invalid-module bug surfaced as a -1 global index in the WAT.
    expect(result.wat).not.toContain("global.get -1");
    // Instantiation itself is the WebAssembly.validate gate (throws if invalid).
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("the exact repro emits the LE uint32 header bytes 0b 00 00 00", async () => {
    const src = `${DECL}
      export function main(): void {
        const header = new ArrayBuffer(4);
        const dv = new DataView(header);
        dv.setUint32(0, 11, true);
        process.stdout.write(new Uint8Array(header));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureStdout(result.binary);
    expect(Array.from(out)).toEqual([0x0b, 0x00, 0x00, 0x00]);
  });

  it("DataView get/set round-trips little- and big-endian across widths", async () => {
    const src = `${DECL}
      export function main(): void {
        const ab = new ArrayBuffer(16);
        const dv = new DataView(ab);
        dv.setUint32(0, 0x01020304, true);   // LE: 04 03 02 01
        dv.setUint32(4, 0x01020304, false);  // BE: 01 02 03 04
        dv.setUint8(8, 0xAB);
        dv.setUint16(9, 0xBEEF, true);       // LE: EF BE
        // read back and re-store to prove the getters work
        const g32 = dv.getUint32(0, true);   // 0x01020304
        dv.setUint8(11, g32 & 0xff);         // 04
        const g16 = dv.getUint16(9, true);   // 0xBEEF
        dv.setUint8(12, (g16 >> 8) & 0xff);  // BE
        const s8 = dv.getInt8(8);            // 0xAB as signed
        dv.setUint8(13, s8 & 0xff);          // AB
        process.stdout.write(new Uint8Array(ab));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureStdout(result.binary);
    expect(Array.from(out)).toEqual([
      0x04,
      0x03,
      0x02,
      0x01, // setUint32 LE
      0x01,
      0x02,
      0x03,
      0x04, // setUint32 BE
      0xab, // setUint8
      0xef,
      0xbe, // setUint16 LE
      0x04, // getUint32(LE) & 0xff
      0xbe, // getUint16(LE) >> 8
      0xab, // getInt8 & 0xff
      0x00,
      0x00, // untouched
    ]);
  });

  it("new Uint8Array(arrayBuffer) views the buffer bytes (not a zeroed length)", async () => {
    const src = `${DECL}
      export function main(): void {
        const ab = new ArrayBuffer(3);
        const dv = new DataView(ab);
        dv.setUint8(0, 0x10);
        dv.setUint8(1, 0x20);
        dv.setUint8(2, 0x30);
        const view = new Uint8Array(ab);
        process.stdout.write(view);
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureStdout(result.binary);
    expect(Array.from(out)).toEqual([0x10, 0x20, 0x30]);
  });

  it("the literal-array Uint8Array path (#1651) still works (no regression)", async () => {
    const src = `${DECL}
      export function main(): void {
        process.stdout.write(new Uint8Array([0, 1, 255, 10, 13]));
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiCaptureStdout(result.binary);
    expect(Array.from(out)).toEqual([0, 1, 255, 10, 13]);
  });
});
