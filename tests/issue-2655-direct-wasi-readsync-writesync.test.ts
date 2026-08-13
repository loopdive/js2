// #2655 — DIRECT WASI Preview-1 fd_read/fd_write for node:fs readSync/writeSync.
//
// loopdive/js2wasm#389: the Native Messaging host reporter runs directly under a
// WASI host (wasmtime) and is explicitly "not chasing Node.js". They want a
// SELF-CONTAINED WASI P1 command module that imports ONLY
// `wasi_snapshot_preview1` — no node:fs shim (`--link node:fs`), no Node
// runtime. #2631/#2633 gave the shim path; this adds the direct path: fd-based
// `readSync(0, …)` / `writeSync(1, …)` lower straight to
// `wasi_snapshot_preview1.fd_read` / `fd_write` (a plain BLOCKING read — NOT the
// async reactor's non-blocking fd_read + poll_oneoff), and the command module
// owns + exports its own `memory`.
//
// The `--link node:fs` path (the "same file also runs unmodified under real
// node via node:fs" story) is unchanged — covered by issue-2631-node-fs-fd-shim.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const WASMTIME_FLAGS = ["run", "-W", "gc=y,function-references=y,exceptions=y"];

function findWasmtime(): string | null {
  for (const cand of ["wasmtime", "/usr/local/bin/wasmtime"]) {
    try {
      execFileSync(cand, ["--version"], { stdio: "ignore" });
      return cand;
    } catch {
      /* try next */
    }
  }
  return null;
}
const wasmtimeBin = findWasmtime();

// A framed-echo host: read a 4-byte LE length prefix + body off fd 0, echo both
// back to fd 1 (mirrors the example's small-frame fast path + the #2631 shim
// test). `export function main` with NO top-level call: `_start` wraps the
// exported main, so it runs exactly once under wasmtime.
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

describe("#2655 — direct WASI P1 readSync/writeSync (no shim)", () => {
  it("emits ONLY wasi_snapshot_preview1 fd_read/fd_write, no node:fs import, owns memory", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi" });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    const wat = result.wat ?? "";
    // Direct WASI syscalls — no node:fs interface import.
    expect(wat).toContain('(import "wasi_snapshot_preview1" "fd_read"');
    expect(wat).toContain('(import "wasi_snapshot_preview1" "fd_write"');
    expect(wat).not.toContain('(import "node:fs"');
    expect(wat).not.toContain("node:fs");
    // A standalone command module OWNS + exports its own memory.
    expect(wat).toContain('(export "memory"');
    // No reactor machinery: blocking readSync pulls in fd_read alone, not
    // poll_oneoff / fd_fdstat_set_flags / the timer scheduler.
    expect(wat).not.toContain("poll_oneoff");
    expect(wat).not.toContain("fd_fdstat_set_flags");
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  // Sanity: the SAME source still compiles under --link node:fs to the shim
  // imports (the node-runtime variant), proving the dual mode coexists.
  it("--link node:fs still emits the node:fs shim imports (dual mode preserved)", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    expect(wat).toContain('(import "node:fs" "readSync"');
    expect(wat).toContain('(import "node:fs" "writeSync"');
    expect(wat).not.toContain("wasi_snapshot_preview1");
  });

  describe.skipIf(!wasmtimeBin)("runs under wasmtime (pure WASI P1)", () => {
    let tmp: string;
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), "wt-2655-"));
    });
    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    function run(binary: Uint8Array, name: string, input: Buffer): Buffer {
      const p = join(tmp, `${name}.wasm`);
      writeFileSync(p, binary);
      return execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, p], { input, maxBuffer: 4 * 1024 * 1024 });
    }

    it("framed echo round-trips a message byte-for-byte (incl. high/null bytes)", async () => {
      const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi" });
      expect(result.success).toBe(true);
      // frame: len=5 (LE) + 5 body bytes with non-printable / high bytes.
      const frame = Buffer.from([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
      const out = run(result.binary!, "echo", frame);
      expect(Array.from(out)).toEqual([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
    });

    it("readSync options `length` caps the read so it never over-reads past the target", async () => {
      const src = `
import { readSync, writeSync } from "node:fs";
export function main(): void {
  const buf = new Uint8Array(8); // capacity 8
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
      const result = await compile(src, { fileName: "x.ts", target: "wasi" });
      expect(result.success).toBe(true);
      // stdin has 5 bytes available, but we only ever request 3.
      const out = run(result.binary!, "cap", Buffer.from([0x41, 0x42, 0x43, 0x44, 0x45]));
      expect(Array.from(out)).toEqual([0x41, 0x42, 0x43]);
    });

    it("writeSync STRING overload writes UTF-8 bytes to the runtime fd", async () => {
      const src = `
import { writeSync } from "node:fs";
export function main(): void { writeSync(1, "héllo\\n"); }
`;
      const result = await compile(src, { fileName: "x.ts", target: "wasi" });
      expect(result.success).toBe(true);
      const out = run(result.binary!, "str", Buffer.alloc(0));
      expect(out.toString("utf-8")).toBe("héllo\n");
    });

    it("writeSync DataView overload writes the view's bytes to the runtime fd", async () => {
      const src = `
import { writeSync } from "node:fs";
export function main(): void {
  const ab = new ArrayBuffer(3);
  const dv = new DataView(ab);
  dv.setUint8(0, 65); dv.setUint8(1, 66); dv.setUint8(2, 67);
  writeSync(1, dv);
}
`;
      const result = await compile(src, { fileName: "x.ts", target: "wasi" });
      expect(result.success).toBe(true);
      const out = run(result.binary!, "dv", Buffer.alloc(0));
      expect(out.toString("utf-8")).toBe("ABC");
    });
  });
});
