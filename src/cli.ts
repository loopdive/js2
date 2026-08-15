#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

declare const __JS2WASM_CLI_VERSION__: string | undefined;

function getCliVersion(): string {
  const bundledVersion = typeof __JS2WASM_CLI_VERSION__ === "string" ? __JS2WASM_CLI_VERSION__ : undefined;
  if (bundledVersion) return bundledVersion;
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

const args = process.argv.slice(2);
let explainMode: "text" | "json" | undefined;
if (args[0] === "explain") {
  args.shift();
  explainMode = "text";
}

// `--ts7` swaps the parser/checker frontend to TypeScript 7 (the Go-port,
// GA on npm; `typescript7` alias, #1288). The decision is made by `src/ts-api.ts` at
// module-load time, so the env var MUST be set before any compiler imports
// resolve. We use a dynamic import below for that reason.
if (args.includes("--ts7")) {
  process.env.JS2WASM_TS7 = "1";
}

const { compile, compileProject, entryHasRelativeImports, formatCompileExplanation, validateEmittedBinary } =
  await import("./index.js");
const { buildDefaultDefines } = await import("./compiler/define-substitution.js");

if (args.includes("--version") || args.includes("-v")) {
  console.log(getCliVersion());
  process.exit(0);
}

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: js2wasm <input.ts> [options]
       js2wasm explain <input.ts> [--json] [options]

Compile a TypeScript file to WebAssembly (GC proposal).

Options:
  -o, --out <dir>   Output directory (default: the current working directory)
  --target <t>      Host/output target — the single host axis (#2736):
                      web   (default) WasmGC / JS-host browser surface (DOM
                            ambient globals in scope);
                      node  a real Node host (Node ambient surface, no DOM);
                      deno  a real Deno host (Deno ambient surface, no DOM);
                      wasi  standalone WASI Preview 1 (fd-based host calls).
                    Also accepts the backend-lowering names gc / linear /
                    standalone (orthogonal backend choice; gc is the default
                    backend for web/node/deno).
  --standalone      Shorthand for --target standalone (pure WasmGC, no JS host,
                    no WASI). Forces nativeStrings: true and refuses to emit
                    wasm:js-string or env JS-host imports.
  --allocator <a>   Linear backend allocator (#1856): bump (default,
                    allocate-and-exit arena, smallest binary) or arena-reset
                    (safe primitive-only exported calls reclaim between calls;
                    aggregate/global escapes fall back, with explicit
                    __arena_reset/__arena_used exports retained). Linear target
                    only.
  --allow-fs        Allow node:fs JS-host imports (readFileSync, writeFileSync)
                    for non-WASI targets (#1491). Off by default to prevent
                    accidental capability leakage.
  --utf8-storage    Dual i8/i16 string storage (#1588): store strings proven
                    UTF-8 (literals, JSON, decoder results, ...) as i8-backed
                    Utf8String for a cheaper Component Model boundary. Implies
                    nativeStrings on the WasmGC backend. Off by default
                    (byte-identical output when off).
  --host-bridge <m> JS-host inspection/interop export surface (#4035):
                    "auto" (default) publishes it for js-host targets and omits
                    it for standalone/wasi; "always" forces it on (what a JS
                    harness that inspects the module needs); "off" forces it
                    off. These exports (__vec_*, __sget_*, __call_fn*,
                    __exn_render_*, __stdout_*, ...) are the calling convention
                    a JS host uses to read WasmGC values — and they are GC
                    roots, so wasm-opt cannot strip what they pin.
  --semantic-providers <m>
                    Semantic implementation policy (#4397): "auto" (default)
                    preserves compatibility; "native-first" selects migrated
                    Wasm-native provider families even under a JS host. This
                    does not disable JS boundary wrappers or platform APIs.
  --explain         Print the compiler-owned provider/capability report and do
                    not write artifacts. Equivalent to the explain subcommand.
  --explain-json    Print that report as stable schema-versioned JSON.
  --wat             Emit only WAT (no binary)
  --no-wat          Skip WAT output
  --no-dts          Skip .d.ts output
  --wit             Generate WIT interface file for Component Model
  --wit-package <p> Package name for --wit output (ns:name[@version]).
                    Implies --wit. Defaults to js2wasm:<input-basename>.
  -v, --verbose     List every dropped host-import warning individually instead
                    of collapsing them into a one-line summary (WASI/strict mode)
  -O, --optimize    Run Binaryen wasm-opt optimizer (on by default at -O3)
  -O1..-O4          Set optimization level (1-4)
  --no-optimize, -O0
                    Disable the optimizer; emit raw codegen output. Optimization
                    is ON by default; this restores the pre-#1950 behaviour.
                    (No-op when binaryen/wasm-opt is unavailable — that path
                    already degrades to a one-line note, never a failure.)
  --link <ns>       Leave the external namespace <ns> as link-time
                    imports (repeatable) instead of inline-lowering it. Satisfied
                    at instantiation by a preloaded provider module (e.g.
                    'wasmtime --preload <ns>=provider.wasm'). Any namespace works
                    (leave-as-import is target-neutral); on WASI,
                    '--link node:fs' additionally selects the import-and-link
                    std-IO path: the module imports
                    readSync/writeSync + its memory from node:fs (no
                    wasi_snapshot_preview1 for stream IO) and links node-fs.wasm.
                    console.log / process.std*.write lower to writeSync(1|2, ...),
                    stdin is readSync(0, ...). Off by default — every namespace is
                    inline-lowered into a self-contained module.
  --emulate <env>   Emulate a host runtime's globals so they type-check without
                    @types/node. 'node' = ambient process/etc.; 'none' = off.
                    Auto-enabled (type-level only) when the source imports a
                    'node:' builtin (use 'none' to disable that); otherwise off,
                    and using process warns to add this flag (#2603).
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
  --ts7             Use TypeScript 7 (the Go-port, GA) as the parser/checker
                    frontend (experimental; full migration tracked in #1029).
                    Equivalent to JS2WASM_TS7=1.
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
// #2520 — when false, collapse the (harmless, dead-code-eliminated) per-import
// "host import not on the dual-mode allowlist" warnings into a one-line summary.
// --verbose restores the full per-import listing.
let verbose = false;
// (#4035) Host-bridge export policy; "auto" resolves per target in codegen.
let hostBridge: "auto" | "always" | "off" = "auto";
let semanticProviders: "auto" | "native-first" = "auto";
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
let allocator: "bump" | "arena-reset" | "analysis-stack" | undefined;
let emitWit = false;
let witPackageName: string | undefined;
let allowFs = false;
let quiet = false;
let utf8Storage = false;
// #1524 — dual-mode strict gate. `undefined` = let the compiler use its
// default (strict-on under `--target wasi`); `true` / `false` = explicit
// override from `--no-host-imports` / `--allow-host-imports`.
let strictNoHostImports: boolean | undefined;
// #2783 — general dynamic-linking axis: namespaces to leave as link-time
// imports (satisfied by a preloaded provider) instead of inline-lowering.
// `--link node:fs` is the spelling for what was once `--link-node-shims` (that
// alias was removed, not deprecated). WASI only; default empty keeps the
// self-contained inline path for every namespace.
const linkedNamespaces = new Set<string>();
// #2603 — `--emulate node`: opt into Node API emulation (ambient `process` typing).
// `emulateExplicit` records that the user passed `--emulate`/`--no-emulate`, so a
// `node:` import won't auto-enable over an explicit choice.
let emulateNode = false;
let emulateExplicit = false;
// #2528/#2645/#2736 — the host environment, scoping the AMBIENT global surface
// (DOM vs node) and node/deno emulation. Driven by the unified `--target
// {web,node,deno}` axis. `undefined` preserves today's behaviour exactly
// (DOM ambient surface loaded, byte-neutral).
let platform: "web" | "node" | "deno" | undefined;
const defines: Record<string, string> = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "-o" || arg === "--out") {
    outDir = args[++i];
  } else if (arg === "--target" || arg.startsWith("--target=")) {
    // #2736 — `--target` is the SINGLE host/output axis. It accepts:
    //   - the host environments: `web` (default), `node`, `deno` — these select
    //     the ambient global surface (#2528/#2645) and leave the backend at its
    //     WasmGC/JS-host default;
    //   - `wasi` — the standalone WASI P1 output ABI (as today);
    //   - the backend-lowering names `gc` / `linear` / `standalone` (kept for
    //     back-compat; they are orthogonal backend choices, not host axes).
    // Host values route to the internal `platform` field; backend values route
    // to `target`. `--target wasi` keeps today's behaviour (backend + no
    // platform scoping) and stays byte-identical.
    const t = arg.startsWith("--target=") ? arg.slice("--target=".length) : args[++i];
    if (t === "gc" || t === "linear" || t === "wasi" || t === "standalone") {
      target = t;
    } else if (t === "web" || t === "node" || t === "deno") {
      platform = t;
    } else {
      console.error(`Unknown target: ${t} (expected web, node, deno, wasi, gc, linear, or standalone)`);
      process.exit(1);
    }
  } else if (arg === "--standalone") {
    target = "standalone";
  } else if (arg === "--allocator") {
    const a = args[++i];
    if (a === "bump" || a === "arena-reset" || a === "analysis-stack") {
      allocator = a;
    } else {
      console.error(`Unknown allocator: ${a} (expected bump, arena-reset, or analysis-stack)`);
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
  } else if (arg === "--link" || arg.startsWith("--link=")) {
    // #2783 — general `--link <namespace>` (repeatable): leave `<namespace>::*`
    // as link-time imports for instantiation-time satisfaction instead of
    // inline-lowering. Any external namespace works ("leave-as-import" is
    // universal); `node:fs` additionally selects the import-and-link std-IO
    // path on WASI. Other namespaces remain explicit provider imports on every
    // target.
    const ns = arg.startsWith("--link=") ? arg.slice("--link=".length) : args[++i];
    if (!ns) {
      console.error("--link requires a namespace argument (e.g. --link node:fs)");
      process.exit(1);
    }
    linkedNamespaces.add(ns);
  } else if (arg === "--emulate" || arg.startsWith("--emulate=")) {
    // #2603 — opt into (or out of) Node API emulation. `--emulate node` gives the
    // checker an ambient `process` typing so Node globals type-check without
    // @types/node; `--emulate none` opts out (and disables the `node:`-import
    // auto-enable below). An explicit choice always wins over auto-detection.
    const env = arg.startsWith("--emulate=") ? arg.slice("--emulate=".length) : args[++i];
    if (env === "node") {
      emulateNode = true;
      emulateExplicit = true;
    } else if (env === "none") {
      emulateNode = false;
      emulateExplicit = true;
    } else {
      console.error(`Unknown --emulate value: ${env ?? "(missing)"} (expected: node | none)`);
      process.exit(1);
    }
  } else if (arg === "--no-host-imports") {
    strictNoHostImports = true;
  } else if (arg === "--allow-host-imports") {
    strictNoHostImports = false;
  } else if (arg === "--host-bridge" || arg.startsWith("--host-bridge=")) {
    // (#4035) Refuse an unknown mode loudly: silently falling back to "auto"
    // would let `--host-bridge=none` (a plausible typo for "off") ship the
    // full bridge while the caller believed it had opted out.
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
    if (value !== "auto" && value !== "always" && value !== "off") {
      console.error(`Error: --host-bridge expects auto | always | off (got ${value ?? "nothing"})`);
      process.exit(1);
    }
    hostBridge = value;
  } else if (arg === "--semantic-providers" || arg.startsWith("--semantic-providers=")) {
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
    if (value !== "auto" && value !== "native-first") {
      console.error(`Error: --semantic-providers expects auto | native-first (got ${value ?? "nothing"})`);
      process.exit(1);
    }
    semanticProviders = value;
  } else if (arg === "--explain") {
    explainMode = "text";
  } else if (arg === "--explain-json") {
    explainMode = "json";
  } else if (arg === "--json" && explainMode !== undefined) {
    explainMode = "json";
  } else if (arg === "--verbose" || arg === "-v") {
    verbose = true;
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

// #2603 — auto-enable Node API emulation when the source imports a `node:`
// builtin (e.g. `import { readFile } from "node:fs"` / `require("node:path")`),
// unless the user made an explicit `--emulate`/`--no-emulate` choice. Emulation
// is type-level only (ambient Node globals); it never changes emitted wasm.
if (!emulateExplicit && !emulateNode && /['"]node:[A-Za-z0-9_./-]+['"]/.test(source)) {
  emulateNode = true;
  console.error("note: auto-enabled Node API emulation (found a `node:` import). Pass --emulate none to disable.");
}

// #2816 — strip the source extension (not just `.ts`) so a `.js`/`.mjs`/...
// input produces `<name>.wasm`, never `<name>.js.wasm`.
const name = basename(absInput).replace(/\.(ts|mts|cts|js|mjs|cjs)$/i, "");
// #2816 — default output to the CWD, not the input's directory. The examples
// ship INSIDE the installed package, so a bare `js2wasm node_modules/.../ex.ts`
// used to dump artifacts into `node_modules` (loopdive/js2wasm#389). Writing to the
// CWD keeps output in the user's working tree; `-o <dir>` still overrides.
const dir = outDir ? resolve(outDir) : process.cwd();

const compileOptions = {
  ...(optimize ? { optimize } : {}),
  ...(target ? { target } : {}),
  ...(allocator ? { allocator } : {}),
  ...(emitWit ? { wit: witPackageName ? { packageName: witPackageName } : true } : {}),
  ...(allowFs ? { allowFs: true } : {}),
  ...(utf8Storage ? { utf8Storage: true } : {}),
  // (#4035) Only forward a non-default policy so `--host-bridge auto` stays
  // byte-identical to not passing the flag at all.
  ...(hostBridge !== "auto" ? { hostBridge } : {}),
  ...(semanticProviders !== "auto" ? { semanticProviders } : {}),
  ...(linkedNamespaces.size ? { link: [...linkedNamespaces] } : {}),
  ...(emulateNode ? { emulateNode: true } : {}),
  ...(platform ? { platform } : {}),
  fileName: absInput,
  ...(strictNoHostImports !== undefined ? { strictNoHostImports } : {}),
  ...(Object.keys(defines).length > 0 ? { define: defines } : {}),
};

// #2771 — a single-file `compile()` reads exactly ONE file and strips every
// import, so an entry that imports a relative `./helper` module leaves those
// bindings unresolved (they lower to bogus `env.*` host imports the WASI gate
// rejects). When the entry statically imports/`require`s a relative module,
// route to the multi-file bundler (`compileProject`), which resolves the
// relative deps from disk through the TS program AND lowers cross-file
// `node:fs`/WASI fd IO (compileMultiSource, #2771). Entries with no relative
// import stay on the single-source path — byte-identical to before.
const result = entryHasRelativeImports(source)
  ? await compileProject(absInput, compileOptions)
  : await compile(source, compileOptions);

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

// Print any warnings (e.g. wasm-opt not available).
//
// #2520 — the per-import "Host import "env.X" … not on the dual-mode allowlist"
// warnings are noise: under --target wasi essentially any program trips ~60 of
// them (anything referencing Uint8Array/Date/Map/… pulls in the whole ambient
// global surface), and those imports are dropped and dead-code-eliminated — they
// never reach the .wasm. The authoritative check is the emit-time leak scan
// (assertNoLeakedHostImports, severity "error"), which only fires if a host
// import actually survives into the binary. So collapse these into a one-line
// summary by default; --verbose restores the full per-import listing.
const isAllowlistWarning = (msg: string): boolean => msg.includes("not on the dual-mode allowlist");
let suppressedAllowlist = 0;
// #2603 follow-up — collapse identical warning messages to a single line. A Node
// global / builtin used N times (e.g. `process` without `--emulate node`)
// otherwise prints N identical "Cannot find name 'X'" warnings. Dedupe by message
// text (first-seen order preserved), appending a count when it repeated.
const warnCounts = new Map<string, number>();
for (const e of result.errors) {
  if (e.severity !== "warning") continue;
  if (!verbose && isAllowlistWarning(e.message)) {
    suppressedAllowlist++;
    continue;
  }
  warnCounts.set(e.message, (warnCounts.get(e.message) ?? 0) + 1);
}
for (const [msg, count] of warnCounts) {
  console.error(count > 1 ? `warning: ${msg} (${count}×)` : `warning: ${msg}`);
}
if (suppressedAllowlist > 0) {
  console.error(
    `warning: ${suppressedAllowlist} host import(s) not on the dual-mode allowlist were dropped ` +
      `(no-op under WASI/strict mode; not in the emitted .wasm). Re-run with --verbose to list them.`,
  );
}

// #3338 — refuse to publish an invalid primary artifact. `result.success`
// means codegen completed, NOT that the binary validates: on wasm-opt failure
// the optimizer emits a warning and preserves the original (possibly invalid)
// bytes (src/optimize.ts), and `--no-optimize` ships raw codegen with no
// validator at all. Without this guard the CLI exits 0 and writes an
// uninstantiable `.wasm` (plus `.wat`/`.d.ts`/imports helper). Validate the
// final binary once here — before the `--wat` stdout path and before any
// output file is written — so a malformed artifact never escapes with a
// success exit code. Optimizer-availability warnings stay nonfatal because the
// preserved binary they fall back to still reaches this check and validates.
// (#4420) Shared with the compiler's opt-in `validate` gate and the optimizer's
// own output check — `validateEmittedBinary` owns the validate-then-recover-the-
// engine-detail idiom (including the BufferSource cast TS 5.7+ requires).
const cliValidation = validateEmittedBinary(result.binary);
if (!cliValidation.valid) {
  console.error(
    `${absInput}: error: emitted WebAssembly failed validation and was not written` +
      (cliValidation.detail ? ` — ${cliValidation.detail}` : ""),
  );
  process.exit(1);
}

if (explainMode !== undefined) {
  if (!result.explanation) {
    console.error(`${absInput}: error: compiler did not produce an explanation record`);
    process.exit(1);
  }
  process.stdout.write(
    explainMode === "json"
      ? `${JSON.stringify(result.explanation, null, 2)}\n`
      : formatCompileExplanation(result.explanation),
  );
  process.exit(0);
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
    // Use the targeted proposal flags this compiler actually emits — gc,
    // function-references, tail-call, exceptions (reference-types is on by
    // default). Do NOT recommend `-W all-proposals=y`: it also enables the
    // stack-switching proposal, which wasmtime 44/45 rejects at module load
    // with "the wasm_stack_switching feature is not supported on this compiler
    // configuration" and exits before running anything (#2511).
    console.log(`\nTo run: wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y ${emittedWasmPath}`);
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
