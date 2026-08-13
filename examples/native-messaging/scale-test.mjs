// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2807 — REAL-WASMTIME scale round-trip for ALL FOUR Native-Messaging host
// variants, the reporter's exact pipeline (loopdive/js2wasm#389):
//
//   bun build <variant>.ts --target node [externals] --outfile <variant>.js
//   js2wasm <variant>.js --target wasi [--link node:fs]
//   wasmtime <variant>.wasm  < framed-input  > echoed-output
//
// As of #2814 ALL FOUR hosts RE-CHUNK: a body larger than the per-host frame cap
// is streamed back as a sequence of valid <=1 MiB JSON frames whose interiors,
// reassembled by the receiver, reproduce the input — no host echoes a single
// >1 MiB frame (the real Chrome host->extension cap). The node hosts cap at 1 MiB;
// the raw-WASI `nm_js2wasm_wasi_p1` caps at 64 KiB (its fixed 3-page linear memory
// has no memory.grow), still comfortably <= 1 MiB. The round-trip check (every
// frame body <=1 MiB; reassembled interiors == input) is identical for all four.
//
// WHY THIS EXISTS (the #2807 coverage hole): the in-process WASI shim used by
// `tests/native-messaging-matrix.test.ts` / `issue-2754-transpiled-nm-roundtrip`
// bulk-copies each `fd_write` iovec in one JS array slice, so it happily "writes"
// a 256 MiB buffer that REAL wasmtime rejects. wasmtime (v46) fails a single
// `fd_write` whose iovec length is ≥ ~128 MiB with errno 48 and `nwritten = 0`;
// the `nm_js2wasm_node_process` host (which builds the WHOLE response frame and writes it
// in ONE `process.stdout.write`) therefore echoed ZERO bytes and exited 0 at
// ≥128 MiB — invisible to the shim-based tests. This driver runs the compiled
// modules under the ACTUAL `wasmtime` binary at sizes that straddle the cap, so
// the regression cannot recur silently.
//
// It ALSO bundles with **bun** (not esbuild): bun's DEFAULT browser target
// silently stubs `node:fs` → `{}` (a false zero-output), so the variants that
// speak `node:fs` MUST be built `--target node`; `nm_js2wasm_wasi_p1` keeps its
// `wasi_snapshot_preview1` / `wasm:memory` intrinsic imports external.
//
// Requires `bun` and `wasmtime` on PATH (the native-messaging-smoke CI job
// installs both). Run: `node examples/native-messaging/scale-test.mjs`.
// Override the size sweep with `NM_SCALE_SIZES_MIB="1 128 256"`.

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NM_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(NM_DIR, "..", "..");
const MiB = 1024 * 1024;
const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,tail-call=y,exceptions=y"];

const SIZES_MIB = (process.env.NM_SCALE_SIZES_MIB ?? "1 64 128 256")
  .trim()
  .split(/\s+/)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n) && n > 0);

const WORK = mkdtempSync(join(tmpdir(), "nm-scale-"));
process.on("exit", () => {
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`\`${cmd} ${args.join(" ")}\` failed (status ${r.status}):\n${r.stderr ?? ""}${r.stdout ?? ""}`);
  }
  return r;
}

// ---- framing helpers (mirror nm_*.ts wire format) ---------------------------
function writeFrameFile(path, body) {
  const buf = Buffer.allocUnsafe(4 + body.length);
  buf.writeUInt32LE(body.length, 0);
  body.copy(buf, 4);
  writeFileSync(path, buf);
}

// Deterministic non-ASCII byte pattern (covers high + null bytes — a string
// re-encode would corrupt these, so a byte-exact echo proves the raw path).
function patternBody(bytes) {
  const b = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i++) b[i] = (i * 7 + 3) & 0xff;
  return b;
}

