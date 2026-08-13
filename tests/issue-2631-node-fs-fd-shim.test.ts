// #2631 — node:fs fd-based readSync / writeSync via the linkable `node:fs` shim.
//
// loopdive/js2wasm#389: the Native Messaging example used
// `process.stdin.read(buffer, offset)`, which matches NO real Node API
// (process.stdin is an async Duplex stream with no synchronous buffer-filling
// read). The faithful synchronous primitives are `fs.readSync(fd, …)` /
// `fs.writeSync(fd, …)` — fd-based (integer fd 0/1/2), NOT path-based, mapping
// 1:1 to WASI fd_read / fd_write with no filesystem.
//
// Under `--target wasi` + `link: ["node:fs"]`, a module that imports
// `{ readSync, writeSync } from "node:fs"` emits wasm imports against module
// `"node:fs"` (the declared interface, not the shim that satisfies it) and
// carries NO direct `wasi_snapshot_preview1` fd_read/fd_write import for that
// path. A separately compiled `node-fs.wasm` (or a native WASI host, or the real
// `node:fs` under a JS host) provides that interface at link time.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

/**
 * Link the node-fs shim + the user module and round-trip a fixed stdin payload,
 * capturing fd=1 (stdout) and fd=2 (stderr) bytes. The shim owns the memory; the
 * user module imports it along with readSync/writeSync. A minimal WASI
 * fd_read/fd_write serves the payload incrementally over the shim-owned memory.
 */
