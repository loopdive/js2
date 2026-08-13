// #2748 — bun/tsc/esbuild-transpiled (TYPE-STRIPPED) `nm_js2wasm_deno.js` must compile to
// the SAME pure-WASI-P1 module as the direct `.ts`, not leak `env::__extern_get`.
//
// loopdive/js2wasm#389 (latest comment): the reporter's pipeline is
//   bun build --no-bundle nm_js2wasm_deno.ts --outfile nm_js2wasm_deno.js   # strips TS types
//   js2wasm nm_js2wasm_deno.js --target wasi
// The direct `.ts` compile imports ONLY `wasi_snapshot_preview1` and echoes
// byte-exactly (covered by issue-2684-deno-stdio.test.ts). The transpiled `.js`
// regressed: its `Uint8Array` PARAM annotations were stripped (`writeFull(out)` /
// `readExact(n)`), so `out.length` / `out[i]` on the now-`any`/externref buffer
// lowered through the polymorphic dynamic-read dispatch whose host-object MISS arm
// calls `__extern_get` — and under `--target wasi` (host-free) that became an
// unsatisfiable `env::__extern_get` / `env::__extern_is_undefined` import that
// breaks standalone instantiation under wasmtime.
//
// The Deno `fd_read`/`fd_write` stdio recognition itself already fires on the
// type-stripped shape (it is purely syntactic). The two fixes are:
//   1. route the object-runtime helpers (`__extern_get` & co.) to their Wasm-NATIVE
//      definitions under `ctx.wasi` (not just `ctx.standalone`) — WASI is host-free
//      (`strictNoHostImports`), so it must NOT add the `env::*` host import; and
//   2. resolve an untyped (`any`/externref) `Uint8Array` buffer at RUNTIME (cast to
//      the module's canonical u8 vec) in the Deno/node:fs sync-IO buffer path, so a
//      type-stripped buffer actually reads/writes instead of silently no-op-ing.
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
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

const examplePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "examples",
  "native-messaging",
  "nm_js2wasm_deno.ts",
);

/**
 * Reproduce `bun build <entry> --outfile out.js`: type-strip AND BUNDLE the entry
 * (inlining the shared `./nm_js2wasm_sync_framing` core, #2778) into a single ESM `.js`
 * via esbuild. A transform-only strip would leave the relative import dangling —
 * the post-#2778 reality that made the transpiled-`.js` path regress (#2754).
 */
async function transpileStrippedBundle(entry: string): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    loader: { ".ts": "ts" },
    external: ["node:fs"],
    platform: "neutral",
  });
  return result.outputFiles[0]!.text;
}

// A hand-written TYPE-STRIPPED equivalent of the nm_js2wasm_deno framed-echo host — the
// `writeFull`/`readExact` params carry NO `Uint8Array` annotation (exactly what a
// transpiler emits), so the buffers are `any`/externref. This is the deterministic
// backstop independent of esbuild's exact output.
const FRAMED_ECHO_UNTYPED = `
function readExact(n) {
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
function writeFull(out) {
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
export function main() {
  const header = readExact(4);
  if (header === null) return;
  const len = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
  const body = readExact(len);
  if (body === null) return;
  writeFull(header);
  writeFull(body);
}
`;

function importModules(wat: string): string[] {
  return [...wat.matchAll(/\(import "([^"]+)" "[^"]+"/g)].map((m) => m[1]!);
}

