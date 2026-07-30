#!/usr/bin/env -S node --experimental-strip-types
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1203 — Differential testing harness.
//
// Compares js2wasm output against the V8 reference engine on a corpus of
// JavaScript programs. The premise: test262 measures spec compliance. This
// measures whether real-world programs that compile produce the SAME observable
// output as a reference engine.
//
// Architecture:
//   Lane A (V8 reference): `node <program.js>` via spawnSync, capture stdout
//   Lane B (js2wasm):       compile in-process via `compile()`, instantiate via
//                           `buildImports`/`instantiateWasm` against a monkey-
//                           patched `console.log` that buffers output
//
// Why not wasmtime: the `--target wasi` codegen has a known type-mismatch in
// `__wasi_write_i32` that prevents non-trivial programs from running through
// wasmtime today. The Node-host lane exercises the primary codegen target
// (WasmGC + wasm:js-string + JS host imports) and gives signal on the path
// most users will hit. wasmtime/SpiderMonkey lanes are documented follow-ups.
//
// Output: `benchmarks/results/diff-test.json` — per-file results.
// Triage:  `scripts/diff-triage.ts` — buckets mismatches by category.
//
// CI gate: `.github/workflows/diff-test.yml` — delta gate (no new mismatches).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compile } from "../src/index.ts";
import { buildImports, instantiateWasm } from "../src/runtime.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const CORPUS_DIR = resolve(ROOT, "tests/differential/corpus");

// #1941 — optimize lane. When DIFF_TEST_OPTIMIZE=1, every corpus program is
// compiled with `{ optimize: true }` (Binaryen wasm-opt post-pass) and its
// output is compared against the SAME V8 oracle. This catches wasm-opt
// miscompiles, which no other gate executed before. The lane writes to a
// separate report + baseline so the optimize delta is gated independently.
const OPTIMIZE = process.env.DIFF_TEST_OPTIMIZE === "1";
const OUTPUT_PATH = resolve(
  ROOT,
  OPTIMIZE ? "benchmarks/results/diff-test-optimize.json" : "benchmarks/results/diff-test.json",
);

interface FileResult {
  /** Relative path inside the corpus dir, e.g. "numeric/add.js" */
  file: string;
  /** Top-level category folder, e.g. "numeric" */
  category: string;
  /** stdout from `node <file>` */
  v8_stdout: string;
  /** stdout from compiled .wasm (captured via monkey-patched console) */
  js2wasm_stdout: string;
  /** Whether outputs match after normalisation */
  match: boolean;
  /** Compile-error or runtime-error message (only set on `error` outcome) */
  error?: string;
  /** Outcome bucket */
  outcome: "match" | "mismatch" | "compile_error" | "runtime_error" | "v8_error" | "malformed_wasm";
  /** Wall-clock millis spent on each lane (for triage) */
  ms_v8: number;
  ms_js2wasm: number;
}

interface Summary {
  total: number;
  match: number;
  mismatch: number;
  compile_error: number;
  runtime_error: number;
  v8_error: number;
  /** #2143 — compiler reported success but WebAssembly.validate rejected the binary. */
  malformed_wasm: number;
  /** Mismatches bucketed by top-level category */
  by_category: Record<string, { total: number; match: number; mismatch: number; error: number }>;
  /** Wall-clock seconds */
  duration_s: number;
  /** Per-file results */
  results: FileResult[];
}

