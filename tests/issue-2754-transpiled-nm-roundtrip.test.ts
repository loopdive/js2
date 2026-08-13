// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2754 — a `bun build` / esbuild **type-stripped + bundled** `.js` of the
 * SYNCHRONOUS Native-Messaging hosts (`nm_js2wasm_deno.ts`, `nm_js2wasm_node_fs.ts`) must
 * round-trip a framed message exactly the way the direct `.ts` does. This is
 * loopdive/js2wasm#389's exact pipeline:
 *
 *   bun build examples/native-messaging/nm_js2wasm_deno.ts --outfile nm_js2wasm_deno.js  # strips types + bundles
 *   js2wasm nm_js2wasm_deno.js --target wasi
 *
 * The transpiled `.js` had broken THREE times because only the `.ts` path was
 * tested. The most recent regression (#2778's shared-`nm_js2wasm_sync_framing` core)
 * surfaced as a **zero-output** miscompile: the host compiled clean to a pure
 * WASI module, instantiated, and exited 0 having read/written NOTHING.
 *
 * Root cause (#2754): once `nm_js2wasm_deno`/`nm_js2wasm_node_fs` inject their `readSync`/
 * `writeSync` as FUNCTION REFERENCES across the shared-core seam (`runNmHost(read,
 * write, …)`), stripping the types makes those params `any`. A call on an
 * `any`-typed value reaches the inline dynamic-dispatch path, which builds its
 * `ref.test`/`call_ref` arms from the funcref-wrapper closure types registered SO
 * FAR. A top-level `function denoRead(){}` only registered its wrapper LAZILY at
 * the value site (`main`), compiled AFTER the body that invokes the param —
 * so the dispatch had ZERO candidates and lowered `read(tmp)` to `ref.null.extern`.
 * The reader then always saw `null`/EOF on the first read and the host echoed
 * nothing. Pre-registering function-value wrappers before body codegen fixes it.
 *
 * This test type-strips AND BUNDLES (the reporter's real flow — not a
 * transform-only strip, which would leave the `./nm_js2wasm_sync_framing` import
 * dangling) **in-process via esbuild** (a devDep — no `bun` needed at test time),
 * compiles under `--target wasi`, drives the module through an in-process raw-fd
 * shim (so it runs on EVERY CI run, not only where `wasmtime` is installed), and
 * asserts an ACTUAL byte-exact ECHO — not merely "compiles" / "imports clean"
 * (the bug compiled fine and emitted zero bytes).
 */
import { join } from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import { compile, compileProject, entryHasRelativeImports } from "../src/index.js";
import { readFileSync } from "node:fs";

const NM_DIR = join(__dirname, "..", "examples", "native-messaging");
const MiB = 1024 * 1024;

// ---- framing helpers ---------------------------------------------------------
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

/** A valid JSON-array body `[null,null,…]` of ~`approx` bytes (the #389 payload). */
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

// ---- transpile (type-strip + bundle) the reporter's exact way -----------------
/**
 * Reproduce `bun build <file> --outfile out.js`: BUNDLE the entry (inlining the
 * shared `./nm_js2wasm_sync_framing` core) and STRIP the TS types, in-process via esbuild.
 * `node:fs` is kept external (bun does the same), so `nm_js2wasm_node_fs` retains its
 * `import { readSync, writeSync } from "node:fs"` for the compiler's node:fs
 * sync-IO recognition.
 */
async function transpileStrippedBundle(file: string): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [join(NM_DIR, file)],
    bundle: true,
    write: false,
    format: "esm",
    loader: { ".ts": "ts" },
    external: ["node:fs"],
    platform: "neutral",
  });
  const code = result.outputFiles[0]!.text;
  // The types REALLY are stripped (the seam params lose their annotations).
  expect(code).not.toContain(": Uint8Array");
  // The shared core was inlined (no dangling relative import).
  expect(code).not.toContain("./nm_js2wasm_sync_framing");
  return code;
}