function linkAndRun(userBinary: Uint8Array, stdin: Uint8Array): { stdout: Uint8Array; stderr: Uint8Array } {
  const shimBinary = buildNodeFsShim();
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const memView = () => new DataView(ref.mem!.buffer);
  const out1: number[] = [];
  const out2: number[] = [];
  let pos = 0;
  const wasi = {
    fd_read(fd: number, iovs: number, iovsLen: number, nread: number): number {
      // fd is the integer passed through from readSync(fd, …); fd=0 = stdin.
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
        const bytes = new Uint8Array(ref.mem!.buffer, ptr, len);
        if (wfd === 1) for (const b of bytes) out1.push(b);
        else if (wfd === 2) for (const b of bytes) out2.push(b);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
  };
  // Instantiate the shim FIRST (imports only wasi_snapshot_preview1), then the
  // user with {memory + readSync/writeSync} from the shim — no instantiation cycle.
  const shim = new WebAssembly.Instance(new WebAssembly.Module(shimBinary), {
    wasi_snapshot_preview1: wasi,
  });
  ref.mem = shim.exports.memory as WebAssembly.Memory;
  const user = new WebAssembly.Instance(new WebAssembly.Module(userBinary), {
    "node:fs": {
      memory: shim.exports.memory,
      readSync: shim.exports.readSync,
      writeSync: shim.exports.writeSync,
    },
    env: {},
  });
  (user.exports.main as () => void)();
  return { stdout: Uint8Array.from(out1), stderr: Uint8Array.from(out2) };
}

// A framed-echo host: read a 4-byte LE length prefix + body off fd 0, echo both
// back to fd 1, exactly mirroring the example's small-frame fast path. Uses the
// options form for readSync and the offset form for writeSync.
const FRAMED_ECHO = `
import { readSync, writeSync } from "node:fs";
function readExact(buf: Uint8Array, n: number): boolean {
  let got = 0;
  while (got < n) {
    const r = readSync(0, buf, { offset: got, length: n - got });
    if (r <= 0) return false;
    got = got + r;
  }
  return true;
}
function writeAll(out: Uint8Array): void {
  let n = 0;
  while (n < out.length) {
    const w = writeSync(1, out, n);
    if (w <= 0) return;
    n = n + w;
  }
}
export function main(): void {
  const header = new Uint8Array(4);
  if (!readExact(header, 4)) return;
  const len = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
  const body = new Uint8Array(len);
  if (!readExact(body, len)) return;
  writeAll(header);
  writeAll(body);
}
`;

describe("#2631 — node:fs fd-based readSync/writeSync shim", () => {
  it("emits node:fs imports (memory + readSync/writeSync), no direct wasi fd_read/fd_write", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    // Imports the node:fs interface: memory + the IO functions it uses.
    expect(wat).toContain('(import "node:fs" "memory" (memory');
    expect(wat).toContain('(import "node:fs" "readSync"');
    expect(wat).toContain('(import "node:fs" "writeSync"');
    // The shim implementation name must NOT leak into the module's declared deps.
    expect(wat).not.toContain("js2wasm:node-fs");
    // NO direct wasi_snapshot_preview1 fd_read/fd_write import survives for this path.
    expect(wat).not.toContain("wasi_snapshot_preview1");
    // The user module does NOT declare/own its own memory — it imports it.
    expect(wat).not.toContain('(export "memory"');
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("links node-fs.wasm and round-trips a framed message byte-for-byte", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success).toBe(true);
    // frame: len=5 (LE) + a body with non-printable / high bytes.
    const frame = Uint8Array.from([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
    const { stdout } = linkAndRun(result.binary, frame);
    expect(Array.from(stdout)).toEqual([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
  });

  it("readSync respects the options `length` so it never over-reads past the target", async () => {
    // A buffer larger than the available stdin: readSync(0, buf, {offset, length})
    // with length = remaining-to-target must stop at the target, not fill the buffer.
    const src = `
import { readSync, writeSync } from "node:fs";
export function main(): void {
  const buf = new Uint8Array(8); // capacity 8
  // Only read 3 bytes even though the buffer holds 8 — length caps the read.
  let got = 0;
  while (got < 3) {
    const r = readSync(0, buf, { offset: got, length: 3 - got });
    if (r <= 0) break;
    got = got + r;
  }
  const out = new Uint8Array(got);
  let i = 0;
  while (i < got) { out[i] = buf[i]; i = i + 1; }
  let n = 0;
  while (n < out.length) { const w = writeSync(1, out, n); if (w <= 0) break; n = n + w; }
}
`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success).toBe(true);
    // stdin has 5 bytes available, but we only ever request 3.
    const stdin = Uint8Array.from([0x41, 0x42, 0x43, 0x44, 0x45]);
    const { stdout } = linkAndRun(result.binary, stdin);
    expect(Array.from(stdout)).toEqual([0x41, 0x42, 0x43]);
  });

  it("writeSync(2, …) routes telemetry to fd=2 (stderr), off the stdout stream", async () => {
    const src = `
import { readSync, writeSync } from "node:fs";
export function main(): void {
  const a = new Uint8Array(2);
  a[0] = 0x68; a[1] = 0x69; // "hi"
  let n = 0;
  while (n < a.length) { const w = writeSync(2, a, n); if (w <= 0) break; n = n + w; }
  const b = new Uint8Array(2);
  b[0] = 0x6f; b[1] = 0x6b; // "ok"
  let m = 0;
  while (m < b.length) { const w = writeSync(1, b, m); if (w <= 0) break; m = m + w; }
}
`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success).toBe(true);
    const { stdout, stderr } = linkAndRun(result.binary, new Uint8Array(0));
    expect(Array.from(stdout)).toEqual([0x6f, 0x6b]); // "ok" only on fd=1
    expect(Array.from(stderr)).toEqual([0x68, 0x69]); // "hi" only on fd=2
  });

  it("path-based readFileSync(path) is rejected under --target wasi (no filesystem)", async () => {
    const src = `
import { readFileSync } from "node:fs";
export function main(): string {
  return readFileSync("/etc/hostname", "utf-8");
}
`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success).toBe(false);
    const msgs = (result.errors ?? []).map((e) => e.message).join("\n");
    expect(msgs).toMatch(/readFileSync/);
    // #1772 P2-a — the capability-map-driven gate in `tryCompileNodeFsCall` now
    // owns this rejection (it consumes the call before the legacy
    // `PATH_BASED_FS_FNS` gate in calls.ts), so the message is the map gate's text.
    expect(msgs).toMatch(/(un)?available under `?--target wasi`?|no filesystem|filesystem provider|#2631/);
  });

  it("link: ['node:fs'] is ignored for non-WASI targets (no node:fs shim import)", async () => {
    const src = `
import { readSync, writeSync } from "node:fs";
export function noop(): void {}
`;
    const result = await compile(src, { fileName: "x.ts", link: ["node:fs"] });
    // Non-WASI: the node:fs fd-shim path does not apply.
    expect(result.wat ?? "").not.toContain('(import "node:fs" "readSync"');
  });
});