// A valid JSON-array body `[null,null,…]` of ~`approx` bytes (the #389 payload
// shape the nm_js2wasm_node_fs re-chunker splits on).
function jsonArrayBody(approx) {
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

function parseFrames(stream) {
  const frames = [];
  let p = 0;
  while (p + 4 <= stream.length) {
    const len = stream[p] + stream[p + 1] * 256 + stream[p + 2] * 65536 + stream[p + 3] * 16777216;
    p += 4;
    if (p + len > stream.length) break;
    frames.push(stream.subarray(p, p + len));
    p += len;
  }
  return frames;
}

// ---- wasmtime invocation with file-backed stdio (no JS-side buffering) -------
function runWasmtime({ wasm, preload, inPath, outPath }) {
  const args = [...WASMTIME_FLAGS];
  if (preload) args.push("--preload", preload);
  args.push(wasm);
  const inFd = openSync(inPath, "r");
  const outFd = openSync(outPath, "w");
  try {
    const r = spawnSync("wasmtime", args, { stdio: [inFd, outFd, "pipe"], encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`wasmtime exited ${r.status}\n${r.stderr ?? ""}`);
    }
    return r.stderr ?? "";
  } finally {
    closeSync(inFd);
    closeSync(outFd);
  }
}

// ---- per-variant build (bun bundle → js2wasm) -------------------------------
const CLI = join(WORK, "js2wasm-cli.mjs");
const SHIM = join(WORK, "node-fs.wasm");

function buildToolchain() {
  run("node", ["scripts/build-standalone-cli.mjs", "--outfile", CLI], { cwd: REPO_ROOT });
  run("node", ["scripts/build-node-fs-shim.mjs", SHIM], { cwd: REPO_ROOT });
}

function bunBundle(srcTs, outJs, extraArgs) {
  run("bun", ["build", join(NM_DIR, srcTs), "--target", "node", ...extraArgs, "--outfile", outJs], { cwd: REPO_ROOT });
}

function js2wasm(jsFile, extraArgs) {
  run("node", [CLI, jsFile, "--target", "wasi", ...extraArgs, "-o", WORK, "--quiet"], { cwd: REPO_ROOT });
}

// Each variant: build once, then echo-test across the size sweep.
const VARIANTS = [
  {
    name: "nm_js2wasm_node_process",
    src: "nm_js2wasm_node_process.ts",
    bunExtra: [],
    js2wasmExtra: [],
    preload: null,
    // Re-chunks bodies > 1 MiB into valid <=1 MiB JSON frames on the WRITE side
    // (#2810) — formerly THE #2807 variant that built the whole frame and issued
    // one >128 MiB fd_write; now bounded like nm_js2wasm_node_fs.
    mode: "rechunk",
  },
  {
    name: "nm_js2wasm_deno",
    src: "nm_js2wasm_deno.ts",
    bunExtra: [],
    js2wasmExtra: [],
    preload: null,
    // Re-chunks bodies > 1 MiB into valid <=1 MiB JSON frames via the shared
    // nm_js2wasm_sync_framing core (#2814) — formerly a verbatim echo.
    mode: "rechunk",
  },
  {
    name: "nm_js2wasm_wasi_p1",
    src: "nm_js2wasm_wasi_p1.ts",
    bunExtra: ["--external", "wasi_snapshot_preview1", "--external", "wasm:memory"],
    js2wasmExtra: [],
    preload: null,
    // Re-chunks bodies > its 64 KiB linear-memory cap into valid <=1 MiB JSON
    // frames in raw linear memory (#2814) — formerly a verbatim echo. The raw-WASI
    // module owns a fixed 3-page memory (no memory.grow), so its cap is 64 KiB,
    // comfortably <= the 1 MiB browser limit the round-trip check asserts.
    mode: "rechunk",
  },
  {
    name: "nm_js2wasm_node_fs",
    src: "nm_js2wasm_node_fs.ts",
    bunExtra: [],
    js2wasmExtra: ["--link", "node:fs"],
    preload: () => `node:fs=${SHIM}`,
    mode: "rechunk",
  },
];

function buildVariant(v) {
  const js = join(WORK, `${v.name}.js`);
  bunBundle(v.src, js, v.bunExtra);
  js2wasm(js, v.js2wasmExtra);
  // #2816 stripped the source extension from CLI output names, so compiling
  // `<name>.js -o WORK` now writes `<name>.wasm`, not `<name>.js.wasm`.
  const wasm = join(WORK, `${v.name}.wasm`);
  if (!statSync(wasm, { throwIfNoEntry: false })) throw new Error(`${wasm} not produced`);
  return wasm;
}

function checkVerbatim(v, wasm, sizeMiB) {
  const body = patternBody(sizeMiB * MiB);
  const inPath = join(WORK, "in.bin");
  const outPath = join(WORK, "out.bin");
  writeFrameFile(inPath, body);
  const stderr = runWasmtime({ wasm, preload: v.preload?.(), inPath, outPath });
  const inBuf = readFileSync(inPath);
  const outBuf = readFileSync(outPath);
  if (outBuf.length === 0) {
    throw new Error(`${v.name} @ ${sizeMiB} MiB: ZERO output (the #2807 silent fd_write failure). stderr=[${stderr}]`);
  }
  if (Buffer.compare(inBuf, outBuf) !== 0) {
    throw new Error(`${v.name} @ ${sizeMiB} MiB: echo mismatch (in=${inBuf.length} out=${outBuf.length})`);
  }
}

function checkRechunk(v, wasm, sizeMiB) {
  const body = jsonArrayBody(sizeMiB * MiB);
  const inPath = join(WORK, "in.bin");
  const outPath = join(WORK, "out.bin");
  writeFrameFile(inPath, body);
  const stderr = runWasmtime({ wasm, preload: v.preload?.(), inPath, outPath });
  const outBuf = readFileSync(outPath);
  if (outBuf.length === 0) {
    throw new Error(`${v.name} @ ${sizeMiB} MiB: ZERO output. stderr=[${stderr}]`);
  }
  // Reassemble the re-chunked array frames' interiors back into the body.
  const frames = parseFrames(outBuf);
  if (frames.length < 1) throw new Error(`${v.name} @ ${sizeMiB} MiB: no frames parsed from output`);
  const parts = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.length > MiB) throw new Error(`${v.name} @ ${sizeMiB} MiB: frame ${i} exceeds the 1 MiB cap (${f.length})`);
    if (i > 0) parts.push(Buffer.from([0x2c])); // ,
    parts.push(Buffer.from(f.subarray(1, f.length - 1))); // strip [ … ]
  }
  const recon = Buffer.concat([Buffer.from([0x5b]), Buffer.concat(parts), Buffer.from([0x5d])]);
  if (Buffer.compare(recon, body) !== 0) {
    throw new Error(`${v.name} @ ${sizeMiB} MiB: reassembled array body != input`);
  }
}

