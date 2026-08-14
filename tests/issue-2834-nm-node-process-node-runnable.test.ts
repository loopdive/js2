// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2834 — `nm_js2wasm_node_process` must be runnable under REAL node, not only
 * compiled to WASI.
 *
 * Run as plain JS under real `node` (the reporter's `bun build`/transpile → `.js`
 * pipeline, loopdive/js2wasm#389), the host threw:
 *
 *   TypeError: chunk.charCodeAt is not a function
 *
 * Real node delivers `process.stdin` `'data'` chunks as **`Buffer`** objects (no
 * `.charCodeAt`), but the incremental state machine reads bytes with
 * `chunk.charCodeAt(...)` — the shape the js2wasm `process.stdin` prelude delivers
 * (one-char-per-byte STRING chunks). So the very first chunk threw.
 *
 * Fix (option a): the host declares its stdin encoding —
 * `process.stdin.setEncoding("latin1")` — BEFORE subscribing. Under real node that
 * switches the stream to deliver one-char-per-byte latin1 STRING chunks, so
 * `charCodeAt` recovers the raw byte exactly as it does for the prelude's string
 * chunks. Under `--target wasi` the injected prelude's `__Js2wasmReadable` exposes
 * a faithful `setEncoding` no-op (it already materialises every chunk as a
 * one-char-per-byte string), so the SAME source compiles to Wasm unchanged — the
 * compile + byte-exact wasmtime round-trip stay covered by #2735 / #2752.
 *
 * This test runs the transpiled `.js` under the ACTUAL `node` binary, feeds it a
 * framed Native-Messaging message + an in-band zero-length shutdown frame, and
 * asserts a byte-exact echo with NO `charCodeAt` error.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

interface RunResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Spawn `node <jsPath>`, write `input` to stdin (then EOF), resolve on exit. */
function runNodeStdin(jsPath: string, input: Uint8Array, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [jsPath], { stdio: ["pipe", "pipe", "pipe"] });
    const out: number[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      for (const b of d) out.push(b);
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    child.stdin.on("error", () => {});
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ stdout: Uint8Array.from(out), stderr: err, exitCode: null, timedOut: true });
    }, timeoutMs);
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: Uint8Array.from(out), stderr: err, exitCode: code, timedOut: false });
    });
    child.stdin.write(Buffer.from(input));
    child.stdin.end();
  });
}

describe("#2834 — nm_js2wasm_node_process runs under real node (Buffer stdin chunks)", () => {
  let tmpDir: string;
  let jsPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nm-2834-"));
    // Reporter pipeline: transpile the .ts to plain .js (types stripped), run under node.
    const tsSrc = readFileSync(join(NM_DIR, "nm_js2wasm_node_process.ts"), "utf-8");
    const { code } = await esbuild.transform(tsSrc, { loader: "ts", format: "cjs" });
    jsPath = join(tmpDir, "nm_js2wasm_node_process.js");
    writeFileSync(jsPath, code);
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("declares stdin encoding so the .js source uses setEncoding (not charCodeAt-on-Buffer)", () => {
    const tsSrc = readFileSync(join(NM_DIR, "nm_js2wasm_node_process.ts"), "utf-8");
    expect(tsSrc).toContain('process.stdin.setEncoding("latin1")');
  });

  it("echoes a framed message byte-exact under real node with NO charCodeAt TypeError", async () => {
    const bodyStr = JSON.stringify({ hello: "world", n: 42, arr: [1, 2, 3] });
    const body = Buffer.from(bodyStr, "utf8");
    const shutdown = new Uint8Array(4); // zero-length frame = in-band clean shutdown
    const input = new Uint8Array(frame(body).length + shutdown.length);
    input.set(frame(body), 0);
    input.set(shutdown, frame(body).length);

    const r = await runNodeStdin(jsPath, input, 10000);

    expect(r.timedOut, "node host hung").toBe(false);
    expect(r.stderr).not.toContain("charCodeAt"); // the #2834 regression signature
    expect(r.exitCode).toBe(0);
    // One echoed frame: 4-byte prefix + the original body, byte-exact.
    expect(r.stdout.length).toBe(4 + body.length);
    const echoedLen = r.stdout[0]! + r.stdout[1]! * 256 + r.stdout[2]! * 65536 + r.stdout[3]! * 16777216;
    expect(echoedLen).toBe(body.length);
    expect(Buffer.from(r.stdout.slice(4)).toString("utf8")).toBe(bodyStr);
  });

  it("round-trips a multi-chunk (>64 KiB) body byte-exact under real node", async () => {
    // A body larger than node's default 64 KiB stdin highWaterMark arrives across
    // several Buffer 'data' chunks — exercises the cross-chunk state machine with
    // the latin1 string chunks setEncoding now delivers.
    const elems: string[] = [];
    for (let i = 0; i < 20000; i = i + 1) elems.push(String(i));
    const bodyStr = `[${elems.join(",")}]`; // ~100 KiB JSON array, still < 1 MiB cap
    const body = Buffer.from(bodyStr, "utf8");
    const shutdown = new Uint8Array(4);
    const input = new Uint8Array(frame(body).length + shutdown.length);
    input.set(frame(body), 0);
    input.set(shutdown, frame(body).length);

    const r = await runNodeStdin(jsPath, input, 15000);

    expect(r.timedOut).toBe(false);
    expect(r.stderr).not.toContain("charCodeAt");
    expect(r.exitCode).toBe(0);
    // Body is within the 1 MiB cap, so it is echoed verbatim as one frame.
    expect(r.stdout.length).toBe(4 + body.length);
    expect(Buffer.from(r.stdout.slice(4)).toString("utf8")).toBe(bodyStr);
  });
});
