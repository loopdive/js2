// #2684 — Deno synchronous stdio surface → DIRECT WASI Preview-1 fd_read/fd_write.
//
// loopdive/js2wasm#389: the Native Messaging host reporter runs directly under a WASI
// host (wasmtime) and is explicitly "not chasing Node.js". #2655 gave the Node
// (`node:fs` readSync/writeSync) variant of the dual-mode "runs under the runtime
// + compiles to wasi" story. This adds the DENO variant: the ambient
// `Deno.stdin.readSync` / `Deno.{stdout,stderr}.writeSync` member-call shapes
// lower straight to `wasi_snapshot_preview1.fd_read` / `fd_write`, so the SAME
// source compiles to a self-contained WASI P1 command module (imports ONLY
// `wasi_snapshot_preview1`, owns + exports its own memory) AND runs unmodified
// under real `deno` (which provides the `Deno` namespace).
//
// The one intricate part: `Deno.stdin.readSync` returns `number | null` (null at
// EOF). js2wasm lowers it to the compiler's NATIVE nullable representation (a
// boxed-number externref or `ref.null extern`) — `=== null` works in the
// standalone module with NO JS host import.
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";

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

// A framed-echo host using Deno stdio: read a 4-byte LE length prefix + body off
// fd 0, echo both back to fd 1. `readSync` returns `number | null`; `=== null` is
// the EOF signal. `export function main` with NO top-level call: `_start` wraps
// the exported main, so it runs exactly once under wasmtime.
const FRAMED_ECHO = `
function readExact(n: number): Uint8Array | null {
  const buf = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    if (got === 0) {
      const r = Deno.stdin.readSync(buf);
      if (r === null) return null;
      got = got + r;
    } else {
      const tmp = new Uint8Array(n - got);
      const r = Deno.stdin.readSync(tmp);
      if (r === null) return null;
      let i = 0;
      while (i < r) { buf[got + i] = tmp[i]; i = i + 1; }
      got = got + r;
    }
  }
  return buf;
}
function writeFull(out: Uint8Array): void {
  let buf = out;
  while (buf.length > 0) {
    const w = Deno.stdout.writeSync(buf);
    if (w <= 0) return;
    if (w >= buf.length) return;
    const rest = new Uint8Array(buf.length - w);
    let i = 0;
    while (i < rest.length) { rest[i] = buf[w + i]; i = i + 1; }
    buf = rest;
  }
}
export function main(): void {
  const header = readExact(4);
  if (header === null) return;
  const len = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
  const body = readExact(len);
  if (body === null) return;
  writeFull(header);
  writeFull(body);
}
`;