// ---- run --------------------------------------------------------------------
console.log(`== Native-Messaging real-wasmtime scale test (sizes: ${SIZES_MIB.join(", ")} MiB) ==`);
console.log(run("wasmtime", ["--version"]).stdout.trim());
console.log(`bun ${run("bun", ["--version"]).stdout.trim()}`);
buildToolchain();

let failures = 0;
for (const v of VARIANTS) {
  let wasm;
  try {
    wasm = buildVariant(v);
  } catch (e) {
    console.error(`FAIL build ${v.name}: ${e.message}`);
    failures++;
    continue;
  }
  for (const sizeMiB of SIZES_MIB) {
    const t0 = Date.now();
    try {
      if (v.mode === "verbatim") checkVerbatim(v, wasm, sizeMiB);
      else checkRechunk(v, wasm, sizeMiB);
      console.log(
        `OK   ${v.name.padEnd(16)} ${String(sizeMiB).padStart(4)} MiB  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
    } catch (e) {
      console.error(`FAIL ${v.name.padEnd(16)} ${String(sizeMiB).padStart(4)} MiB: ${e.message}`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} scale check(s) FAILED.`);
  process.exit(1);
}
console.log(
  "\nPASS: all four Native-Messaging variants re-chunk to valid <=1 MiB JSON frames under real wasmtime at every size (no host echoes a single >1 MiB frame).",
);
