// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2657 — RAW `wasi_snapshot_preview1` fd_read/fd_write import variant.
 *
 * The most honest pure-WASI-Preview-1 expression of fd-based IO: the source
 * imports the syscalls directly —
 *
 *   import { fd_read, fd_write } from "wasi_snapshot_preview1";
 *   import { store32, load32, store8, load8 } from "wasm:memory";
 *
 * — the fd calls bind 1:1 to the WASI import (fd_read/fd_write); the `wasm:memory`
 * accessors lower to a single inline linear-memory op (store32/load32/store8/
 * load8) and emit NO import (no host provides them). There is NO `node:fs`
 * surface: the emitted module imports ONLY `wasi_snapshot_preview1`, owns +
 * exports `memory`, and runs under wasmtime (loopdive/js2wasm#389).
 *
 * These cases pin:
 *   1. a raw fd echo compiles, imports ONLY `wasi_snapshot_preview1` (fd_read +
 *      fd_write, no node:fs / no env), owns+exports `memory`, and round-trips a
 *      framed message byte-correctly (incl. high + null bytes) under a fd shim;
 *   2. `store32/load32/store8/load8` lower inline (NOT as imports);
 *   3. the full `examples/native-messaging/nm_js2wasm_wasi_p1.ts` host echoes a framed
 *      Native-Messaging message byte-correctly under REAL wasmtime (gated on
 *      `findWasmtime()`), incl. a multi-window body;
 *   4. the existing `node:fs` example (`nm_js2wasm_node_fs.ts`) still compiles unchanged.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// wasmtime feature flags for the WasmGC + exception-handling binaries js2wasm
// emits (structs/arrays + the exception tag).
const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,exceptions=y"];

/** Resolve a usable `wasmtime` binary, or null when none is on PATH. */
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

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issue-2657-"));
});
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