// #2787 — strip ANSI SGR escape sequences (e.g. `\x1b[33m…\x1b[39m`) before
// comparing. Node's `console.log` colourises primitives (numbers yellow, etc.)
// when `FORCE_COLOR` is set in the environment — which it is in some dev
// containers (this repo's devcontainer exports `FORCE_COLOR=3`). The js2wasm
// lane buffers plain strings and never colourises, so an un-stripped reference
// spuriously mismatches on virtually every numeric/string program (69 false
// mismatches locally vs 14 real ones in CI, where FORCE_COLOR is unset). The
// reference lane (`runV8`) also forces colour OFF in its env; this strip is
// belt-and-suspenders so the harness is robust regardless of the ambient env.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters by definition.
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** Normalize stdout for comparison. Strips ANSI colour codes + trailing whitespace per line. */
function normalize(s: string): string {
  return s
    .replace(ANSI_SGR, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** Compare two normalized outputs. Currently exact match; future: float tolerance. */
function outputsMatch(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** Recursively collect `.js` files under `dir`, sorted by relative path. */
function collectCorpusFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      const full = resolve(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".js")) out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

/** Run a JS file under Node and return its stdout (lane A — V8 reference). */
function runV8(file: string): { stdout: string; error?: string; ms: number } {
  const t0 = Date.now();
  try {
    const stdout = execFileSync(process.execPath, [file], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      // #2787 — force colour OFF for the reference lane so `console.log` never
      // emits ANSI SGR codes (the dev container sets FORCE_COLOR=3, which makes
      // Node colourise even when stdout is piped). `FORCE_COLOR=0` overrides the
      // ambient value; `NO_COLOR` is a secondary guard. Without this the
      // reference output is polluted with `\x1b[33m…\x1b[39m` and mismatches the
      // plain js2wasm lane on nearly every numeric/string program.
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    return { stdout, ms: Date.now() - t0 };
  } catch (e: unknown) {
    const ms = Date.now() - t0;
    const err = e as { stderr?: string; message?: string };
    return { stdout: "", error: err.stderr ?? err.message ?? String(e), ms };
  }
}

/**
 * #2787 — Let the microtask + macrotask job queue drain so that asynchronous
 * `console.log` side-effects (Promise `.then`, `async`/`await`) fire while the
 * capture is still installed. Each `setTimeout(0)` boundary flushes the entire
 * microtask queue that precedes it; a small loop lets promise chains that
 * re-schedule (`.then().then()`, sequential `await`s) fully settle. Bounded so a
 * pathological unresolved chain can't hang the harness — the V8 lane has its own
 * 5s process timeout, and the corpus promise programs settle in ≤3 ticks.
 */
async function drainAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((res) => setTimeout(res, 0));
  }
}

/**
 * Compile a JS file with js2wasm, instantiate, capture console.log output.
 * Exported so the scoped regression test (tests/issue-2787.test.ts) can assert
 * that asynchronous side-effects are captured (the #2787 drain).
 */
export async function runJs2wasm(file: string): Promise<{
  stdout: string;
  error?: string;
  ms: number;
  outcome: "match" | "compile_error" | "runtime_error" | "malformed_wasm";
}> {
  const t0 = Date.now();
  let source: string;
  try {
    source = readFileSync(file, "utf-8");
  } catch (e: unknown) {
    return { stdout: "", error: `read failed: ${(e as Error).message}`, ms: Date.now() - t0, outcome: "runtime_error" };
  }
  // (#2796) `deferTopLevelInit` makes the compiler export `__module_init` and
  // skip the wasm `start` section, so the HOST lane runs top-level code AFTER
  // `setInstance` wires `__struct_field_names` / `__sget_*`. Without this the
  // host lane ran top-level enumeration (`for…in` / `Object.keys` over a
  // runtime-shaped object) during `WebAssembly.instantiate`, before any export
  // was reachable — so a top-level `for…in` enumerated zero keys, a HARNESS
  // exports-timing artifact (the standalone lane never hits it, since it runs
  // top-level code via an explicitly-called `_start` export post-instantiate).
  const r = await compile(
    source,
    OPTIMIZE
      ? { fileName: file, optimize: true, deferTopLevelInit: true }
      : { fileName: file, deferTopLevelInit: true },
  );
  if (!r.success) {
    return {
      stdout: "",
      error: `compile: ${r.errors[0]?.message ?? "unknown"}`,
      ms: Date.now() - t0,
      outcome: "compile_error",
    };
  }
  // #2143 — validate the compiled binary BEFORE instantiating. Previously a
  // malformed binary (compiler reported success but the engine rejects it)
  // surfaced only as a `runtime_error` at instantiate time, indistinguishable
  // from a genuine trap and only when this program happened to be executed.
  // Classify it as a distinct `malformed_wasm` outcome so the gate buckets it
  // as a hard-error-stability signal (#1853) rather than burying it in runtime
  // noise. Both lanes (default + `-O3`) run this — the optimizer already
  // validates its own output (optimize.ts), but the DEFAULT pipeline did not.
  if (!WebAssembly.validate(r.binary)) {
    return {
      stdout: "",
      error: `malformed_wasm: js2wasm reported success but WebAssembly.validate rejected the ${OPTIMIZE ? "-O3" : "default-pipeline"} binary`,
      ms: Date.now() - t0,
      outcome: "malformed_wasm",
    };
  }
  // Monkey-patch console.log so we capture the side effects of top-level code
  // execution. With `deferTopLevelInit` (#2796) the compiled top-level
  // statements are NOT invoked by the wasm `start` section during
  // instantiation; the harness calls the exported `__module_init()` explicitly
  // AFTER `setInstance`, so struct-introspection exports are wired when top-level
  // code runs (symmetric with the standalone `_start` model).
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fmt = (a: any) => (typeof a === "object" ? JSON.stringify(a) : String(a));
  console.log = (...args: unknown[]) => lines.push(args.map(fmt).join(" "));
  // Suppress console.error so library noise doesn't pollute stderr; tests that
  // intentionally use console.error are out of scope for this harness.
  console.error = () => {};
  try {
    const built = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    // (#2796) Run the deferred top-level code now that `setInstance` has wired
    // the struct-introspection exports. A program with NO top-level statements
    // emits no `__module_init` export, so this is a no-op for those.
    const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
    if (typeof moduleInit === "function") (moduleInit as () => void)();
    // #2787 — Drain asynchronous side-effects BEFORE restoring console.log.
    // Top-level code may schedule callbacks (`Promise.resolve().then(...)`,
    // `async`/`await`) that invoke the host `console.log` import *after*
    // `__module_init()` returns. Without draining the job queue inside the
    // capture window, those late writes fire once console.log has already been
    // restored — so they leak to the real stdout (the "42"/"4"/"30" pollution)
    // AND the program spuriously records EMPTY output (a false `mismatch`). V8
    // runs the full job queue before the process exits, so the js2wasm lane
    // must too. A `setTimeout(0)` boundary flushes the entire preceding
    // microtask queue; looping a few ticks lets promise chains that re-schedule
    // settle.
    await drainAsync();
  } catch (e: unknown) {
    console.log = origLog;
    console.error = origError;
    return {
      stdout: lines.join("\n"),
      error: `runtime: ${(e as Error).message ?? String(e)}`,
      ms: Date.now() - t0,
      outcome: "runtime_error",
    };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { stdout: lines.join("\n"), ms: Date.now() - t0, outcome: "match" };
}

/** Run one file end-to-end and produce a result. */
async function runOne(corpusFile: string): Promise<FileResult> {
  const rel = relative(CORPUS_DIR, corpusFile).replaceAll("\\", "/");
  const category = rel.split("/")[0] ?? "uncategorized";

  const v8 = runV8(corpusFile);
  if (v8.error) {
    return {
      file: rel,
      category,
      v8_stdout: "",
      js2wasm_stdout: "",
      match: false,
      outcome: "v8_error",
      error: v8.error.slice(0, 500),
      ms_v8: v8.ms,
      ms_js2wasm: 0,
    };
  }

  const js = await runJs2wasm(corpusFile);
  if (js.outcome !== "match") {
    return {
      file: rel,
      category,
      v8_stdout: v8.stdout,
      js2wasm_stdout: js.stdout,
      match: false,
      outcome: js.outcome,
      error: js.error?.slice(0, 500),
      ms_v8: v8.ms,
      ms_js2wasm: js.ms,
    };
  }
  const match = outputsMatch(v8.stdout, js.stdout);
  return {
    file: rel,
    category,
    v8_stdout: v8.stdout,
    js2wasm_stdout: js.stdout,
    match,
    outcome: match ? "match" : "mismatch",
    ms_v8: v8.ms,
    ms_js2wasm: js.ms,
  };
}

async function main(): Promise<void> {
  const startMs = Date.now();
  const files = collectCorpusFiles(CORPUS_DIR);
  if (files.length === 0) {
    console.error(`No corpus files found in ${CORPUS_DIR}. Aborting.`);
    process.exit(2);
  }
  console.log(
    `Differential test${OPTIMIZE ? " [optimize lane: -O3]" : ""}: ${files.length} programs in ${relative(ROOT, CORPUS_DIR)}`,
  );

  const results: FileResult[] = [];
  // Serial execution; the harness completes well under the 10-minute budget
  // (~50 ms each in microbench) and parallelism complicates the
  // monkey-patched console.log trick.
  for (let i = 0; i < files.length; i++) {
    const r = await runOne(files[i]!);
    results.push(r);
    const sym = r.outcome === "match" ? "✓" : r.outcome === "mismatch" ? "✗" : "!";
    if (i % 20 === 0 || i === files.length - 1 || r.outcome !== "match") {
      const pct = Math.round(((i + 1) / files.length) * 100);
      const tag = r.outcome === "match" ? "" : `  [${r.outcome}]`;
      console.log(`  ${sym} ${pct.toString().padStart(3)}%  ${r.file}${tag}`);
    }
  }

  const summary: Summary = {
    total: results.length,
    match: 0,
    mismatch: 0,
    compile_error: 0,
    runtime_error: 0,
    v8_error: 0,
    malformed_wasm: 0,
    by_category: {},
    duration_s: 0,
    results,
  };
  for (const r of results) {
    summary[r.outcome]++;
    const c = r.category;
    summary.by_category[c] ??= { total: 0, match: 0, mismatch: 0, error: 0 };
    summary.by_category[c].total++;
    if (r.outcome === "match") summary.by_category[c].match++;
    else if (r.outcome === "mismatch") summary.by_category[c].mismatch++;
    else summary.by_category[c].error++;
  }
  summary.duration_s = (Date.now() - startMs) / 1000;

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(summary, null, 2));

  // Console summary
  const matchPct = ((summary.match / summary.total) * 100).toFixed(1);
  console.log("");
  console.log(`Differential test: ${summary.total} programs (${summary.duration_s.toFixed(1)}s)`);
  console.log(`  Match:           ${summary.match.toString().padStart(4)}  (${matchPct}%)`);
  console.log(`  Mismatch:        ${summary.mismatch.toString().padStart(4)}`);
  console.log(`  Compile error:   ${summary.compile_error.toString().padStart(4)}`);
  console.log(`  Runtime error:   ${summary.runtime_error.toString().padStart(4)}`);
  console.log(`  Malformed wasm:  ${summary.malformed_wasm.toString().padStart(4)}`);
  console.log(`  V8 error:        ${summary.v8_error.toString().padStart(4)}`);
  console.log("");
  console.log("By category:");
  for (const [c, s] of Object.entries(summary.by_category).sort()) {
    const pct = ((s.match / s.total) * 100).toFixed(0);
    console.log(`  ${c.padEnd(12)}  ${s.match.toString().padStart(3)}/${s.total.toString().padEnd(3)} match (${pct}%)`);
  }
  console.log("");
  console.log(`Wrote ${relative(ROOT, OUTPUT_PATH)}`);

  // Exit non-zero if any non-match outcome — useful for local dev.
  // CI uses the dedicated delta-gate workflow which compares against the baseline.
  process.exit(summary.match === summary.total ? 0 : 1);
}

// Only run the full corpus when invoked as a script (not when imported by the
// scoped regression test, which imports `runJs2wasm` directly).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(2);
  });
}
