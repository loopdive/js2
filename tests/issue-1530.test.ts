// #1530 — Native Messaging host example compiles to a valid WASI module.
//
// The example under examples/native-messaging/host.ts demonstrates reading a
// Chrome Native Messaging framed message off stdin (fd=0 via process.stdin.read), routing
// debug to stderr (fd=2 via console.error), and emitting a JSON response on
// stdout (fd=1). This test pins down that the example still compiles to a valid
// WASI binary that imports only wasi_snapshot_preview1 — so a refactor of the
// WASI codegen path can't silently break the documented example.
//
// It does NOT assert on the *content* the host writes to stdout: per the
// example's README, runtime-string output and the binary length prefix have
// documented gaps (filed as follow-up issues). This test guards compilation
// and module validity only.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "examples", "native-messaging", "host.ts");

describe("#1530 Native Messaging host example", () => {
  it("compiles examples/native-messaging/host.ts under --target wasi", () => {
    const src = readFileSync(hostPath, "utf-8");
    const result = compile(src, { fileName: "host.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
  });

  it("imports stdin (fd_read) and stdout (fd_write) WASI syscalls, no env imports", () => {
    const src = readFileSync(hostPath, "utf-8");
    const result = compile(src, { fileName: "host.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("wasi_snapshot_preview1");
    expect(result.wat).toContain("fd_read"); // process.stdin.read()
    expect(result.wat).toContain("fd_write"); // console.log / console.error
    // Standalone: no JS host env.* imports leak in.
    expect(result.wat).not.toContain('(import "env"');
  });

  it("produces a binary that WebAssembly accepts", () => {
    const src = readFileSync(hostPath, "utf-8");
    const result = compile(src, { fileName: "host.ts", target: "wasi" });
    expect(result.success).toBe(true);
    // Throws on an invalid module; passing means the structure/types are sound.
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });
});

// #1618 + #1651 — byte-exact stdin→stdout round-trip for the Native Messaging
// frame. This is the end-to-end behaviour the #1530 example demonstrates and
// that the earlier compile-only test deliberately punted on (runtime-string
// output + binary length prefix were documented gaps). We drive the compiled
// module with a *raw-byte* WASI shim (NOT the line-buffering buildWasiPolyfill,
// which decodes UTF-8 and splits on "\n") so the binary 4-byte length prefix —
// which contains non-UTF8 bytes and no newline — is captured verbatim.
describe("#1618/#1651 framed stdin→stdout round-trip", () => {
  // Minimal raw-byte WASI shim: fd_read drains a preloaded stdin buffer, fd_write
  // appends the exact bytes to an ordered capture list keyed by fd.
  function runWasiRaw(binary: Uint8Array, stdin: Uint8Array): Uint8Array {
    // Boxed so the WASI closures can read it after the instance is created.
    const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
    const memView = () => new DataView(ref.mem!.buffer);
    const writes: Array<[number, Uint8Array]> = [];
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
          if (n < len) break; // short read → EOF for the remaining iovs
        }
        view.setUint32(nread, total, true);
        return 0;
      },
      fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
        const view = memView();
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = view.getUint32(iovs + i * 8, true);
          const len = view.getUint32(iovs + i * 8 + 4, true);
          writes.push([fd, Uint8Array.from(new Uint8Array(ref.mem!.buffer, ptr, len))]);
          total += len;
        }
        view.setUint32(nwritten, total, true);
        return 0;
      },
      proc_exit(code: number): void {
        throw new Error(`proc_exit(${code})`);
      },
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
    // Reassemble the fd=1 (stdout) byte stream in write order.
    const fd1 = writes.filter(([fd]) => fd === 1).flatMap(([, b]) => Array.from(b));
    return Uint8Array.from(fd1);
  }

  function frame(jsonBody: string): Uint8Array {
    const body = new TextEncoder().encode(jsonBody);
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length, true);
    out.set(body, 4);
    return out;
  }

  it("decodes a framed input and re-frames the response with a 4-byte LE prefix", () => {
    // A self-contained host that mirrors the example: read the 4-byte prefix and
    // then exactly the declared body bytes via process.stdin.read read-until
    // loops, rebuild the body char-by-char, then write a framed response (binary
    // length prefix via Uint8Array + JSON body via string).
    const src = `
declare const process: {
  stdin: { read(buf: Uint8Array, offset?: number): number };
  stdout: { write(chunk: Uint8Array | string): void };
};
export function main(): void {
  const header = new Uint8Array(4);
  let got = 0;
  while (got < 4) {
    const n = process.stdin.read(header, got);
    if (n <= 0) return;
    got = got + n;
  }
  const len = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
  const bodyBuf = new Uint8Array(len);
  let bgot = 0;
  while (bgot < len) {
    const n = process.stdin.read(bodyBuf, bgot);
    if (n <= 0) break;
    bgot = bgot + n;
  }
  let body = "";
  for (let i = 0; i < len; i++) {
    body = body + String.fromCharCode(bodyBuf[i]);
  }
  const response = \`{"received":\${body}}\`;
  const rl = response.length;
  process.stdout.write(
    new Uint8Array([rl & 0xff, (rl >> 8) & 0xff, (rl >> 16) & 0xff, (rl >> 24) & 0xff]),
  );
  process.stdout.write(response);
}`;
    const result = compile(src, { fileName: "rt.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();

    const out = runWasiRaw(result.binary, frame('{"a":1}'));
    const expectedBody = '{"received":{"a":1}}';
    // 4-byte LE length prefix matches the body length…
    expect(new DataView(out.buffer, out.byteOffset).getUint32(0, true)).toBe(expectedBody.length);
    // …and the body bytes after the prefix are the JSON response verbatim.
    expect(new TextDecoder().decode(out.subarray(4))).toBe(expectedBody);
  });

  it("compiles the shipped example and round-trips it byte-exactly", () => {
    const src = readFileSync(hostPath, "utf-8");
    const result = compile(src, { fileName: "host.ts", target: "wasi" });
    expect(result.success).toBe(true);

    // The shipped host echoes the received body verbatim (byte-for-byte, no
    // wrapper), so the response body equals the input body exactly.
    const out = runWasiRaw(result.binary, frame('{"cmd":"ping"}'));
    const expectedBody = '{"cmd":"ping"}';
    expect(new DataView(out.buffer, out.byteOffset).getUint32(0, true)).toBe(expectedBody.length);
    expect(new TextDecoder().decode(out.subarray(4))).toBe(expectedBody);
  });

  // #389 — a 1 MiB framed body must round-trip byte-exact. guest271314
  // reported that a 1 MiB message came back as an array of NULLs: the
  // `process.stdout.write(Uint8Array)` fd_write staging buffer
  // (ensureWasiWriteUint8ArrayHelper) lacked the memory.grow guard the string
  // writer has (#1723), so any body past the default 3-page reserve overflowed
  // — corrupting/trapping. The fix grows linear memory to fit the staging
  // buffer before copying. This drives the SHIPPED host (Uint8Array body path)
  // with a 1 MiB payload and asserts the echo is byte-identical with zero nulls.
  it("round-trips a 1 MiB framed body byte-exactly (no NULL corruption) — #389", () => {
    const src = readFileSync(hostPath, "utf-8");
    const result = compile(src, { fileName: "host.ts", target: "wasi" });
    expect(result.success).toBe(true);

    const N = 1024 * 1024; // 1 MiB
    const body = new Uint8Array(N).fill(0x61); // 'a' — guest's {"0":97} byte
    const input = new Uint8Array(4 + N);
    new DataView(input.buffer).setUint32(0, N, true);
    input.set(body, 4);

    const out = runWasiRaw(result.binary, input);
    // 4-byte LE prefix declares the full 1 MiB length…
    expect(new DataView(out.buffer, out.byteOffset).getUint32(0, true)).toBe(N);
    // …and the echoed body is exactly N bytes, all 'a', with no NULLs/garbage.
    const echoed = out.subarray(4);
    expect(echoed.length).toBe(N);
    let nulls = 0;
    let nonA = 0;
    for (let i = 0; i < echoed.length; i++) {
      if (echoed[i] === 0) nulls++;
      else if (echoed[i] !== 0x61) nonA++;
    }
    expect(nulls).toBe(0);
    expect(nonA).toBe(0);
  });
});
