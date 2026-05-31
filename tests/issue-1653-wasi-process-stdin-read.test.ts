// #1653 — process.stdin.read(buf, offset?) under --target wasi: the binary,
// incremental, synchronous Node-API stdin read. Lowers to fd_read(0, …) into
// the caller's typed buffer at `offset`, returning the byte count, so a
// `while (true)` port loop can read a fixed 4-byte LE header then exactly N
// body bytes — the Chrome Native Messaging frame shape.
//
// This is the standard-API replacement for the bespoke `readStdin()` (#1481),
// which drains to EOF and UTF-8-decodes (losing binary fidelity and the
// continuous-loop design). readStdin() is kept working but deprecated.
//
// Validated against a raw-byte WASI shim that hands a fixed input to fd_read
// in caller-controlled chunks (same shim shape verified under real wasmtime
// during development).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Run a compiled WASI module with a fixed stdin payload, capturing fd=1 bytes.
 * fd_read serves the payload incrementally (honouring each iov length and
 * advancing a cursor), so successive `process.stdin.read` calls observe the
 * stream advance — exactly like a real WASI host / wasmtime.
 */
function runWasiStdinToStdout(binary: Uint8Array, stdin: Uint8Array): Uint8Array {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const memView = () => new DataView(ref.mem!.buffer);
  const captured: number[] = [];
  let pos = 0;
  const wasi = {
    fd_read(_fd: number, iovs: number, iovsLen: number, nread: number): number {
      const view = memView();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, stdin.length - pos);
        new Uint8Array(ref.mem!.buffer, ptr, n).set(stdin.subarray(pos, pos + n));
        pos += n;
        total += n;
        if (n < len) break;
      }
      view.setUint32(nread, total, true);
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

const DECL = `declare const process: {
  stdin: { read(buf: Uint8Array | ArrayBuffer, offset?: number): number };
  stdout: { write(c: Uint8Array): void };
};`;

// Read exactly `len` bytes into `buf` starting at 0 via a read-until loop, then
// echo. Used by several tests; len comes from a 4-byte LE header.
const FRAMED_ECHO = `${DECL}
  export function main(): void {
    const header = new Uint8Array(4);
    let got = 0;
    while (got < 4) {
      const n = process.stdin.read(header, got);
      if (n <= 0) return;
      got = got + n;
    }
    const len = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
    const body = new Uint8Array(len);
    let bgot = 0;
    while (bgot < len) {
      const n = process.stdin.read(body, bgot);
      if (n <= 0) break;
      bgot = bgot + n;
    }
    process.stdout.write(body);
  }`;

describe("#1653 process.stdin.read under --target wasi", () => {
  it("compiles and produces an instantiable WASI module", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
    // fd_read import must be registered even without readStdin().
    expect(result.wat).toContain("fd_read");
  });

  it("reads a 4-byte LE header then the exact body, binary-verbatim", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    // header len=5 (LE), body = bytes incl. non-printable / high bytes
    const frame = Uint8Array.from([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
    const out = runWasiStdinToStdout(result.binary, frame);
    expect(Array.from(out)).toEqual([0x00, 0xff, 0x0a, 0x7f, 0x80]);
  });

  it("read() returns the byte count (used to advance the offset)", async () => {
    // Echo only what the FIRST read() returns, by writing header[0..n).
    const src = `${DECL}
      export function main(): void {
        const buf = new Uint8Array(8);
        const n = process.stdin.read(buf, 0);
        // store n in buf[7] (n fits a byte here) and emit just the n read bytes
        const out = new Uint8Array(n);
        let i = 0;
        while (i < n) { out[i] = buf[i]; i = i + 1; }
        process.stdout.write(out);
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiStdinToStdout(result.binary, Uint8Array.from([1, 2, 3]));
    // The shim serves the whole 3-byte payload in one fd_read (iov len was 8).
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it("supports a while(true) port loop over two consecutive messages", async () => {
    const src = `${DECL}
      export function main(): void {
        while (true) {
          const hbuf = new ArrayBuffer(4);
          const h = new Uint8Array(hbuf);
          let got = 0;
          while (got < 4) {
            const n = process.stdin.read(h, got);
            if (n <= 0) return;
            got = got + n;
          }
          const len = h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24);
          const body = new Uint8Array(len);
          let bgot = 0;
          while (bgot < len) {
            const n = process.stdin.read(body, bgot);
            if (n <= 0) break;
            bgot = bgot + n;
          }
          process.stdout.write(h);
          process.stdout.write(body);
        }
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    // frame1: len=2 "AB"; frame2: len=3 "XYZ"
    const frames = Uint8Array.from([0x02, 0, 0, 0, 0x41, 0x42, 0x03, 0, 0, 0, 0x58, 0x59, 0x5a]);
    const out = runWasiStdinToStdout(result.binary, frames);
    expect(Array.from(out)).toEqual([0x02, 0, 0, 0, 0x41, 0x42, 0x03, 0, 0, 0, 0x58, 0x59, 0x5a]);
  });

  it("reads into an ArrayBuffer-backed Uint8Array at a non-zero offset", async () => {
    const src = `${DECL}
      export function main(): void {
        const ab = new ArrayBuffer(6);
        const view = new Uint8Array(ab);
        // pre-fill, then read 3 bytes into offset 2
        view[0] = 0xAA;
        view[1] = 0xBB;
        const n = process.stdin.read(view, 2);
        process.stdout.write(view);
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiStdinToStdout(result.binary, Uint8Array.from([0x11, 0x22, 0x33]));
    // [AA BB] preserved, then 3 read bytes at offset 2, byte 5 stays 0.
    expect(Array.from(out)).toEqual([0xaa, 0xbb, 0x11, 0x22, 0x33, 0x00]);
  });

  it("returns 0 at EOF (empty stdin)", async () => {
    const src = `${DECL}
      export function main(): void {
        const buf = new Uint8Array(4);
        const n = process.stdin.read(buf, 0);
        // emit a single byte: 1 if n==0 (EOF), else 0
        const out = new Uint8Array(1);
        out[0] = n === 0 ? 1 : 0;
        process.stdout.write(out);
      }`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const out = runWasiStdinToStdout(result.binary, new Uint8Array(0));
    expect(Array.from(out)).toEqual([1]);
  });
});
