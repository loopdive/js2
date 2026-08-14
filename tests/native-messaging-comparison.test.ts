// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2683 — 5-way Native Messaging comparison harness.
 *
 * `examples/native-messaging/` carries the SAME Native Messaging echo host (read
 * a 4-byte little-endian length prefix + body off fd 0, write the framed response
 * to fd 1) implemented against several host surfaces, so they can be compared:
 *
 *   - `nm_js2wasm_wasi_p1.ts`         RAW `wasi_snapshot_preview1` fd_read/fd_write + linear
 *                          memory (`wasm:memory`)                              (#2657)
 *   - `nm_js2wasm_node_fs.ts`      synchronous `node:fs` readSync/writeSync(fd, …)     (#2655)
 *   - `nm_js2wasm_node_process.ts` async `process.stdin` Readable + process.stdout.write (#2683/#2632)
 *   - `nm_js2wasm_deno.ts`         the Deno stdio surface (lands separately)
 *   - `nm_js2wasm_wasi_p3.ts`      the WASI Preview 3 spike (lands separately)
 *
 * Despite the different host APIs, every variant speaks the IDENTICAL wire
 * protocol, so a single framed request must come back BYTE-IDENTICAL from each.
 * This harness pins exactly that:
 *
 *   1. Every discovered `nm_*.ts` variant compiles + validates under `--target wasi`.
 *   2. Every variant that lowers to a standalone WASI command module (imports a
 *      subset of `wasi_snapshot_preview1` / `env`) echoes a shared frame
 *      BYTE-IDENTICALLY. Synchronous variants run in-process under a raw fd shim
 *      (CI-safe, no external runtime); reactor-driven async variants (e.g.
 *      `nm_js2wasm_node_process.ts`, whose `process.stdin` needs the event loop) run under
 *      real `wasmtime` when it is on PATH.
 *
 * It is written DEFENSIVELY so the later variants are picked up with no edits:
 * variant files are DISCOVERED on disk, a variant that does not lower to a
 * wasmtime-runnable command module (e.g. the P3 component spike, which needs its
 * own runner) is skipped gracefully, and the real-runtime path gates on
 * `findWasmtime()`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile, compileProject, entryHasRelativeImports } from "../src/index.js";

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

const NM_DIR = join(__dirname, "..", "examples", "native-messaging");

/**
 * The host-surface variants present on disk (any `nm_<surface>.ts`), sorted.
 * `nm_js2wasm_sync_framing.ts` is the SHARED host-independent framing core (#2778), not a
 * host variant — it has no entry/`main` and never does fd IO itself — so it is
 * excluded from the variant matrix (the host adapters that import it are tested).
 */
function discoverVariants(): string[] {
  return readdirSync(NM_DIR)
    .filter((f) => /^nm_.*\.ts$/.test(f) && f !== "nm_js2wasm_sync_framing.ts")
    .sort();
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

// A variant lowers to a standalone WASI command module — runnable directly — iff
// it imports nothing beyond the WASI core module and `env`. A variant that needs
// another interface (e.g. a WASI Preview 3 component) is excluded and skipped.
const WASMTIME_RUNNABLE_MODULES = new Set(["wasi_snapshot_preview1", "env"]);
function isStandaloneWasi(imports: Set<string>): boolean {
  for (const m of imports) if (!WASMTIME_RUNNABLE_MODULES.has(m)) return false;
  return true;
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
    if (p + len > stream.length) break; // truncated tail — stop
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

// The browser per-host->extension-message cap every host re-chunks to stay under.
const FRAME_CAP_1MIB = 1024 * 1024;

/**
 * Assert one host's re-chunked echo (#2814): every emitted frame is a valid `[…]`
 * within the 1 MiB browser cap, and concatenating the frame interiors (re-inserting
 * one comma between consecutive frames) reconstructs the original array body.
 */
function assertRechunkRoundTrip(file: string, body: Buffer, out: Uint8Array): void {
  const frames = parseFrames(out);
  expect(frames.length, `${file}: expected at least one response frame`).toBeGreaterThanOrEqual(1);
  const parts: Buffer[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    expect(f.length, `${file}: frame must be <= 1 MiB (browser cap)`).toBeLessThanOrEqual(FRAME_CAP_1MIB);
    expect(f[0], `${file}: frame must open with '['`).toBe(0x5b);
    expect(f[f.length - 1], `${file}: frame must close with ']'`).toBe(0x5d);
    if (i > 0) parts.push(Buffer.from([0x2c])); // ,
    parts.push(Buffer.from(f.subarray(1, f.length - 1)));
  }
  const recon = Buffer.concat([Buffer.from([0x5b]), Buffer.concat(parts), Buffer.from([0x5d])]);
  expect(recon.length, `${file}: reconstructed body length`).toBe(body.length);
  expect(Buffer.compare(recon, body), `${file}: reassembled array must equal the input`).toBe(0);
}

async function compileVariant(file: string): Promise<Awaited<ReturnType<typeof compile>>> {
  const path = join(NM_DIR, file);
  const src = readFileSync(path, "utf-8");
  // Mirror the CLI's routing (#2771): an entry that statically imports a RELATIVE
  // module (e.g. nm_js2wasm_deno / nm_js2wasm_node_fs → `./nm_js2wasm_sync_framing`) must go through the
  // multi-file bundler so the shared core is pulled in and `node:fs` / raw-WASI
  // lowering runs module-wide. Entries with no relative import (nm_js2wasm_wasi_p1 /
  // nm_js2wasm_node_process / nm_js2wasm_wasi_p3) stay on the single-source path — byte-identical.
  return entryHasRelativeImports(src)
    ? compileProject(path, { target: "wasi", skipSemanticDiagnostics: true })
    : compile(src, { fileName: file, target: "wasi", skipSemanticDiagnostics: true });
}

/**
 * Run a synchronous standalone-WASI module under an in-process fd shim: fd 0 is
 * fed `stdin`, fd 1 is captured as raw bytes, fd 2 (stderr diagnostics) is
 * dropped. Only valid for variants that do NOT need the event-loop reactor — a
 * one-shot `_start` call drives the whole synchronous read/echo loop.
 */
async function runFdShim(binary: Uint8Array, stdin: Uint8Array): Promise<Uint8Array> {
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
        const n = Math.min(len, stdin.length - inPos);
        for (let j = 0; j < n; j++) mem[buf + j] = stdin[inPos + j]!;
        inPos += n;
        total += n;
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const v = dv();
      const mem = new Uint8Array(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        // Only fd 1 is the protocol stream; fd 2 carries debug telemetry.
        if (fd === 1) for (let j = 0; j < len; j++) out.push(mem[buf + j]!);
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

/**
 * A variant lowers to a runnable standalone WASI command module when the compile
 * succeeds, the binary validates, AND it imports nothing beyond the WASI core
 * module / `env`. SOURCE-REFERENCE arms (e.g. `nm_js2wasm_wasi_p3.ts`, which awaits the
 * P3 component producer and currently requests a deferred `env.readViaStream`
 * host import → an invalid standalone binary) are excluded here and gated out of
 * the run.
 */
function isRunnableStandalone(r: Awaited<ReturnType<typeof compile>>): boolean {
  if (!r.success || !r.binary || !WebAssembly.validate(r.binary)) return false;
  const imports = importModules(r.wat!);
  // #2696 — a runnable NM host MUST import `wasi_snapshot_preview1` (it does fd
  // 0/1 IO). The WASI Preview-3 source-reference arm `nm_js2wasm_wasi_p3.ts` imports only
  // `env` P3-component placeholder stubs and never touches a fd, so it is NOT a
  // runnable command module even though its standalone binary now VALIDATES (the
  // #2696 bug-3 coercion fix removed the invalid `__str_to_number` Wasm that
  // previously made it fail `WebAssembly.validate`, which is what used to gate it
  // out). Requiring the WASI core import keeps it — and any future component-only
  // arm — excluded principally, without hard-coding a filename.
  if (!imports.has("wasi_snapshot_preview1")) return false;
  return isStandaloneWasi(imports);
}

describe("#2683 Native Messaging comparison harness — every variant compiles", () => {
  const variants = discoverVariants();

  it("discovers the baseline variants on disk", () => {
    // The two landed variants plus this PR's node:process variant must be present;
    // later variants (nm_js2wasm_deno.ts, nm_js2wasm_wasi_p3.ts) are picked up automatically.
    expect(variants).toContain("nm_js2wasm_wasi_p1.ts");
    expect(variants).toContain("nm_js2wasm_node_fs.ts");
    expect(variants).toContain("nm_js2wasm_node_process.ts");
  });

  // The three runnable baselines MUST lower to a valid standalone WASI module.
  for (const file of ["nm_js2wasm_wasi_p1.ts", "nm_js2wasm_node_fs.ts", "nm_js2wasm_node_process.ts"]) {
    it(`${file} compiles to a runnable standalone WASI module`, async () => {
      const r = await compileVariant(file);
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      expect(WebAssembly.validate(r.binary!), `${file} binary must validate`).toBe(true);
      expect(isStandaloneWasi(importModules(r.wat!)), `${file} must import only WASI core / env`).toBe(true);
    });
  }

  // Every OTHER discovered variant must at least compile without throwing. It is
  // allowed to be a SOURCE-REFERENCE arm that does not yet produce a runnable
  // standalone binary (e.g. the WASI P3 component variant) — the byte-identical
  // test gates those out — but the compiler must not crash on it.
  for (const file of variants.filter(
    (f) => !["nm_js2wasm_wasi_p1.ts", "nm_js2wasm_node_fs.ts", "nm_js2wasm_node_process.ts"].includes(f),
  )) {
    it(`${file} compiles under --target wasi (runnable or source-reference)`, async () => {
      const r = await compileVariant(file);
      expect(r, `${file} produced no compile result`).toBeDefined();
      if (!isRunnableStandalone(r)) {
        // A source-reference arm — fine; just record it for visibility.
        console.log(`[nm-comparison] ${file} is a source-reference arm (not yet a runnable standalone module)`);
      }
    });
  }
});

describe("#2683 Native Messaging comparison harness — byte-identical framed echo", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nm-comparison-"));
  });
  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function runWasmtime(binary: Uint8Array, name: string, input: Uint8Array): Uint8Array {
    const path = join(tmpDir, `${name}.wasm`);
    writeFileSync(path, binary);
    const out = execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, path], {
      input: Buffer.from(input),
      stdio: ["pipe", "pipe", "ignore"], // drop fd 2 diagnostics
      maxBuffer: 1 << 26,
    });
    return Uint8Array.from(out);
  }

  // A small, pure-ASCII JSON body — the canonical Native Messaging payload shape.
  // Every variant must echo the WHOLE frame (4-byte LE prefix + body) verbatim.
  const requestBody = new TextEncoder().encode('["hello",null,42]');
  const requestFrame = frame(requestBody);

  it("every standalone-WASI variant echoes the same frame byte-for-byte", async () => {
    const ran: { file: string; out: number[]; via: string }[] = [];
    const skipped: { file: string; why: string }[] = [];

    for (const file of discoverVariants()) {
      const r = await compileVariant(file);

      if (!isRunnableStandalone(r)) {
        // A SOURCE-REFERENCE arm that does not (yet) lower to a valid standalone
        // WASI command module — e.g. the WASI Preview 3 component variant, which
        // needs its own runner. Skip gracefully; it is picked up automatically
        // once it produces a runnable binary.
        const imports = r.wat ? [...importModules(r.wat)].join(",") : "<no wat>";
        skipped.push({ file, why: `not a runnable standalone module (imports: ${imports})` });
        continue;
      }

      const needsReactor = r.wat!.includes("$__run_event_loop");
      const name = file.replace(/\.ts$/, "");
      if (needsReactor) {
        // Async/event-driven (e.g. process.stdin): the read loop runs in the
        // event loop, which the in-process fd shim does not drive — needs a real
        // runtime. Run under wasmtime when available, otherwise skip gracefully.
        if (!wasmtimeBin) {
          skipped.push({ file, why: "reactor-driven; wasmtime not on PATH" });
          continue;
        }
        ran.push({ file, out: Array.from(runWasmtime(r.binary!, name, requestFrame)), via: "wasmtime" });
      } else if (wasmtimeBin) {
        ran.push({ file, out: Array.from(runWasmtime(r.binary!, name, requestFrame)), via: "wasmtime" });
      } else {
        ran.push({ file, out: Array.from(await runFdShim(r.binary!, requestFrame)), via: "fd-shim" });
      }
    }

    // At least the two synchronous baseline variants always run (they need no
    // external runtime), so the comparison is meaningful even without wasmtime.
    expect(ran.length, `too few runnable variants (skipped: ${JSON.stringify(skipped)})`).toBeGreaterThanOrEqual(2);

    // Every variant's stdout is a byte-identical echo of the request frame —
    // which transitively makes all variants byte-identical to one another.
    for (const { file, out, via } of ran) {
      expect(out, `${file} (via ${via}) did not echo the frame byte-identically`).toEqual(Array.from(requestFrame));
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #2696 — loopdive/js2wasm#389 reporter payload regression suite.
//
// guest271314 ran these hosts (npm `@loopdive/js2` + `bun build`) and hit three
// compile bugs: (1) `wasm:memory` store32/load32/store8/load8 leaked as dropped
// `env.*` host imports (nm_js2wasm_wasi_p1.ts); (2) node:fs/node:process flags + the #2632
// stdin-reactor / `String.fromCharCode` leaked `env.__wasiStdin*` / `env.global_
// String` (nm_js2wasm_node_process.ts); (3) a stale late-import funcIdx mis-called
// `__str_to_number` with an f64, producing invalid Wasm (nm_js2wasm_wasi_p3.ts). After
// the fixes, pin the reporter's exact payloads:
//
//   • the import section of every WORKING variant is EXACTLY {wasi_snapshot_
//     preview1} — ZERO `env.*` leaks (this is the bug-1 + bug-2 gate; it runs
//     WITHOUT any external runtime, so it always executes in CI).
//   • each framed request echoes back byte-for-byte; an empty "" frame (declared
//     length 0) is the protocol's clean-shutdown signal → no echo. (Runs under
//     real wasmtime when on PATH; synchronous variants also run in-process under
//     the fd shim, so the small-payload echo executes even without wasmtime.)
//   • nm_js2wasm_wasi_p3.ts stays skipped — the P3 async component backend is not done
//     (#2658); it MUST NOT gate CI.
// ────────────────────────────────────────────────────────────────────────────
describe("#2696 — Native Messaging #389 reporter payloads", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nm-389-"));
  });
  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // Compile each variant at most once (vitest re-runs `it` bodies serially).
  const compileCache = new Map<string, Awaited<ReturnType<typeof compile>>>();
  async function getCompiled(file: string): Promise<Awaited<ReturnType<typeof compile>>> {
    let r = compileCache.get(file);
    if (!r) {
      r = await compileVariant(file);
      compileCache.set(file, r);
    }
    return r;
  }

  function runUnderWasmtime(binary: Uint8Array, name: string, input: Uint8Array): Uint8Array {
    const path = join(tmpDir, `${name}.wasm`);
    writeFileSync(path, binary);
    const out = execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, path], {
      input: Buffer.from(input),
      stdio: ["pipe", "pipe", "ignore"], // drop fd 2 diagnostics
      maxBuffer: 1 << 27,
    });
    return Uint8Array.from(out);
  }

  // Echo one framed input through a compiled variant, choosing the driver:
  //   - reactor-driven variants (process.stdin event loop, marked by
  //     `$__run_event_loop`) require REAL wasmtime — return null (graceful skip)
  //     when it is not on PATH.
  //   - pure-synchronous variants run under real wasmtime when available, else
  //     in-process under the fd shim, so their echo executes even in a
  //     wasmtime-less CI shard.
  async function echoOnce(
    r: Awaited<ReturnType<typeof compile>>,
    name: string,
    input: Uint8Array,
  ): Promise<Uint8Array | null> {
    const needsReactor = r.wat!.includes("$__run_event_loop");
    if (needsReactor) {
      return wasmtimeBin ? runUnderWasmtime(r.binary!, name, input) : null;
    }
    return wasmtimeBin ? runUnderWasmtime(r.binary!, name, input) : runFdShim(r.binary!, input);
  }

  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  // The reporter's small framed payloads — each must come back byte-for-byte.
  const SMALL_PAYLOADS: Record<string, Uint8Array> = {
    '"test"': enc("test"),
    "a 1-byte body": Uint8Array.of(97),
    'JSON object {"0":97}': enc('{"0":97}'),
  };

  // Every working variant present on disk. nm_js2wasm_wasi_p3.ts is intentionally absent
  // (skipped below). nm_js2wasm_deno.ts is included; it is skipped per-test if it has not
  // landed / is not a runnable standalone module.
  const WORKING = [
    "nm_js2wasm_wasi_p1.ts",
    "nm_js2wasm_node_fs.ts",
    "nm_js2wasm_deno.ts",
    "nm_js2wasm_node_process.ts",
  ];

  for (const file of WORKING) {
    describe(file, () => {
      // Bug-1 + bug-2 gate: a runnable standalone module whose import section is
      // EXACTLY {wasi_snapshot_preview1} — no `env.store32` / `env.__wasiStdin*` /
      // `env.global_String` leak. Runs with no external runtime.
      it("compiles to a standalone module importing ONLY wasi_snapshot_preview1", async () => {
        const r = await getCompiled(file);
        expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
        expect(WebAssembly.validate(r.binary!), `${file} binary must validate`).toBe(true);
        const imports = [...importModules(r.wat!)];
        expect(imports, `${file} must import ONLY wasi_snapshot_preview1 (no env.* leak)`).toEqual([
          "wasi_snapshot_preview1",
        ]);
      });

      for (const [label, body] of Object.entries(SMALL_PAYLOADS)) {
        it(`echoes ${label} byte-for-byte`, async () => {
          const r = await getCompiled(file);
          if (!isRunnableStandalone(r)) return; // unlanded/non-runnable arm — skip
          const frameIn = frame(body);
          const out = await echoOnce(r, file.replace(/\.ts$/, "-small"), frameIn);
          if (out === null) return; // reactor variant without wasmtime — skip
          expect(Array.from(out), `${file} did not echo ${label} byte-for-byte`).toEqual(Array.from(frameIn));
        });
      }

      it('treats an empty "" frame as clean shutdown (no echo)', async () => {
        const r = await getCompiled(file);
        if (!isRunnableStandalone(r)) return;
        // A 4-byte prefix declaring length 0 and no body — every variant stops.
        const out = await echoOnce(r, file.replace(/\.ts$/, "-empty"), frame(new Uint8Array(0)));
        if (out === null) return;
        expect(out.length, `${file} must not echo a zero-length (shutdown) frame`).toBe(0);
      });
    });
  }

  // The 1 MiB browser-message-cap payload. As of #2814 ALL hosts re-chunk a body
  // larger than their per-host cap, so this is asserted on re-chunk ROUND-TRIP, not
  // a byte-identical echo: a valid `[null,null,…]` array body is split into valid
  // <=1 MiB JSON frames whose interiors reassemble to the input. Restricted to the
  // SYNCHRONOUS variants (raw WASI / Deno / node:fs): the nm_js2wasm_node_process async
  // reactor rebuilds the body via per-byte `String.fromCharCode`, not CI-feasible at
  // 1 MiB (its wire protocol is covered by the matrix test + the small payloads
  // above). node_fs/deno cap at 1 MiB (a ~1 MiB body echoes as one frame); wasi_p1
  // caps at 64 KiB (its fixed 3-page memory has no memory.grow) so it splits into
  // ~64 KiB frames — both round-trip identically.
  for (const file of ["nm_js2wasm_wasi_p1.ts", "nm_js2wasm_node_fs.ts", "nm_js2wasm_deno.ts"]) {
    it(`${file} re-chunks a 1 MiB array body into valid <=1 MiB frames`, { timeout: 60_000 }, async () => {
      const r = await getCompiled(file);
      if (!isRunnableStandalone(r)) return;
      const body = jsonArrayBody(1024 * 1024);
      const out = await echoOnce(r, file.replace(/\.ts$/, "-1mib"), frame(body));
      if (out === null) return;
      assertRechunkRoundTrip(file, body, out);
    });
  }

  // A LARGE multi-MiB body. As of #2814 the raw byte-streaming variants
  // (nm_js2wasm_wasi_p1 / nm_js2wasm_deno) re-chunk too (formerly verbatim), so this is
  // asserted on re-chunk ROUND-TRIP like nm_js2wasm_node_fs: a >cap array body splits into
  // valid <=1 MiB JSON frames whose interiors reassemble to the input. The reporter
  // verified a 64 MiB body manually; 3 MiB is the CI-feasible stand-in.
  for (const file of ["nm_js2wasm_wasi_p1.ts", "nm_js2wasm_deno.ts"]) {
    it(
      `${file} re-chunks a 3 MiB array body into valid <=1 MiB frames (reporter verified 64 MiB manually)`,
      {
        timeout: 120_000,
      },
      async () => {
        const r = await getCompiled(file);
        if (!isRunnableStandalone(r)) return;
        const body = jsonArrayBody(3 * 1024 * 1024);
        const out = await echoOnce(r, file.replace(/\.ts$/, "-large"), frame(body));
        if (out === null) return;
        assertRechunkRoundTrip(file, body, out);
        // Sanity: a >cap body MUST come back as multiple frames (re-chunked, not one).
        expect(parseFrames(out).length, `${file} 3 MiB must re-chunk into multiple frames`).toBeGreaterThan(1);
      },
    );
  }

  // nm_js2wasm_wasi_p3.ts is the WASI Preview 3 async-component source-reference arm. The
  // js2wasm P3 producer backend is NOT done (async-lifted `run`, `stream<u8>` /
  // `future<T>` canonical-ABI lowering) — tracked by #2658. The #2696 bug-3 fix
  // made its standalone binary VALID Wasm (it no longer mis-calls __str_to_number),
  // but it still imports only `env` P3 placeholder stubs and does not echo, so it
  // is NOT runnable here. It MUST NOT gate CI — keep it skipped until the P3
  // backend lands.
  it.skip("nm_js2wasm_wasi_p3.ts — P3 async component backend not done (tracked by #2658)", () => {
    /* intentionally skipped — see #2658 */
  });
});
