#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

declare const __JS2WASM_CLI_VERSION__: string | undefined;

function getCliVersion(): string {
  const bundledVersion = typeof __JS2WASM_CLI_VERSION__ === "string" ? __JS2WASM_CLI_VERSION__ : undefined;
  if (bundledVersion) return bundledVersion;
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

const args = process.argv.slice(2);

// `--ts7` swaps the parser/checker frontend to `@typescript/native-preview`
// (TS7 Go-port preview, #1288). The decision is made by `src/ts-api.ts` at
// module-load time, so the env var MUST be set before any compiler imports
// resolve. We use a dynamic import below for that reason.
if (args.includes("--ts7")) {
  process.env.JS2WASM_TS7 = "1";
}

const { compile } = await import("./index.js");
const { buildDefaultDefines } = await import("./compiler/define-substitution.js");

if (args.includes("--version") || args.includes("-v")) {
  console.log(getCliVersion());
  process.exit(0);
}

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: js2wasm <input.ts> [options]

Compile a TypeScript file to WebAssembly (GC proposal).

Options:
  -o, --out <dir>   Output directory (default: same as input)
  --target <t>      Compilation target: gc (default), linear, wasi, standalone
  --standalone      Shorthand for --target standalone (pure WasmGC, no JS host,
                    no WASI). Forces nativeStrings: true and refuses to emit
                    wasm:js-string or env JS-host imports.
  --allocator <a>   Linear backend allocator (#1856): bump (default,
                    allocate-and-exit arena, smallest binary) or arena-reset
                    (same arena + __arena_reset/__arena_used exports for hosts
                    reusing one instance across short-lived tasks). Linear
                    target only.
  --allow-fs        Allow node:fs JS-host imports (readFileSync, writeFileSync)
                    for non-WASI targets (#1491). Off by default to prevent
                    accidental capability leakage.
  --utf8-storage    Dual i8/i16 string storage (#1588): store strings proven
                    UTF-8 (literals, JSON, decoder results, ...) as i8-backed
                    Utf8String for a cheaper Component Model boundary. Implies
                    nativeStrings on the WasmGC backend. Off by default
                    (byte-identical output when off).
  --wat             Emit only WAT (no binary)
  --no-wat          Skip WAT output
  --no-dts          Skip .d.ts output
  --wit             Generate WIT interface file for Component Model
  --wit-package <p> Package name for --wit output (ns:name[@version]).
                    Implies --wit. Defaults to js2wasm:<input-basename>.
  -O, --optimize    Run Binaryen wasm-opt optimizer (on by default at -O3)
  -O1..-O4          Set optimization level (1-4)
  --no-optimize, -O0
                    Disable the optimizer; emit raw codegen output. Optimization
                    is ON by default; this restores the pre-#1950 behaviour.
                    (No-op when binaryen/wasm-opt is unavailable — that path
                    already degrades to a one-line note, never a failure.)
  --no-host-imports Strict dual-mode: reject JS-host 'env' imports not on
                    the allowlist (#1524). Implied by --target wasi.
  --allow-host-imports
                    Escape hatch: disable strict dual-mode for a WASI build
                    (debug-only). Useful when temporarily mixing host + WASI
                    imports while migrating to standalone mode.
  --define K=V      Substitute identifier path K with literal V before parsing.
                    Repeatable. Example:
                      --define process.env.NODE_ENV='"production"'
                    String values must include their own quotes.
  --mode <m>        Shorthand for --define-style production/development build.
                    'production' sets process.env.NODE_ENV="production" and
                    typeof process / typeof window to "undefined".
                    'development' sets process.env.NODE_ENV="development".
  --ts7             Use @typescript/native-preview (TypeScript 7 Go-port) as
                    the parser/checker frontend (preview; full migration
                    tracked in #1029). Equivalent to JS2WASM_TS7=1.
  -q, --quiet       Suppress the post-compile "how to run" hint
  -v, --version     Print version and exit
  -h, --help        Show this help

Output files:
  <name>.wasm       WebAssembly binary
  <name>.wat        WebAssembly text format
  <name>.d.ts       TypeScript declarations
  <name>.imports.js createImports() helper`);
  process.exit(0);
}

let inputPath: string | undefined;
let outDir: string | undefined;
const emitWasm = true;
let emitWat = true;
let emitDts = true;
let watOnly = false;
// #1950 — default-on optimization for the CLI. Binaryen wasm-opt does
// materially valuable, safe work the in-compiler passes don't (small-function
// inlining, array.len-into-local, post-inline null-check cleanup, dead
// convert/drop removal). Builds opt in by default at -O3; `--no-optimize`
// restores raw output. Absence of binaryen/wasm-opt degrades gracefully to a
// one-line note (optimize.ts), never a failure. The programmatic `compile()`
// API keeps its opt-out default (no surprise behaviour change for library
// users) — only the CLI flips.
let optimize: boolean | 1 | 2 | 3 | 4 = 3;
let target: "gc" | "linear" | "wasi" | "standalone" | undefined;
let allocator: "bump" | "arena-reset" | undefined;
let emitWit = false;
let witPackageName: string | undefined;
let allowFs = false;
let quiet = false;
let utf8Storage = false;
// #1524 — dual-mode strict gate. `undefined` = let the compiler use its
// default (strict-on under `--target wasi`); `true` / `false` = explicit
// override from `--no-host-imports` / `--allow-host-imports`.
let strictNoHostImports: boolean | undefined;
const defines: Record<string, string> = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "-o" || arg === "--out") {
    outDir = args[++i];
  } else if (arg === "--target") {
    const t = args[++i];
    if (t === "gc" || t === "linear" || t === "wasi" || t === "standalone") {
      target = t;
    } else {
      console.error(`Unknown target: ${t} (expected gc, linear, wasi, or standalone)`);
      process.exit(1);
    }
  } else if (arg === "--standalone") {
    target = "standalone";
  } else if (arg === "--allocator") {
    const a = args[++i];
    if (a === "bump" || a === "arena-reset") {
      allocator = a;
    } else {
      console.error(`Unknown allocator: ${a} (expected bump or arena-reset)`);
      process.exit(1);
    }
  } else if (arg === "--wat") {
    watOnly = true;
  } else if (arg === "--no-wat") {
    emitWat = false;
  } else if (arg === "--no-dts") {
    emitDts = false;
  } else if (arg === "--wit") {
    emitWit = true;
  } else if (arg === "--wit-package") {
    const pkg = args[++i];
    if (!pkg) {
      console.error("--wit-package requires a package name argument");
      process.exit(1);
    }
    witPackageName = pkg;
    emitWit = true;
  } else if (arg.startsWith("--wit-package=")) {
    const pkg = arg.slice("--wit-package=".length);
    if (!pkg) {
      console.error("--wit-package requires a package name argument");
      process.exit(1);
    }
    witPackageName = pkg;
    emitWit = true;
  } else if (arg === "--allow-fs") {
    allowFs = true;
  } else if (arg === "--quiet" || arg === "-q") {
    quiet = true;
  } else if (arg === "--utf8-storage") {
    utf8Storage = true;
  } else if (arg === "--no-host-imports") {
    strictNoHostImports = true;
  } else if (arg === "--allow-host-imports") {
    strictNoHostImports = false;
  } else if (arg === "-O" || arg === "--optimize") {
    optimize = true;
  } else if (arg === "--no-optimize" || arg === "-O0") {
    // #1950 — explicit opt-out of the default-on optimizer.
    optimize = false;
  } else if (/^-O[1-4]$/.test(arg)) {
    optimize = parseInt(arg.slice(2)) as 1 | 2 | 3 | 4;
  } else if (arg === "--define") {
    const kv = args[++i];
    if (!kv) {
      console.error("--define requires a KEY=VALUE argument");
      process.exit(1);
    }
    const eq = kv.indexOf("=");
    if (eq < 0) {
      console.error(`--define expected KEY=VALUE, got: ${kv}`);
      process.exit(1);
    }
    defines[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else if (arg.startsWith("--define=")) {
    const kv = arg.slice("--define=".length);
    const eq = kv.indexOf("=");
    if (eq < 0) {
      console.error(`--define expected KEY=VALUE, got: ${kv}`);
      process.exit(1);
    }
    defines[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else if (arg === "--mode") {
    const m = args[++i];
    if (m !== "production" && m !== "development") {
      console.error(`Unknown --mode: ${m} (expected production or development)`);
      process.exit(1);
    }
    Object.assign(defines, buildDefaultDefines(m));
  } else if (arg === "--ts7") {
    // Already handled above (env var was set before dynamic import).
    // No-op here so the unknown-option fallback below doesn't trigger.
  } else if (!arg.startsWith("-")) {
    inputPath = arg;
  } else {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  }
}

if (!inputPath) {
  console.error("Error: no input file specified");
  process.exit(1);
}

// #1554 — `--standalone` refuses all JS-host imports; `--allow-fs` enables
// node:fs JS-host imports. Combining them silently violates standalone mode,
// so reject at parse time.
if (target === "standalone" && allowFs) {
  console.error("error: --standalone and --allow-fs are mutually exclusive");
  process.exit(1);
}

// #1856 — the bump/arena allocator only exists on the linear backend. The
// WasmGC targets delegate object lifetime to the host GC, so `--allocator`
// has nothing to act on there; reject it rather than silently ignore.
if (allocator !== undefined && target !== "linear") {
  console.error("error: --allocator requires --target linear");
  process.exit(1);
}

const absInput = resolve(inputPath);
const source = readFileSync(absInput, "utf-8");
const name = basename(absInput, ".ts");
const dir = outDir ? resolve(outDir) : dirname(absInput);

const result = await compile(source, {
  ...(optimize ? { optimize } : {}),
  ...(target ? { target } : {}),
  ...(allocator ? { allocator } : {}),
  ...(emitWit ? { wit: witPackageName ? { packageName: witPackageName } : true } : {}),
  ...(allowFs ? { allowFs: true } : {}),
  ...(utf8Storage ? { utf8Storage: true } : {}),
  fileName: absInput,
  ...(strictNoHostImports !== undefined ? { strictNoHostImports } : {}),
  ...(Object.keys(defines).length > 0 ? { define: defines } : {}),
});

if (!result.success) {
  for (const e of result.errors) {
    const severity = e.severity === "warning" ? "warning" : "error";
    // #1929 — prefer the diagnostic's own source file when present (multi-file
    // compiles report errors from imported files, not just the entry).
    const where = e.file ?? absInput;
    console.error(`${where}:${e.line}:${e.column} - ${severity}: ${e.message}`);
  }
  process.exit(1);
}

// Print any warnings (e.g. wasm-opt not available)
for (const e of result.errors) {
  if (e.severity === "warning") {
    console.error(`warning: ${e.message}`);
  }
}

if (watOnly) {
  process.stdout.write(result.wat);
  process.exit(0);
}

let emittedWasmPath: string | undefined;
if (emitWasm) {
  const wasmPath = resolve(dir, `${name}.wasm`);
  writeFileSync(wasmPath, result.binary);
  console.log(`${wasmPath}  (${result.binary.byteLength} bytes)`);
  emittedWasmPath = wasmPath;
}

if (emitWat) {
  const watPath = resolve(dir, `${name}.wat`);
  writeFileSync(watPath, result.wat);
  console.log(`${watPath}  (${result.wat.length} chars)`);
}

if (emitDts) {
  const dtsPath = resolve(dir, `${name}.d.ts`);
  writeFileSync(dtsPath, result.dts);
  console.log(`${dtsPath}  (${result.dts.length} chars)`);
}

{
  const helperPath = resolve(dir, `${name}.imports.js`);
  writeFileSync(helperPath, result.importsHelper);
  console.log(`${helperPath}  (${result.importsHelper.length} chars)`);
}

if (emitWit && result.wit) {
  const witPath = resolve(dir, `${name}.wit`);
  writeFileSync(witPath, result.wit);
  console.log(`${witPath}  (${result.wit.length} chars)`);
}

// Post-compile run hint (#1590). Tells the user how to actually execute the
// output, which otherwise requires trial-and-error (Wasmtime needs explicit
// proposal flags; JS-host output needs the generated imports helper). Suppress
// with --quiet for scripted use.
if (!quiet && emittedWasmPath) {
  if (target === "wasi" || target === "standalone" || target === "linear") {
    // Pure Wasm, no JS host required — runnable directly under Wasmtime.
    console.log(`\nTo run: wasmtime -W all-proposals=y ${emittedWasmPath}`);
  } else {
    // Default (gc) target emits JS-host imports; needs the generated helper.
    console.log(
      `\nThis is a JS-host build (default --target gc) — it needs the generated` +
        ` ${name}.imports.js helper. To run with Node.js:\n` +
        `  node --experimental-wasm-imported-strings -e "import('./${name}.imports.js')` +
        `.then(async ({ createImports }) => { const { instance } = await WebAssembly.instantiate(` +
        `require('fs').readFileSync('${emittedWasmPath}'), createImports()); /* call instance.exports.* */ })"\n` +
        `For a pure-Wasm build runnable under Wasmtime, recompile with --standalone.`,
    );
  }
}