describe("#2684 — Deno stdio surface → direct WASI P1 fd_read/fd_write", () => {
  it("emits ONLY wasi_snapshot_preview1 fd_read/fd_write, no node:fs, owns memory", async () => {
    const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi" });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    const wat = result.wat ?? "";
    expect(wat).toContain('(import "wasi_snapshot_preview1" "fd_read"');
    expect(wat).toContain('(import "wasi_snapshot_preview1" "fd_write"');
    // No node:fs surface, and no env:: JS-host import for the nullable boxing.
    expect(wat).not.toContain('(import "node:fs"');
    expect(wat).not.toContain("node:fs");
    // Every import is from wasi_snapshot_preview1 — a self-contained P1 module.
    const imports = [...wat.matchAll(/\(import "([^"]+)" "[^"]+"/g)].map((m) => m[1]);
    expect(imports.every((m) => m === "wasi_snapshot_preview1")).toBe(true);
    // A standalone command module OWNS + exports its own memory.
    expect(wat).toContain('(export "memory"');
    // Blocking readSync — no async reactor machinery.
    expect(wat).not.toContain("poll_oneoff");
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("is byte-neutral for a program that does not reference Deno", async () => {
    const noDeno = `
import { writeSync } from "node:fs";
export function main(): void { writeSync(1, "hi\\n"); }
`;
    const result = await compile(noDeno, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(true);
    // The Deno detection never fires — this still goes through the node:fs path.
    const wat = result.wat ?? "";
    expect(wat).not.toContain("Deno");
  });

  it("the nm_js2wasm_deno.ts example compiles to a pure-WASI P1 module", async () => {
    const examplePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "examples",
      "native-messaging",
      "nm_js2wasm_deno.ts",
    );
    const src = readFileSync(examplePath, "utf-8");
    const result = await compile(src, { fileName: "nm_js2wasm_deno.ts", target: "wasi" });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    const wat = result.wat ?? "";
    const imports = [...wat.matchAll(/\(import "([^"]+)" "[^"]+"/g)].map((m) => m[1]);
    expect(imports.every((m) => m === "wasi_snapshot_preview1")).toBe(true);
    expect(wat).toContain('(export "memory"');
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  describe.skipIf(!wasmtimeBin)("runs under wasmtime (pure WASI P1)", () => {
    let tmp: string;
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), "wt-2684-"));
    });
    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    // #2821: feed wasmtime's stdin from a regular file (opened read-only and
    // handed to the child as fd 0) instead of streaming the input over a parent-
    // owned pipe. Piping `input` to the child races wasmtime's stdin close — a
    // pure-WASI command that hits EOF (readSync→null) or finishes echoing can
    // close fd 0 before the parent finishes writing the frame, surfacing as a
    // flaky EPIPE on the write end (aggravated by box load). A file fd has no
    // parent-side write end, so there is no pipe to break: EOF is the natural
    // end of file. Invocations are also serialized (execFileSync is synchronous,
    // one wasmtime spawn at a time) so concurrent runs never oversubscribe.
    function run(binary: Uint8Array, name: string, input: Buffer): Buffer {
      const p = join(tmp, `${name}.wasm`);
      writeFileSync(p, binary);
      const inPath = join(tmp, `${name}.in`);
      writeFileSync(inPath, input);
      const inFd = openSync(inPath, "r");
      try {
        return execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, p], {
          stdio: [inFd, "pipe", "inherit"],
          maxBuffer: 8 * 1024 * 1024,
        });
      } finally {
        closeSync(inFd);
      }
    }

    it("framed echo round-trips a message byte-for-byte (incl. high/null bytes)", async () => {
      const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi" });
      expect(result.success).toBe(true);
      // frame: len=5 (LE) + 5 body bytes with non-printable / high / null bytes.
      const frame = Buffer.from([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
      const out = run(result.binary!, "echo", frame);
      expect(Array.from(out)).toEqual([0x05, 0x00, 0x00, 0x00, 0x00, 0xff, 0x0a, 0x7f, 0x80]);
    });

    it("readSync returns null at EOF — a truncated stream stops cleanly", async () => {
      const result = await compile(FRAMED_ECHO, { fileName: "x.ts", target: "wasi" });
      expect(result.success).toBe(true);
      // Only 2 of the 4 prefix bytes are available → readExact hits EOF (null)
      // and main returns producing no output (no hang, no garbage).
      const out = run(result.binary!, "eof", Buffer.from([0x01, 0x00]));
      expect(out.length).toBe(0);
    });

    it("the nm_js2wasm_deno.ts example round-trips multiple frames (a sub-cap body echoes verbatim)", async () => {
      const examplePath = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "examples",
        "native-messaging",
        "nm_js2wasm_deno.ts",
      );
      // The deno example statically imports the shared `./nm_js2wasm_sync_framing`
      // core, so it MUST go through the multi-file bundler (compileProject) — a
      // single-file `compile` leaves `runNmHost` as an unsatisfiable `env.*` host
      // import and the module never echoes. (Mirrors the CLI's relative-import
      // routing, #2771.)
      const result = await compileProject(examplePath, { target: "wasi", skipSemanticDiagnostics: true });
      expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);

      const frame = (body: number[]): Buffer => {
        const n = body.length;
        return Buffer.concat([
          Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]),
          Buffer.from(body),
        ]);
      };
      const small = [0x00, 0xff, 0x0a, 0x7f, 0x80, 0x41];
      // 150 KiB body — below the deno host's 1 MiB browser-cap re-chunk threshold
      // (#2814), so it is echoed VERBATIM (prefix + body) byte-for-byte. (A body
      // LARGER than 1 MiB would be re-chunked into <=1 MiB JSON frames instead; the
      // re-chunk round-trip is covered by the matrix + comparison tests.)
      const big: number[] = [];
      for (let i = 0; i < 150000; i++) big.push((i * 7 + 3) & 0xff);
      const input = Buffer.concat([frame(small), frame(big)]);
      const out = run(result.binary!, "nm_js2wasm_deno", input);
      expect(Buffer.compare(out, input)).toBe(0);
    });
  });
});
