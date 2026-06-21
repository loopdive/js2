// #2524 Phase 1 — process IO via the linkable `js2wasm:node-io` shim.
//
// Under `--target wasi` + `nodeIoShim: true`, a module that uses
// process.std{in,out,err} imports the `js2wasm:node-io` interface
// (stdin_read/stdout_write/stderr_write) plus its linear memory from
// `js2wasm:node-io`, and carries NO `wasi_snapshot_preview1` import for the
// stream IO path. A separately compiled `node-shim.wasm` implements that
// interface over WASI; the user module links against it (the shim OWNS +
// exports the shared memory, the user IMPORTS it — no instantiation cycle).
//
// These tests assert (1) the import shape, (2) flag-off parity, and (3) a real
// link + framed round-trip through the shim (the #2521 native-messaging frame).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildNodeIoShim } from "../scripts/build-node-io-shim.mjs";

const DECL = `declare const process: {
  stdin: { read(buf: Uint8Array | ArrayBuffer, offset?: number): number };
  stdout: { write(c: Uint8Array): void };
  stderr: { write(c: Uint8Array): void };
};`;

// Read a 4-byte LE length header then the exact body, then echo header+body —
// the Chrome Native Messaging frame shape exercised by #2521.
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
    process.stdout.write(header);
    process.stdout.write(body);
  }`;

/**
 * Link the node-io shim + the user module and round-trip a fixed stdin payload,
 * capturing fd=1 bytes. The shim owns the memory; the user module imports it
 * along with the three IO functions. A minimal WASI fd_read/fd_write serves the
 * payload incrementally over the shim-owned memory — exactly like a real host.
 */
function linkAndRun(userBinary: Uint8Array, stdin: Uint8Array): Uint8Array {
  const shimBinary = buildNodeIoShim();
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
  };
  // Instantiate the shim FIRST (it imports only wasi_snapshot_preview1), then
  // the user with {memory + io fns} from the shim — no instantiation cycle.
  const shim = new WebAssembly.Instance(new WebAssembly.Module(shimBinary), {
    wasi_snapshot_preview1: wasi,
  });
  ref.mem = shim.exports.memory as WebAssembly.Memory;
  const user = new WebAssembly.Instance(new WebAssembly.Module(userBinary), {
    "js2wasm:node-io": {
      memory: shim.exports.memory,
      stdout_write: shim.exports.stdout_write,
      stderr_write: shim.exports.stderr_write,
      stdin_read: shim.exports.stdin_read,
    },
    env: {},
  });
  (user.exports.main as () => void)();
  return Uint8Array.from(captured);
}

describe("#2524 Phase 1 — js2wasm:node-io shim", () => {
  it("user module imports js2wasm:node-io (memory + io fns), no wasi_snapshot_preview1", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi", nodeIoShim: true });
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    // Imports the node-io interface: memory + the IO functions it uses.
    expect(wat).toContain('(import "js2wasm:node-io" "memory" (memory');
    expect(wat).toContain('(import "js2wasm:node-io" "stdin_read"');
    expect(wat).toContain('(import "js2wasm:node-io" "stdout_write"');
    // NO wasi_snapshot_preview1 import survives for the stream IO path.
    expect(wat).not.toContain("wasi_snapshot_preview1");
    // The user module does NOT declare/own its own memory — it imports it.
    expect(wat).not.toContain('(export "memory"');
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("default (flag off) keeps the inline wasi_snapshot_preview1 fd_* path", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    expect(wat).toContain("wasi_snapshot_preview1");
    expect(wat).toContain("fd_read");
    expect(wat).toContain("fd_write");
    // Inline path declares + exports its own memory.
    expect(wat).toContain('(export "memory"');
    expect(wat).not.toContain("js2wasm:node-io");
  });

  it("links node-shim.wasm and round-trips a framed message byte-for-byte", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi", nodeIoShim: true });
    expect(result.success).toBe(true);
    // frame: len=5 (LE) + a body with non-printable / high bytes.
    const frame = Uint8Array.from([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
    const out = linkAndRun(result.binary, frame);
    // header echoed verbatim, then the exact body.
    expect(Array.from(out)).toEqual([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
  });

  it("round-trips two consecutive frames through one reused buffer", async () => {
    const src = `${DECL}
      export function main(): void {
        while (true) {
          const h = new Uint8Array(4);
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
    const result = await compile(src, { fileName: "x.ts", target: "wasi", nodeIoShim: true });
    expect(result.success).toBe(true);
    // frame1: len=2 "AB"; frame2: len=3 "XYZ"
    const frames = Uint8Array.from([0x02, 0, 0, 0, 0x41, 0x42, 0x03, 0, 0, 0, 0x58, 0x59, 0x5a]);
    const out = linkAndRun(result.binary, frames);
    expect(Array.from(out)).toEqual([0x02, 0, 0, 0, 0x41, 0x42, 0x03, 0, 0, 0, 0x58, 0x59, 0x5a]);
  });

  it("nodeIoShim is ignored for non-WASI targets (no node-io import)", async () => {
    const src = `export function add(a: number, b: number): number { return a + b; }`;
    const result = await compile(src, { fileName: "x.ts", nodeIoShim: true });
    expect(result.success).toBe(true);
    expect(result.wat ?? "").not.toContain("js2wasm:node-io");
  });
});