// ---- in-process raw-fd shim (bulk copies) ------------------------------------
async function runFdShim(binary: Uint8Array, stdin: Uint8Array): Promise<Uint8Array> {
  let inPos = 0;
  const chunks: Uint8Array[] = [];
  let outLen = 0;
  const ref: { mem?: WebAssembly.Memory } = {};
  const wasi = {
    fd_read(_fd: number, iovs: number, iovsLen: number, nread: number): number {
      const v = new DataView(ref.mem!.buffer);
      const mem = new Uint8Array(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, stdin.length - inPos);
        if (n > 0) {
          mem.set(stdin.subarray(inPos, inPos + n), buf);
          inPos += n;
          total += n;
        }
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const v = new DataView(ref.mem!.buffer);
      const mem = new Uint8Array(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 1 && len > 0) {
          chunks.push(mem.slice(buf, buf + len));
          outLen += len;
        }
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
  const out = new Uint8Array(outLen);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ---- compile both the direct .ts and the stripped-bundled .js ----------------
async function compileTs(file: string): Promise<Uint8Array> {
  const path = join(NM_DIR, file);
  const src = readFileSync(path, "utf-8");
  const r = entryHasRelativeImports(src)
    ? await compileProject(path, { target: "wasi", skipSemanticDiagnostics: true })
    : await compile(src, { fileName: file, target: "wasi", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `(.ts) ${r.errors?.[0]?.message}`).toBe(true);
  return r.binary!;
}

async function compileStrippedJs(file: string): Promise<Uint8Array> {
  const code = await transpileStrippedBundle(file);
  const r = await compile(code, { fileName: file.replace(/\.ts$/, ".js"), target: "wasi" });
  expect(r.success, r.success ? "" : `(.js) ${r.errors?.[0]?.message}`).toBe(true);
  // No `env::*` host-import leak — the type-stripped buffer must NOT fall into the
  // host-object dynamic read that pulls in `env::__extern_get` (#2748 bug B).
  expect(r.wat ?? "").not.toContain('(import "env"');
  return r.binary!;
}

// =============================================================================
describe("#2754 — bun/esbuild type-stripped+bundled sync NM hosts round-trip under WASI", () => {
  // nm_js2wasm_deno re-chunks bodies > the 1 MiB browser cap (#2814); a body <= the cap
  // (here: small + an exactly-1 MiB body) echoes back byte-for-byte. This case stays
  // at/under the cap so the stream is a byte-exact echo, which still pins the #2754
  // stripped-bundle round-trip.
  it("nm_js2wasm_deno: stripped .js echoes a multi-frame stream byte-exact (incl. a 1 MiB body), matching .ts", async () => {
    const [tsBin, jsBin] = await Promise.all([
      compileTs("nm_js2wasm_deno.ts"),
      compileStrippedJs("nm_js2wasm_deno.ts"),
    ]);

    const small = new Uint8Array([0x00, 0xff, 0x0a, 0x7f, 0x80, 0x41]);
    const big = new Uint8Array(1 * MiB);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
    const end = new Uint8Array([0x65, 0x6e, 0x64]); // "end"
    const input = new Uint8Array(
      Buffer.concat([Buffer.from(frame(small)), Buffer.from(frame(big)), Buffer.from(frame(end))]),
    );

    const tsOut = await runFdShim(tsBin, input);
    const jsOut = await runFdShim(jsBin, input);

    // The bug echoed ZERO bytes — assert an ACTUAL byte-exact round-trip.
    expect(jsOut.length, "stripped .js must not emit zero bytes (the #2754 bug)").toBe(input.length);
    expect(Buffer.compare(Buffer.from(jsOut), Buffer.from(input)), "stripped .js must echo byte-exact").toBe(0);
    // …and match the .ts path exactly.
    expect(Buffer.compare(Buffer.from(jsOut), Buffer.from(tsOut)), "stripped .js must match the .ts path").toBe(0);
  });

  // nm_js2wasm_node_fs = re-chunk streamer: a body <= the 1 MiB cap echoes verbatim; a
  // larger array body is re-chunked into valid <=1 MiB JSON frames.
  it("nm_js2wasm_node_fs: stripped .js echoes under-cap frames byte-exact, matching .ts", async () => {
    const [tsBin, jsBin] = await Promise.all([
      compileTs("nm_js2wasm_node_fs.ts"),
      compileStrippedJs("nm_js2wasm_node_fs.ts"),
    ]);

    const small = new Uint8Array(Buffer.from("[1,2,3]", "ascii"));
    const end = new Uint8Array([0x5b, 0x5d]); // "[]"
    const input = new Uint8Array(Buffer.concat([Buffer.from(frame(small)), Buffer.from(frame(end))]));

    const tsOut = await runFdShim(tsBin, input);
    const jsOut = await runFdShim(jsBin, input);

    expect(jsOut.length, "stripped .js must not emit zero bytes (the #2754 bug)").toBeGreaterThan(0);
    expect(Buffer.compare(Buffer.from(jsOut), Buffer.from(input)), "under-cap frames echo verbatim").toBe(0);
    expect(Buffer.compare(Buffer.from(jsOut), Buffer.from(tsOut)), "stripped .js must match the .ts path").toBe(0);
  });

  it("nm_js2wasm_node_fs: stripped .js re-chunks a >1 MiB array body into valid frames, matching .ts", async () => {
    const [tsBin, jsBin] = await Promise.all([
      compileTs("nm_js2wasm_node_fs.ts"),
      compileStrippedJs("nm_js2wasm_node_fs.ts"),
    ]);

    const body = new Uint8Array(jsonArrayBody(2 * MiB)); // > the 1 MiB browser cap
    const input = frame(body);

    const tsOut = await runFdShim(tsBin, input);
    const jsOut = await runFdShim(jsBin, input);

    // The stripped .js must produce the SAME re-chunked stream as the .ts path.
    expect(jsOut.length, "stripped .js must not emit zero bytes (the #2754 bug)").toBeGreaterThan(0);
    expect(Buffer.compare(Buffer.from(jsOut), Buffer.from(tsOut)), "stripped .js must match the .ts re-chunk").toBe(0);

    // And the re-chunked frames reassemble to the original array body.
    const frames = parseFrames(jsOut);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    for (const f of frames) {
      expect(f.length, "each frame within the 1 MiB cap").toBeLessThanOrEqual(1 * MiB);
      expect(f[0], "frame opens with '['").toBe(0x5b);
      expect(f[f.length - 1], "frame closes with ']'").toBe(0x5d);
    }
    const parts: Buffer[] = [];
    for (let i = 0; i < frames.length; i++) {
      if (i > 0) parts.push(Buffer.from([0x2c])); // ,
      parts.push(Buffer.from(frames[i]!.subarray(1, frames[i]!.length - 1)));
    }
    const recon = Buffer.concat([Buffer.from([0x5b]), Buffer.concat(parts), Buffer.from([0x5d])]);
    expect(Buffer.compare(recon, Buffer.from(body)), "reassembled array equals the input body").toBe(0);
  });
});