/** Assert a WASI compile imports ONLY wasi_snapshot_preview1 (no env:: leak). */
function expectPureWasi(wat: string, binary: Uint8Array): void {
  // No `env::*` host import at all — covers the #2748 `env::__extern_get` /
  // `env::__extern_is_undefined` leak. (Those names legitimately appear as DEFINED
  // native helpers in the object runtime; only the IMPORT form is the regression.)
  expect(wat).not.toContain('(import "env"');
  expect(wat).not.toMatch(/\(import "[^"]+" "__extern_get"/);
  expect(wat).not.toMatch(/\(import "[^"]+" "__extern_is_undefined"/);
  const modules = importModules(wat);
  expect(modules.every((m) => m === "wasi_snapshot_preview1")).toBe(true);
  expect(wat).toContain('(export "memory"');
  expect(() => new WebAssembly.Module(binary)).not.toThrow();
}

describe("#2748 — type-stripped Deno nm_js2wasm_deno.js → pure-WASI P1 (no env::__extern_get)", () => {
  it("the hand-written UNTYPED framed-echo compiles to a pure-WASI module", async () => {
    const result = await compile(FRAMED_ECHO_UNTYPED, { fileName: "nm_js2wasm_deno.js", target: "wasi" });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    expectPureWasi(result.wat ?? "", result.binary!);
  });

  it("the esbuild-transpiled (type-stripped) nm_js2wasm_deno.ts compiles to a pure-WASI module", async () => {
    // The reporter's exact pipeline: `bun build` strips TS types AND BUNDLES the
    // shared `./nm_js2wasm_sync_framing` core (#2778) into one file, then compiles the
    // `.js`. A transform-only strip would leave the relative import dangling.
    const code = await transpileStrippedBundle(examplePath);
    expect(code).toContain("Deno.stdin.readSync");
    expect(code).not.toContain(": Uint8Array"); // types really are stripped
    expect(code).not.toContain("./nm_js2wasm_sync_framing"); // shared core was inlined
    const result = await compile(code, { fileName: "nm_js2wasm_deno.js", target: "wasi" });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    expectPureWasi(result.wat ?? "", result.binary!);
  });

  describe.skipIf(!wasmtimeBin)("runs under wasmtime (pure WASI P1)", () => {
    let tmp: string;
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), "wt-2748-"));
    });
    afterAll(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    // Stream stdin/stdout via FILES, not pipes: a long framed echo can exceed the
    // OS pipe buffer (~64 KiB) and deadlock `execFileSync`'s bidirectional pipes
    // (the child blocks writing stdout before it finishes draining stdin). File
    // descriptors are deadlock-free at any size — which is the point of the
    // streaming-window host.
    function run(binary: Uint8Array, name: string, input: Buffer): Buffer {
      const wasmPath = join(tmp, `${name}.wasm`);
      const inPath = join(tmp, `${name}.in`);
      const outPath = join(tmp, `${name}.out`);
      writeFileSync(wasmPath, binary);
      writeFileSync(inPath, input);
      const inFd = openSync(inPath, "r");
      const outFd = openSync(outPath, "w");
      try {
        execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, wasmPath], { stdio: [inFd, outFd, "inherit"] });
      } finally {
        closeSync(inFd);
        closeSync(outFd);
      }
      return readFileSync(outPath);
    }

    const frame = (body: number[] | Buffer): Buffer => {
      const n = body.length;
      return Buffer.concat([
        Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]),
        Buffer.isBuffer(body) ? body : Buffer.from(body),
      ]);
    };

    it("untyped host round-trips a framed message byte-for-byte (incl. high/null bytes)", async () => {
      const result = await compile(FRAMED_ECHO_UNTYPED, { fileName: "nm_js2wasm_deno.js", target: "wasi" });
      expect(result.success).toBe(true);
      const input = frame([0x00, 0xff, 0x0a, 0x7f, 0x80, 0x41]);
      const out = run(result.binary!, "untyped_echo", input);
      expect(Buffer.compare(out, input)).toBe(0);
    });

    it("esbuild-transpiled nm_js2wasm_deno.js round-trips multiple frames incl. a >window body", async () => {
      const code = await transpileStrippedBundle(examplePath);
      const result = await compile(code, { fileName: "nm_js2wasm_deno.js", target: "wasi" });
      expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);

      const small = [0x00, 0xff, 0x0a, 0x7f, 0x80, 0x41];
      const big = Buffer.alloc(150000); // > the 64 KiB streaming window
      for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
      const input = Buffer.concat([frame(small), frame(big), frame(Buffer.from("end"))]);
      const out = run(result.binary!, "esb_echo", input);
      expect(Buffer.compare(out, input)).toBe(0);
    });
  });
});
