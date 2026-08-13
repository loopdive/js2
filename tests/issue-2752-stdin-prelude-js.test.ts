// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2752 — a TYPE-STRIPPED (transpiled `.js`) `process.stdin` program must
 * compile AND run, not fail with 46 TS-grammar errors.
 *
 * The faithful `process.stdin` Readable surface is injected as a source PRELUDE
 * (`src/process-stdin-prelude.ts`) prepended to the user source. That prelude is
 * written in TypeScript (`declare function …`, `private chunk: string`,
 * `read(size?): string | null`). The combined unit is parsed downstream under
 * the USER file's extension — so for a `.js`-named input (the reporter's
 * `bun build → .js` pipeline, loopdive/js2wasm#389) the loose-JS grammar checker
 * hard-rejected the prelude's TS syntax with TS8017/8009/8010 ("… can only be
 * used in TypeScript files") and compilation failed BEFORE codegen. The direct
 * `.ts` path always worked (its callbacks are typed); only the transpiled `.js`
 * path was never exercised.
 *
 * Two fixes, both scoped to the prelude-injection path (byte-neutral elsewhere):
 *
 *   1. **Parse the prelude-injected unit under the TS grammar** even for a `.js`
 *      user file (`forceTsGrammar` in `analyzeSource` / the incremental
 *      language service, threaded from `compiler.ts` when `stdinResult.injected`).
 *      This flips ONLY the `ScriptKind`; the `.js`-derived lenient semantics
 *      (`strict: false`, `allowJs`/`checkJs`) are untouched.
 *
 *   2. **Type the prelude's `.on()` callback as a UNION** —
 *      `((c: string) => void) | (() => void)` instead of `any`. A type-stripped
 *      consumer's `.on("data", (chunk) => …)` arrow has an UNTYPED param; an
 *      `any` callback would give it no contextual type, so `chunk` lowered as
 *      externref. Its closure-struct shape then differed from the
 *      `((c: string) => void)[]` slot it is stored in, and the `emitChunk` call
 *      site (`ref.cast` to the (string)=>void closure struct) nulled the
 *      mismatched value and TRAPPED with a null reference. The union makes
 *      TypeScript contextually type the untyped `chunk` as `string`, so the
 *      arrow lowers as a (string)=>void closure that matches the slot — for both
 *      the typed (direct `.ts`) and untyped (transpiled `.js`) callback. This
 *      contextual typing only takes effect because of fix #1 (the prelude is now
 *      parsed as TS).
 *
 * The runtime gate (the unblocking criterion for loopdive/js2wasm#389 + the v0.57.0
 * publish): the type-stripped `nm_js2wasm_node_process.js` echoes a framed message
 * byte-exact AND exits cleanly under wasmtime with stdin held OPEN + the in-band
 * zero-length shutdown frame (`process.stdin.destroy()`).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,exceptions=y"];

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

const NM_DIR = join(__dirname, "..", "examples", "native-messaging");

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

/** The (module) name of every import in a compiled WAT. */
function importModules(wat: string): Set<string> {
  const mods = new Set<string>();
  for (const line of wat.split("\n")) {
    const m = line.match(/\(import\s+"([^"]+)"/);
    if (m) mods.add(m[1]!);
  }
  return mods;
}

interface RunResult {
  stdout: Uint8Array;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Spawn a compiled WASI module under wasmtime, write `input` to its stdin, and
 * resolve when it exits (or the timeout fires). When `keepOpen` is true the
 * parent's stdin pipe is left OPEN (never `.end()`-ed) so the child never sees
 * EOF — it must terminate via the in-band zero-length shutdown frame
 * (`process.stdin.destroy()`), the real Native-Messaging case. `timedOut: true`
 * means it hung.
 */
function runWasmtimeStdin(
  binPath: string,
  input: Uint8Array,
  opts: { keepOpen: boolean; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(wasmtimeBin!, [...WASMTIME_FLAGS, binPath], {
      stdio: ["pipe", "pipe", "ignore"], // drop fd 2 diagnostics
    });
    const out: number[] = [];
    child.stdout.on("data", (d: Buffer) => {
      for (const b of d) out.push(b);
    });
    child.stdin.on("error", () => {});
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ stdout: Uint8Array.from(out), exitCode: null, timedOut: true });
    }, opts.timeoutMs);
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: Uint8Array.from(out), exitCode: code, timedOut: false });
    });
    child.stdin.write(Buffer.from(input));
    if (!opts.keepOpen) child.stdin.end();
  });
}

// A hand-written TYPE-STRIPPED `process.stdin` echo host — the data callback's
// param carries NO annotation (`(chunk) =>`), exactly what a transpiler emits.
// Independent of esbuild's exact output, this is the deterministic backstop.
const STRIPPED_STDIN_ECHO = `
let buffered = "";
let stopped = false;
function decodeLength(s) {
  return s.charCodeAt(0) + s.charCodeAt(1) * 256 + s.charCodeAt(2) * 65536 + s.charCodeAt(3) * 16777216;
}
function drain() {
  while (!stopped) {
    if (buffered.length < 4) return;
    const len = decodeLength(buffered);
    if (len === 0) { stopped = true; process.stdin.destroy(); return; }
    const frameLen = 4 + len;
    if (buffered.length < frameLen) return;
    const out = new Uint8Array(frameLen);
    out[0] = len & 0xff;
    out[1] = (len >> 8) & 0xff;
    out[2] = (len >> 16) & 0xff;
    out[3] = (len >> 24) & 0xff;
    let i = 0;
    while (i < len) { out[4 + i] = buffered.charCodeAt(4 + i) & 0xff; i = i + 1; }
    process.stdout.write(out);
    buffered = buffered.substring(frameLen);
  }
}
function main() {
  process.stdin.on("data", (chunk) => { if (stopped) return; buffered = buffered + chunk; drain(); });
  process.stdin.on("end", () => {});
}
main();
`;

