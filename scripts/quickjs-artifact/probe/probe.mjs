#!/usr/bin/env node
/*
 * R2/R3/R4 acceptance probes for the QuickJS WASI artifact (#4236 slice 1).
 *
 * Run after scripts/quickjs-artifact/build.sh:
 *     node scripts/quickjs-artifact/probe/probe.mjs [libquickjs.wasm]
 *
 * JS appears ONLY as the instantiation harness — it hands the Memory object and
 * the export table from one wasm module to the other — and as the timer. The
 * data path (authoring source bytes, calling JS_Eval, reading properties back)
 * is entirely wasm-to-wasm.
 *
 * R2  eval "40+2" authored by the peer module            -> 42
 * R3  object identity + two-way mutation across eval     -> 411
 *     plus tag extraction, both via the wrapper and open-coded
 * R4  sizes, cross-module trampoline cost, per-op cost, eval throughput
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { instantiateArtifact } from "../wasi-stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const ART_DIR = process.env.OUT_DIR || join(REPO, ".tmp", "quickjs-artifact");
const WORK = process.env.WORK || join(REPO, ".tmp", "quickjs-artifact-build");

const artifactPath = process.argv[2] || join(ART_DIR, "libquickjs.wasm");
if (!existsSync(artifactPath)) {
  console.error(`missing ${artifactPath} — run scripts/quickjs-artifact/build.sh first`);
  process.exit(2);
}

// The peer is compiled here rather than committed as a binary: it is the
// stand-in for js2wasm-compiled code, and the LINK FLAGS are part of the point.
// --import-memory: it defines no memory, it uses QuickJS's.
const peerPath = join(WORK, "peer.wasm");
mkdirSync(WORK, { recursive: true });
execFileSync(
  process.env.CC || "clang-18",
  [
    "--target=wasm32",
    "-nostdlib",
    "-O2",
    "-resource-dir",
    join(WORK, "resource-dir"),
    "-Wl,--no-entry",
    "-Wl,--import-memory",
    "-Wl,--import-undefined",
    "-Wl,--strip-all",
    "-o",
    peerPath,
    join(HERE, "peer.c"),
  ],
  { stdio: "inherit" },
);

const qjsBytes = readFileSync(artifactPath);
const peerBytes = readFileSync(peerPath);

// The peer must touch no memory it did not allocate: no data segments, no
// shadow-stack traffic. Assert it rather than trusting the compiler.
{
  const mod = new WebAssembly.Module(peerBytes);
  const secs = WebAssembly.Module.customSections(mod, "name");
  void secs;
  // section id 11 == Data
  let i = 8,
    hasData = false;
  const dv = new DataView(peerBytes.buffer, peerBytes.byteOffset, peerBytes.byteLength);
  while (i < peerBytes.length) {
    const id = dv.getUint8(i++);
    let size = 0,
      shift = 0,
      b;
    do {
      b = dv.getUint8(i++);
      size |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    if (id === 11) hasData = true;
    i += size;
  }
  console.log(`peer data segments: ${hasData ? "PRESENT (would corrupt QuickJS's heap)" : "none  PASS"}`);
}

const { instance: qjs } = await instantiateArtifact(qjsBytes);
const Q = qjs.exports;
const peer = (await WebAssembly.instantiate(peerBytes, { env: { memory: Q.memory }, qjs: Q })).instance.exports;

const rt = peer.peer_new_runtime();
const ctx = peer.peer_new_context(rt);
console.log(`runtime=${rt} ctx=${ctx} memory=${Q.memory.buffer.byteLength / 65536} pages`);

let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${label} -> ${got} (want ${want})  ${ok ? "PASS" : "FAIL"}`);
};

// ------------------------------------------------------------------ R2 -----
check('R2 eval "40+2" driven from wasm', peer.r2_roundtrip(ctx), 42);

// ------------------------------------------------------------------ R3 -----
check("R3 identity round-trip", peer.r3_identity(ctx), 411);

const abi = JSON.parse(readFileSync(join(ART_DIR, "qjs-abi.json"), "utf8"));
check("R3 object tag via wrapper", peer.r3_object_tag(ctx), abi.tags.OBJECT);
check(
  "R3 object tag open-coded (i32.load offset=tagOffset)",
  peer.r3_open_coded_tag(ctx, abi.value.tagOffset),
  abi.tags.OBJECT,
);

{
  // Decode a float64 from the raw NaN-boxed JSValue using ONLY the extracted
  // constants — the codegen fast path for numbers.
  const p = peer.peer_alloc(16);
  const m = new Uint8Array(Q.memory.buffer);
  const s = "1.5+2.25";
  for (let i = 0; i < s.length; i++) m[p + i] = s.charCodeAt(i);
  m[p + s.length] = 0;
  const h = Q.qjs_eval(ctx, p, s.length);
  const raw = BigInt.asUintN(64, peer.peer_handle_raw(h));
  const bits = BigInt.asUintN(64, raw + (BigInt(abi.value.float64TagAddend) << 32n));
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, bits);
  check("R3 float64 decode from raw JSValue", dv.getFloat64(0), 3.75);
  Q.qjs_free_value(ctx, h);
}

// ------------------------------------------------------------------ R4 -----
const med = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
const timeIt = (fn, reps = 7) => {
  const out = [];
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    out.push(Number(process.hrtime.bigint() - t0));
  }
  return med(out);
};

const N = 20_000_000;
const zeroPtr = peer.peer_alloc(4);
new DataView(Q.memory.buffer).setInt32(zeroPtr, 0, true);
peer.bench_trampoline(1000);
peer.bench_baseline(1000, zeroPtr);
const tTramp = timeIt(() => peer.bench_trampoline(N));
const tBase = timeIt(() => peer.bench_baseline(N, zeroPtr));
console.log(
  `\nR4 trampoline: imported-call loop ${(tTramp / N).toFixed(3)} ns/iter, ` +
    `volatile-load loop ${(tBase / N).toFixed(3)} ns/iter, ` +
    `NET wasm->wasm call ${((tTramp - tBase) / N).toFixed(2)} ns`,
);

const tHostCall = timeIt(() => {
  let a = 0;
  for (let i = 0; i < N; i++) a += Q.qjs_noop();
  return a;
});
const tHostBase = timeIt(() => {
  let a = 0;
  for (let i = 0; i < N; i++) a += i & 1;
  return a;
});
console.log(`R4 JS host -> QuickJS: NET ${((tHostCall - tHostBase) / N).toFixed(2)} ns/call`);

{
  const obj = peer.peer_make_obj_with_x(ctx);
  const nameP = peer.peer_name_x();
  const M = 2_000_000;
  peer.bench_getprop(ctx, obj, nameP, 1000);
  const t = timeIt(() => peer.bench_getprop(ctx, obj, nameP, M), 5);
  const tH = timeIt(() => {
    let a = 0;
    for (let i = 0; i < M; i++) {
      const h = Q.qjs_get_prop_str(ctx, obj, nameP);
      a += Q.qjs_to_f64(ctx, h);
      Q.qjs_free_value(ctx, h);
    }
    return a;
  }, 5);
  console.log(
    `R4 getprop+tof64+free: wasm-driven ${(t / M).toFixed(1)} ns/iter, ` + `JS-driven ${(tH / M).toFixed(1)} ns/iter`,
  );
  peer.peer_free(ctx, obj);
}

{
  const SRC = "(function(){ var s = 0; for (var i = 0; i < 100000; i = i + 1) { s = s + i; } return s; })();";
  const p = peer.peer_alloc(SRC.length + 1);
  const m = new Uint8Array(Q.memory.buffer);
  for (let i = 0; i < SRC.length; i++) m[p + i] = SRC.charCodeAt(i);
  m[p + SRC.length] = 0;
  check("R4 eval(100k loop) value", peer.bench_eval_once(ctx, p, SRC.length), 4999950000);

  // ALTERNATE the drivers. A straight A-then-B ordering charges the first loop
  // a one-off ~2.7 ms warm-up and reads as a 1.6x difference that is not real.
  const REPS = 20,
    wasmRuns = [],
    hostRuns = [];
  for (let r = 0; r < 5; r++) {
    let t = process.hrtime.bigint();
    for (let i = 0; i < REPS; i++) peer.bench_eval_once(ctx, p, SRC.length);
    wasmRuns.push(Number(process.hrtime.bigint() - t) / 1e6 / REPS);
    t = process.hrtime.bigint();
    for (let i = 0; i < REPS; i++) Q.qjs_free_value(ctx, Q.qjs_eval(ctx, p, SRC.length));
    hostRuns.push(Number(process.hrtime.bigint() - t) / 1e6 / REPS);
  }
  const indirect = eval;
  indirect(SRC);
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < REPS; i++) indirect(SRC);
  console.log(
    `R4 eval(100k loop): wasm-driven ${med(wasmRuns).toFixed(2)} ms, ` +
      `JS-driven ${med(hostRuns).toFixed(2)} ms, ` +
      `Node/V8 ${(Number(process.hrtime.bigint() - t2) / 1e6 / REPS).toFixed(3)} ms`,
  );
}

const sz = (b) => `${b.length} raw / ${gzipSync(b, { level: 9 }).length} gzip`;
console.log(`\nSIZES libquickjs.wasm: ${sz(qjsBytes)}`);
console.log(`SIZES peer.wasm:       ${sz(peerBytes)}`);
console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
