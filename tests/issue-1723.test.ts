// #1723 — writeMessage cast failure on a multi-segment / large message.
//
// Reported by guest271314 against the Native Messaging host (parent #389). A
// large response (~1 MiB) trapped with a WasmGC "cast failure" inside
// writeMessage; small single-segment responses worked.
//
// ROOT CAUSE (two coordinated bugs):
//   1. `process.stdout.write(<string>)` (and the console writer) emitted a
//      `ref.cast` of the argument DOWN to the concrete NativeString type before
//      calling the byte-writer helper. A runtime concat / template span (the
//      response `{"received":${body},...}`) is a ConsString (rope), and the
//      downcast TRAPS ("illegal cast") for a rope — the value never reached the
//      flattening helper. The host only worked for tiny still-flat responses.
//      FIX: `__wasi_write_any_string` now takes the AnyString supertype, so no
//      downcast is needed; it flattens any rope internally.
//   2. The string write staging buffer (and the stdin read staging buffer) are
//      fixed in pages 1/2; a ~1 MiB payload overflowed linear memory and
//      trapped "out of bounds". FIX: both paths now `memory.grow` to fit the
//      payload before staging.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

const PROCESS_DECL = `declare const process: {
  stdin: { read(buf: Uint8Array, offset?: number): number };
  stdout: { write(chunk: Uint8Array | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
};`;

/** Run a WASI module's `main`, capturing fd=1 (stdout) bytes. */
async function runCaptureStdout(source: string): Promise<number[]> {
  const result = await compile(source, { target: "wasi" });
  expect(result.success).toBe(true);
  const stdoutBytes: number[] = [];
  const ref: { mem?: WebAssembly.Memory } = {};
  const wasi = buildWasiPolyfill();
  const imports = {
    wasi_snapshot_preview1: new Proxy(wasi as unknown as Record<string, unknown>, {
      get(target, prop) {
        if (prop === "fd_write") {
          return (fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
            const dv = new DataView(ref.mem!.buffer);
            let total = 0;
            for (let i = 0; i < iovsLen; i++) {
              const ptr = dv.getUint32(iovs + i * 8, true);
              const len = dv.getUint32(iovs + i * 8 + 4, true);
              if (fd === 1) for (let j = 0; j < len; j++) stdoutBytes.push(dv.getUint8(ptr + j));
              total += len;
            }
            dv.setUint32(nwritten, total, true);
            return 0;
          };
        }
        return (target as Record<string, unknown>)[prop as string];
      },
    }),
  };
  const module = await WebAssembly.compile(result.binary);
  const instance = await WebAssembly.instantiate(module, imports);
  ref.mem = (instance.exports as Record<string, unknown>).memory as WebAssembly.Memory;
  wasi.setMemory(ref.mem);
  (instance.exports as Record<string, () => void>).main?.();
  return stdoutBytes;
}

describe("#1723 — process.stdout.write of a runtime cons-string must not trap", () => {
  it("writes a template-interpolated (ConsString) response without an illegal cast", async () => {
    // `{"received":${bodyStr},...}` is a rope. Before the fix this trapped.
    const out = await runCaptureStdout(`
      ${PROCESS_DECL}
      function build(n: number): string {
        let s = "";
        let i = 0;
        while (i < n) { s = s + String.fromCharCode(120); i = i + 1; }
        return s;
      }
      export function main(): void {
        const bodyStr = build(13);
        const response = \`{"received":\${bodyStr},"runtime":"js2wasm+wasi"}\`;
        process.stdout.write(response);
      }
    `);
    expect(Buffer.from(out).toString("latin1")).toBe('{"received":xxxxxxxxxxxxx,"runtime":"js2wasm+wasi"}');
  });

  it("writes a large (~1 MiB) cons-string response (the #389 headline case)", async () => {
    // Build ~1 MiB by repeated concat, embed in a wrapper template, write it
    // with a 4-byte LE length prefix — exactly the Native Messaging frame.
    const out = await runCaptureStdout(`
      ${PROCESS_DECL}
      function build(n: number): string {
        let s = "";
        let i = 0;
        while (i < n) { s = s + "ABCDEFGH"; i = i + 1; }
        return s;
      }
      export function main(): void {
        const body = build(131072); // 131072 * 8 = 1,048,576 chars
        const response = \`{"d":\${body}}\`;
        const len = response.length;
        process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]));
        process.stdout.write(response);
      }
    `);
    // First 4 bytes are the LE length prefix; the rest is the body.
    const declared = (out[0]! | (out[1]! << 8) | (out[2]! << 16) | (out[3]! << 24)) >>> 0;
    const bodyBytes = out.length - 4;
    expect(bodyBytes).toBe(1048582); // {"d": + 1048576 + }
    expect(declared).toBe(bodyBytes);
    // Spot-check boundaries: starts with the wrapper, ends with the closing brace.
    expect(Buffer.from(out.slice(4, 9)).toString("latin1")).toBe('{"d":');
    expect(out[out.length - 1]).toBe(0x7d); // '}'
  });
});