describe("#2752 — type-stripped process.stdin program compiles + runs", () => {
  // ── Compile-only invariants (always run, no runtime needed) ──────────────

  it("the esbuild-transpiled (type-stripped) nm_js2wasm_node_process.ts compiles to a pure-WASI module", async () => {
    // The reporter's exact pipeline: strip TS types, then compile the `.js`.
    const tsSrc = readFileSync(join(NM_DIR, "nm_js2wasm_node_process.ts"), "utf-8");
    const { code } = await esbuild.transform(tsSrc, { loader: "ts", format: "esm" });
    expect(code).toContain("process.stdin");
    expect(code).not.toContain(": string"); // types really are stripped
    const r = await compile(code, { fileName: "nm_js2wasm_node_process.js", target: "wasi" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    expect(WebAssembly.validate(r.binary!)).toBe(true);
    // No `env::*` host-import leak; pure WASI P1 — same module shape as the `.ts`.
    expect([...importModules(r.wat!)]).toEqual(["wasi_snapshot_preview1"]);
    // The reactor IS wired (the program uses process.stdin).
    expect(r.wat!.includes("__run_event_loop")).toBe(true);
  });

  it("a hand-written TYPE-STRIPPED process.stdin echo (.js) compiles to pure WASI", async () => {
    const r = await compile(STRIPPED_STDIN_ECHO, { fileName: "echo.js", target: "wasi" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    expect(WebAssembly.validate(r.binary!)).toBe(true);
    expect([...importModules(r.wat!)]).toEqual(["wasi_snapshot_preview1"]);
  });

  it("is byte-neutral: a `.js` program that never touches process.stdin gets no prelude", async () => {
    const r = await compile("export function add(a, b) { return a + b; }\n", {
      fileName: "plain.js",
      target: "wasi",
    });
    expect(r.success).toBe(true);
    expect(r.wat!.includes("__Js2wasmReadable"), "no Readable prelude for a stdin-free program").toBe(false);
    expect(r.wat!.includes("__run_event_loop"), "no event loop for a stdin-free program").toBe(false);
  });

  // ── Runtime behavior under real wasmtime (the gate) ──────────────────────

  const maybe = wasmtimeBin ? describe : describe.skip;
  maybe("under wasmtime — the type-stripped host echoes byte-exact and exits cleanly", () => {
    let tmpDir: string;
    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "issue-2752-"));
    });
    afterAll(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    async function buildStripped(name: string): Promise<string> {
      const tsSrc = readFileSync(join(NM_DIR, "nm_js2wasm_node_process.ts"), "utf-8");
      const { code } = await esbuild.transform(tsSrc, { loader: "ts", format: "esm" });
      const r = await compile(code, { fileName: "nm_js2wasm_node_process.js", target: "wasi" });
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      expect(WebAssembly.validate(r.binary!), "binary must validate").toBe(true);
      const path = join(tmpDir, `${name}.wasm`);
      writeFileSync(path, r.binary!);
      return path;
    }

    const requestFrame = frame(new TextEncoder().encode('["hello",null,42]'));
    const shutdownFrame = frame(new Uint8Array(0)); // zero-length = in-band clean shutdown

    it(
      "stdin held OPEN: exits cleanly on the in-band shutdown frame, echoes the data frame byte-exact",
      { timeout: 30_000 },
      async () => {
        const binPath = await buildStripped("nm_open_shutdown");
        const input = new Uint8Array([...requestFrame, ...shutdownFrame]);
        const res = await runWasmtimeStdin(binPath, input, { keepOpen: true, timeoutMs: 15_000 });
        expect(res.timedOut, "type-stripped open-stdin host HUNG").toBe(false);
        expect(res.exitCode).toBe(0);
        expect(Array.from(res.stdout), "must echo only the data frame, byte-exact").toEqual(Array.from(requestFrame));
      },
    );

    it("stdin held OPEN: round-trips a >window (multi-KiB) body byte-exact", { timeout: 30_000 }, async () => {
      const binPath = await buildStripped("nm_open_big");
      const big = new Uint8Array(4096);
      for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
      const bigFrame = frame(big);
      const input = new Uint8Array([...requestFrame, ...bigFrame, ...shutdownFrame]);
      const expected = new Uint8Array([...requestFrame, ...bigFrame]);
      const res = await runWasmtimeStdin(binPath, input, { keepOpen: true, timeoutMs: 15_000 });
      expect(res.timedOut, "type-stripped open-stdin host HUNG on a multi-frame payload").toBe(false);
      expect(res.exitCode).toBe(0);
      expect(Array.from(res.stdout)).toEqual(Array.from(expected));
    });

    it("stdin CLOSED (EOF): still echoes the frame and exits", { timeout: 30_000 }, async () => {
      const binPath = await buildStripped("nm_eof");
      const input = new Uint8Array([...requestFrame, ...shutdownFrame]);
      const res = await runWasmtimeStdin(binPath, input, { keepOpen: false, timeoutMs: 15_000 });
      expect(res.timedOut, "type-stripped EOF-closed host HUNG").toBe(false);
      expect(Array.from(res.stdout)).toEqual(Array.from(requestFrame));
    });
  });
});