async function compileWasi(src: string, name: string): Promise<Uint8Array> {
  const r = await compile(src, { fileName: `${name}.ts`, target: "wasi", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  return r.binary!;
}

/** Extract the (module,name) pairs of every import in a compiled WAT. */
function importModules(wat: string): Set<string> {
  const mods = new Set<string>();
  for (const line of wat.split("\n")) {
    const m = line.match(/\(import\s+"([^"]+)"/);
    if (m) mods.add(m[1]!);
  }
  return mods;
}

/**
 * Run a compiled raw-WASI module under an in-process fd_read/fd_write shim over
 * the module's exported `memory`, feeding `stdinBytes` to fd 0 and capturing fd 1
 * output as raw bytes. Mirrors the wasmtime fd ABI: iovec list + result slot.
 */
async function runWithFdShim(binary: Uint8Array, stdinBytes: Uint8Array): Promise<Uint8Array> {
  let inPos = 0;
  const out: number[] = [];
  const ref: { mem?: WebAssembly.Memory } = {};
  const dv = (): DataView => new DataView(ref.mem!.buffer);
  const wasi = {
    fd_read(_fd: number, iovs: number, iovsLen: number, nread: number): number {
      const v = dv();
      const mem = new Uint8Array(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, stdinBytes.length - inPos);
        for (let j = 0; j < n; j++) mem[buf + j] = stdinBytes[inPos + j]!;
        inPos += n;
        total += n;
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_write(_fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const v = dv();
      const mem = new Uint8Array(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        for (let j = 0; j < len; j++) out.push(mem[buf + j]!);
        total += len;
      }
      v.setUint32(nwritten, total, true);
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
  const { instance } = await WebAssembly.instantiate(binary, {
    wasi_snapshot_preview1: wasi as unknown as WebAssembly.ModuleImports,
    env: {},
  });
  ref.mem = instance.exports.memory as WebAssembly.Memory;
  const start = (instance.exports._start ?? instance.exports.main) as () => void;
  start();
  return Uint8Array.from(out);
}

/** Frame a body as a 4-byte LE length prefix + the body bytes (Native Messaging). */
function frame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  const n = body.length;
  out[0] = n & 0xff;
  out[1] = (n >> 8) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 24) & 0xff;
  out.set(body, 4);
  return out;
}

/** Split a framed stream back into its body frames (4-byte LE prefix + body). */
function parseFrames(stream: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let p = 0;
  while (p + 4 <= stream.length) {
    const len = stream[p]! + stream[p + 1]! * 256 + stream[p + 2]! * 65536 + stream[p + 3]! * 16777216;
    p += 4;
    if (p + len > stream.length) break;
    frames.push(stream.subarray(p, p + len));
    p += len;
  }
  return frames;
}

/** A valid JSON-array body `[null,null,…,null]` of approximately `approx` bytes. */
function jsonArrayBody(approx: number): Buffer {
  const m = Math.max(1, Math.floor((approx - 6) / 5) + 1);
  const total = 2 + 4 + 5 * (m - 1);
  const buf = Buffer.alloc(total);
  let p = 0;
  buf[p++] = 0x5b; // [
  buf.write("null", p, "ascii");
  p += 4;
  for (let i = 1; i < m; i++) {
    buf.write(",null", p, "ascii");
    p += 5;
  }
  buf[p++] = 0x5d; // ]
  return buf;
}

/** A minimal raw-fd echo: read a framed message and write it back verbatim. */
const RAW_ECHO_SRC = `
import { fd_read, fd_write } from "wasi_snapshot_preview1";
import { store32, load32, store8, load8 } from "wasm:memory";
type i32 = number;
const IOV: i32 = 0;
const RESULT: i32 = 8;
const DATA: i32 = 64;
function setIovec(buf: i32, len: i32): void {
  store32(IOV, buf);
  store32(IOV + 4, len);
  store32(RESULT, 0);
}
function readExact(buf: i32, n: i32): boolean {
  let got: i32 = 0;
  while (got < n) {
    setIovec(buf + got, n - got);
    const errno: i32 = fd_read(0, IOV, 1, RESULT);
    if (errno !== 0) return false;
    const r: i32 = load32(RESULT);
    if (r <= 0) return false;
    got = got + r;
  }
  return true;
}
function writeExact(buf: i32, n: i32): boolean {
  let put: i32 = 0;
  while (put < n) {
    setIovec(buf + put, n - put);
    const errno: i32 = fd_write(1, IOV, 1, RESULT);
    if (errno !== 0) return false;
    const w: i32 = load32(RESULT);
    if (w <= 0) return false;
    put = put + w;
  }
  return true;
}
export function main(): void {
  if (!readExact(DATA, 4)) return;
  const len: i32 = load8(DATA) + load8(DATA + 1) * 256 + load8(DATA + 2) * 65536 + load8(DATA + 3) * 16777216;
  if (len === 0) return;
  if (!writeExact(DATA, 4)) return;
  if (!readExact(DATA + 4, len)) return;
  writeExact(DATA + 4, len);
}
main();
`;

describe("#2657 raw wasi_snapshot_preview1 fd import — compile + imports", () => {
  it("imports ONLY wasi_snapshot_preview1 (fd_read + fd_write), owns+exports memory", async () => {
    const r = await compile(RAW_ECHO_SRC, { fileName: "echo.ts", target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    const wat = r.wat!;
    // The ONLY import module is the raw WASI core module — no node:fs, no env.
    expect(importModules(wat)).toEqual(new Set(["wasi_snapshot_preview1"]));
    expect(wat).toContain('(import "wasi_snapshot_preview1" "fd_read"');
    expect(wat).toContain('(import "wasi_snapshot_preview1" "fd_write"');
    expect(wat).not.toContain("node:fs");
    // Owns + exports its own linear memory.
    expect(wat).toContain('(export "memory"');
    expect(WebAssembly.validate(r.binary!)).toBe(true);
  });

  it("store32/load32/store8/load8 lower INLINE (not as imports)", async () => {
    const r = await compile(RAW_ECHO_SRC, { fileName: "echo.ts", target: "wasi", skipSemanticDiagnostics: true });
    const wat = r.wat!;
    // The accessors must NOT appear as imports — they are inline memory ops.
    expect(wat).not.toContain('"store32"');
    expect(wat).not.toContain('"load32"');
    expect(wat).not.toContain('"store8"');
    expect(wat).not.toContain('"load8"');
    // The inline memory ops are present.
    expect(wat).toContain("i32.store");
    expect(wat).toContain("i32.load");
  });

  it("a program that does NOT import the raw module is byte-neutral (no fd import forced)", async () => {
    const r = await compile(`export function add(a: number, b: number): number { return a + b; }`, {
      fileName: "plain.ts",
      target: "wasi",
      skipSemanticDiagnostics: true,
    });
    expect(r.success).toBe(true);
    expect(r.wat!).not.toContain('"fd_read"');
    expect(r.wat!).not.toContain('"fd_write"');
  });
});

describe("#2657 raw fd echo — round-trip under a fd shim", () => {
  it("echoes a framed message byte-for-byte (incl. high + null bytes)", async () => {
    const binary = await compileWasi(RAW_ECHO_SRC, "echo");
    // Body with high bytes (0xff, 0x80) and a null byte — the raw syscall layer
    // is byte-opaque, so the frame must come back unchanged.
    const body = Uint8Array.from([0x7b, 0x00, 0xff, 0x41, 0x80, 0x7d]); // { \0 \xff A \x80 }
    const input = frame(body);
    const out = await runWithFdShim(binary, input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("echoes an empty payload (zero-length frame is a clean shutdown)", async () => {
    const binary = await compileWasi(RAW_ECHO_SRC, "echo");
    const input = frame(new Uint8Array(0)); // declaredLen 0 → main returns before any write
    const out = await runWithFdShim(binary, input);
    expect(out.length).toBe(0);
  });
});

describe("#2657 nm_js2wasm_wasi_p1.ts example — real Native-Messaging host", () => {
  const examplePath = join(__dirname, "..", "examples", "native-messaging", "nm_js2wasm_wasi_p1.ts");

  it("compiles under --target wasi importing ONLY wasi_snapshot_preview1", async () => {
    const src = readFileSync(examplePath, "utf-8");
    const r = await compile(src, { fileName: "nm_js2wasm_wasi_p1.ts", target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    expect(importModules(r.wat!)).toEqual(new Set(["wasi_snapshot_preview1"]));
    expect(r.wat!).not.toContain("node:fs");
    expect(r.wat!).toContain('(export "memory"');
    expect(WebAssembly.validate(r.binary!)).toBe(true);
  });

  it("echoes a small framed JSON message byte-correctly under a fd shim", async () => {
    const src = readFileSync(examplePath, "utf-8");
    const binary = await compileWasi(src, "nm_js2wasm_wasi_p1");
    const body = new TextEncoder().encode('["hello",null,42]');
    const input = frame(body);
    const out = await runWithFdShim(binary, input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("re-chunks a multi-window (> 64 KiB) array body into valid <=1 MiB JSON frames", async () => {
    const src = readFileSync(examplePath, "utf-8");
    const binary = await compileWasi(src, "nm_js2wasm_wasi_p1");
    // A ~150 KiB valid JSON array body, larger than the host's 64 KiB re-chunk cap
    // (#2814): the raw-WASI host streams it back as a sequence of valid <=1 MiB
    // `[run]` frames whose interiors, reassembled with one comma between frames,
    // reproduce the original array body. (The host owns a fixed 3-page memory with
    // no memory.grow, so it caps frames at 64 KiB — comfortably <= the 1 MiB
    // browser cap.)
    const body = jsonArrayBody(150 * 1024);
    const input = frame(body);
    const out = await runWithFdShim(binary, input);
    const frames = parseFrames(out);
    // A > 64 KiB body MUST come back re-chunked into multiple <=1 MiB frames.
    expect(frames.length, "must re-chunk into multiple frames").toBeGreaterThan(1);
    const parts: Buffer[] = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      expect(f.length, "frame must be <= 1 MiB (browser cap)").toBeLessThanOrEqual(1024 * 1024);
      expect(f[0], "frame must open with '['").toBe(0x5b);
      expect(f[f.length - 1], "frame must close with ']'").toBe(0x5d);
      if (i > 0) parts.push(Buffer.from([0x2c])); // ,
      parts.push(Buffer.from(f.subarray(1, f.length - 1)));
    }
    const recon = Buffer.concat([Buffer.from([0x5b]), Buffer.concat(parts), Buffer.from([0x5d])]);
    expect(Buffer.compare(recon, body), "reassembled array must equal the input").toBe(0);
  });

  it.runIf(wasmtimeBin)("runs under REAL wasmtime: byte-correct framed echo", async () => {
    const src = readFileSync(examplePath, "utf-8");
    const binary = await compileWasi(src, "nm_js2wasm_wasi_p1_wasmtime");
    const path = join(tmpDir, "nm_js2wasm_wasi_p1.wasm");
    writeFileSync(path, binary);
    const body = Uint8Array.from([0x5b, 0x00, 0xff, 0x80, 0x41, 0x5d]); // [ \0 \xff \x80 A ]
    const input = frame(body);
    const out = execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, path], { input: Buffer.from(input) });
    expect(Array.from(out)).toEqual(Array.from(input));
  });
});

describe("#2657 — node:fs variant unchanged", () => {
  it("the existing nm_js2wasm_node_fs.ts example still compiles under --target wasi", async () => {
    const src = readFileSync(join(__dirname, "..", "examples", "native-messaging", "nm_js2wasm_node_fs.ts"), "utf-8");
    const r = await compile(src, { fileName: "nm_js2wasm_node_fs.ts", target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    // The node:fs variant declares WHAT it needs as `node:fs`; it must NOT have
    // grown a raw `wasi_snapshot_preview1` direct import path by accident.
    expect(r.wat!).toContain("fd_read");
    expect(r.wat!).toContain("fd_write");
  });
});
