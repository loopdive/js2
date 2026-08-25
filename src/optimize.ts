// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Post-processing pass using Binaryen's wasm-opt optimizer.
 *
 * Tries two strategies in order:
 * 1. The `binaryen` npm package (if installed as an optional peer dependency)
 * 2. A system `wasm-opt` binary on PATH
 *
 * If neither is available, returns the original binary unchanged and emits a warning.
 *
 * This is the `/optimize` entry point of `@loopdive/js2`: call
 * {@link optimizeBinaryAsync} with a compiled Wasm binary and
 * {@link OptimizeOptions} to get an {@link OptimizeResult}.
 *
 * @module
 */

import { inlineHintArgs } from "./inline-hints.js";

// Dynamic imports to avoid vite bundling node-only modules for the browser.
// These are only used by optimizeWithSystemBinary which only runs in Node.js.
let _nodeImports: {
  execFileSync: typeof import("node:child_process").execFileSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
  readFileSync: typeof import("node:fs").readFileSync;
  unlinkSync: typeof import("node:fs").unlinkSync;
  rmdirSync: typeof import("node:fs").rmdirSync;
  mkdtempSync: typeof import("node:fs").mkdtempSync;
  join: typeof import("node:path").join;
  tmpdir: typeof import("node:os").tmpdir;
} | null = null;

async function getNodeImports() {
  if (_nodeImports) return _nodeImports;
  const [cp, fs, path, os] = await Promise.all([
    import("node:child_process"),
    import("node:fs"),
    import("node:path"),
    import("node:os"),
  ]);
  _nodeImports = {
    execFileSync: cp.execFileSync,
    writeFileSync: fs.writeFileSync,
    readFileSync: fs.readFileSync,
    unlinkSync: fs.unlinkSync,
    rmdirSync: fs.rmdirSync,
    mkdtempSync: fs.mkdtempSync,
    join: path.join,
    tmpdir: os.tmpdir,
  };
  return _nodeImports;
}

// Sync fallback for Node.js environments (avoids changing the public API).
// `require` is undefined inside ESM modules, and Vite/Rollup will refuse to
// resolve bare `require("node:child_process")` in browser bundles. Detect a
// Node-like runtime and use `createRequire` to materialize a CJS `require`
// for the four built-in modules we need. #1580: the previous body silently
// returned null in ESM contexts, which made `optimize: true` fall through to
// the "wasm-opt not available" warning even when the binary was on PATH.
function getNodeImportsSync() {
  if (_nodeImports) return _nodeImports;
  // Bail in browser-like contexts. `optimizeBinary` should only be invoked
  // from Node code paths; the async variant handles browser playgrounds.
  if (typeof process === "undefined" || !process.versions || !process.versions.node) {
    return null;
  }
  try {
    // #1580: the previous body used `require("node:child_process")` directly,
    // which is a ReferenceError in ESM. That made `optimize: true` always
    // fall through to the "wasm-opt not available" warning when called from
    // any ESM caller (including `tsx` runs and the scripts/ benchmark
    // generators) even when wasm-opt was on PATH. Use `node:module`'s
    // synchronous `createRequire` via `process.getBuiltinModule` (Node ≥ 22)
    // so the same code path works in CJS hosts, ESM hosts, and esbuild
    // bundles. Vite/Rollup won't statically follow the dynamic getter, so
    // browser bundles still tree-shake this whole function away (it's
    // gated on `process.versions.node` above).
    // Build a synchronous `require` via Node's built-in
    // `node:module#createRequire`. We must reach `node:module` without using
    // `require()` itself (it's a ReferenceError in ESM). Node ≥ 22 exposes
    // `process.getBuiltinModule` for synchronous access to a built-in
    // module — that's the only primitive that works in both CJS and ESM
    // hosts without falling back to `eval`, and it's available in every
    // Node version this project supports.
    let req: NodeRequire | undefined;
    const getBuiltin = (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
    if (typeof getBuiltin === "function") {
      const moduleNs = getBuiltin("node:module") as typeof import("node:module") | undefined;
      if (moduleNs && typeof moduleNs.createRequire === "function") {
        // Anchor the require resolver at the project root (process.cwd).
        // We don't depend on `import.meta.url` here — synchronous code can
        // run in either CJS or ESM, and the resolver only needs a starting
        // directory to walk node_modules from.
        req = moduleNs.createRequire(`file://${process.cwd()}/`);
      }
    }
    if (!req || typeof req !== "function") return null;
    const cp = req("node:child_process") as typeof import("node:child_process");
    const fs = req("node:fs") as typeof import("node:fs");
    const path = req("node:path") as typeof import("node:path");
    const os = req("node:os") as typeof import("node:os");
    _nodeImports = {
      execFileSync: cp.execFileSync,
      writeFileSync: fs.writeFileSync,
      readFileSync: fs.readFileSync,
      unlinkSync: fs.unlinkSync,
      rmdirSync: fs.rmdirSync,
      mkdtempSync: fs.mkdtempSync,
      join: path.join,
      tmpdir: os.tmpdir,
    };
    return _nodeImports;
  } catch {
    return null;
  }
}

/** Settings for {@link optimizeBinaryAsync} (Binaryen wasm-opt configuration). */
export interface OptimizeOptions {
  /** Optimization level: 1 (-O1), 2 (-O2), 3 (-O3), 4 (-O4). Default: 3 */
  level?: 1 | 2 | 3 | 4;
  /** Enable GC proposal (default: true) */
  gc?: boolean;
  /** Enable reference types (default: true) */
  referenceTypes?: boolean;
  /** Enable exception handling (default: true) */
  exceptionHandling?: boolean;
  /** Preserve function names in the optimized binary for profiling. */
  preserveNames?: boolean;
}

/** Result of {@link optimizeBinaryAsync}. */
export interface OptimizeResult {
  /** The optimized binary, or the original bytes if optimization was skipped. */
  binary: Uint8Array;
  /** true if optimization was applied */
  optimized: boolean;
  /** Warning message if optimization was skipped or an unsupported pass was omitted. */
  warning?: string;
}

let _binaryenModulePromise: Promise<any | null> | null = null;

function isBrowserLikeRuntime(): boolean {
  return typeof window !== "undefined" || typeof (globalThis as any).WorkerGlobalScope !== "undefined";
}

/** Outcome of {@link validateEmittedBinary}. */
export interface EmittedBinaryValidation {
  /** `false` only when the engine actively REJECTED the bytes. */
  valid: boolean;
  /** The engine's first validation message, when one could be obtained. */
  detail?: string;
}

/**
 * Ask the host engine whether a Wasm binary is a valid module (#4420).
 *
 * This is the ONE place the "validate, then re-run through `new
 * WebAssembly.Module` to recover the engine's detail string" idiom lives.
 * `WebAssembly.validate` answers a bare boolean; constructing a `Module` is
 * what surfaces the actual complaint (`Compiling function #103:"encodeInstr"
 * failed: struct.get[0] expected type (ref null 2), found local.tee of type
 * f64`) that makes a miscompile diagnosable. Callers: the compiler's opt-in
 * `validate` gate (src/compiler.ts), the CLI's refuse-to-publish check
 * (src/cli.ts, #3338), {@link optimizedBinaryValidates} (#1941), and the
 * dogfood/npm-compat compile probe.
 *
 * Reports `valid: true` when validation cannot be performed at all (no
 * `WebAssembly` global — an exotic embedding). That is deliberate and matches
 * the pre-existing optimizer behavior: an environment that cannot validate
 * must not have every compile fail, and it cannot run the module either.
 */
export function validateEmittedBinary(binary: Uint8Array): EmittedBinaryValidation {
  const WA = (
    globalThis as {
      WebAssembly?: {
        validate?: (b: BufferSource) => boolean;
        Module?: new (b: BufferSource) => unknown;
      };
    }
  ).WebAssembly;
  if (!WA || typeof WA.validate !== "function") return { valid: true };
  // Cast to BufferSource: under TS 5.7+ the typed-array generic types this as
  // `Uint8Array<ArrayBufferLike>`, which the lib `validate`/`Module` overloads
  // (param: BufferSource) don't structurally accept without the widening.
  const bytes = binary as unknown as BufferSource;
  let ok = false;
  try {
    ok = WA.validate(bytes);
  } catch {
    // A throw from validate means the bytes are structurally broken — treat
    // as invalid rather than letting a malformed binary through.
    ok = false;
  }
  if (ok) return { valid: true };
  let detail: string | undefined;
  if (typeof WA.Module === "function") {
    try {
      new WA.Module(bytes);
      // Module construction accepting bytes `validate` rejected would be an
      // engine inconsistency; trust the stricter answer and stay invalid.
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
  }
  return detail === undefined ? { valid: false } : { valid: false, detail };
}

/**
 * Validate optimizer output before trusting it (#1941).
 *
 * `WebAssembly.validate` is available in every runtime that can host a
 * compiled module (Node, browsers, Deno, Bun). We use it as a fail-loud
 * gate on whatever the optimizer hands back: if the bytes don't validate,
 * the optimization MISCOMPILED the module and we must NOT ship it. Returns
 * `true` when validation can't be performed (no `WebAssembly` global — an
 * exotic embedding); in that case we conservatively trust the optimizer,
 * because refusing to optimize everywhere `WebAssembly` is absent would be
 * worse than the status quo.
 */
function optimizedBinaryValidates(binary: Uint8Array): boolean {
  return validateEmittedBinary(binary).valid;
}

/**
 * Optimize a Wasm binary using Binaryen.
 *
 * This is the only public optimizer entry point (#1763). The previous
 * synchronous `optimizeBinary` was removed: after the #1757 async-compile
 * migration every live caller goes through this async path, and the sync
 * variant only kept alive a dead `createRequire("binaryen")` branch — the
 * exact bundler hazard #986/#1756 set out to remove. The `binaryen` package
 * is loaded lazily at runtime (see `getBinaryenModule`) without making
 * bundlers embed it in standalone artifacts; the system `wasm-opt` CLI
 * fallback still uses the dynamic node-builtin shim that bundlers
 * intentionally cannot statically resolve.
 *
 * Backend preference + correctness gate (#1941):
 *   1. Try the **system / bundled `wasm-opt` CLI first**, then the in-process
 *      binaryen module as a fallback (the reverse of the pre-#1941 order).
 *      The binaryen-123 JS module emits a stale GC ref-type encoding
 *      (`0x62` legacy non-null ref) for our closure-dispatch trampolines
 *      that V8 and wasmtime reject, while the bundled native CLI emits the
 *      correct `0x64` encoding. The CLI is the trustworthy backend; the
 *      module is the no-CLI fallback (e.g. browser playgrounds).
 *   2. **Validate every optimizer result** with `WebAssembly.validate`. If
 *      the optimized bytes don't validate, the pass miscompiled the module:
 *      discard them, return the ORIGINAL binary, and emit a fail-loud
 *      warning. We never ship a binary that doesn't validate, regardless of
 *      which backend produced it or which binaryen version is installed.
 */
export async function optimizeBinaryAsync(binary: Uint8Array, options: OptimizeOptions = {}): Promise<OptimizeResult> {
  const level = options.level ?? 3;
  const gc = options.gc !== false;
  const referenceTypes = options.referenceTypes !== false;
  const exceptionHandling = options.exceptionHandling !== false;
  const preserveNames = options.preserveNames === true;

  // The original binary is presumed valid (it came straight from codegen and
  // is validated by every caller's test harness). If it doesn't validate we
  // still hand it back unchanged — optimization can only make things worse,
  // not fix a pre-existing codegen bug, and a broken-input warning would be
  // noise. The optimize gate below only judges the optimizer's *delta*.

  // 1. System / bundled wasm-opt CLI — the correct backend (#1941).
  try {
    const result = optimizeWithSystemBinary(binary, level, gc, referenceTypes, exceptionHandling, preserveNames);
    if (result && result.optimized) {
      if (optimizedBinaryValidates(result.binary)) return result;
      // CLI produced an invalid binary — do not ship it. Fall through to the
      // module backend in case a different encoder produces valid output.
    } else if (result) {
      // CLI resolved but reported a wasm-opt error (warning, optimized:false)
      // — surface it; don't silently fall through to the module path, which
      // would mask a real "we emitted something wasm-opt rejects" signal.
      return result;
    }
  } catch {
    // Fall through to the in-process module backend.
  }

  // 2. In-process binaryen module — fallback for environments with no CLI
  //    (browser playgrounds, stripped installs).
  try {
    const binaryen = await getBinaryenModule();
    if (binaryen) {
      const result = optimizeWithBinaryenModule(
        binaryen,
        binary,
        level,
        gc,
        referenceTypes,
        exceptionHandling,
        preserveNames,
      );
      if (result && result.optimized) {
        if (optimizedBinaryValidates(result.binary)) return result;
        // Module miscompiled (the #1941 case). Discard — return the original
        // binary with a fail-loud warning so the miscompile is visible and we
        // never emit a module that doesn't validate.
        return {
          binary,
          optimized: false,
          warning:
            "wasm-opt produced an invalid binary (it failed WebAssembly.validate); shipping unoptimized output instead. " +
            "This is a known binaryen-JS-module encoder bug for WasmGC ref types (#1941) — installing a native wasm-opt on PATH avoids it.",
        };
      }
      if (result) return result;
    }
  } catch {
    // Fall through to warning.
  }

  return {
    binary,
    optimized: false,
    warning:
      "wasm-opt not available: install the 'binaryen' npm package or add wasm-opt to PATH. Skipping optimization.",
  };
}

async function getBinaryenModule(): Promise<any | null> {
  if (_binaryenModulePromise) return _binaryenModulePromise;
  _binaryenModulePromise = (async () => {
    const browserLike = isBrowserLikeRuntime();
    const globalObject = globalThis as any;
    const hadProcess = "process" in globalObject;
    const hadOwnProcess = Object.prototype.hasOwnProperty.call(globalObject, "process");
    const previousProcess = globalObject.process;

    // The Binaryen browser build auto-detects Node via globalThis.process. In the
    // Vite playground bundle that global can still exist, which sends Binaryen
    // down its Node-only initialization path and makes optimization unavailable.
    if (browserLike && hadProcess) {
      try {
        globalObject.process = undefined;
      } catch {
        // Ignore — some environments have a non-configurable process global.
      }
    }

    try {
      // Keep Binaryen optional. A string-literal dynamic import makes esbuild,
      // Bun, and Deno treat the package as a bundle input, adding ~13.5 MB to
      // standalone artifacts even though wasm-opt is only a post-compile pass.
      const specifier = (globalObject.__js2wasmBinaryenModuleSpecifier as string | undefined) ?? "binaryen";
      const mod = await import(/* @vite-ignore */ specifier);
      return mod.default ?? mod;
    } catch {
      return null;
    } finally {
      if (browserLike) {
        if (hadProcess && hadOwnProcess) {
          globalObject.process = previousProcess;
        } else {
          globalObject.process = undefined;
        }
      }
    }
  })();
  return _binaryenModulePromise;
}

function optimizeWithBinaryenModule(
  binaryen: any,
  binary: Uint8Array,
  level: number,
  gc: boolean,
  referenceTypes: boolean,
  exceptionHandling: boolean,
  preserveNames: boolean,
): OptimizeResult | null {
  const featureFlags = binaryen.Features ?? binaryen.features;
  if (!featureFlags) return null;

  let mod: any;
  try {
    mod = binaryen.readBinary(binary);
  } catch (e) {
    // Binaryen may not support all WasmGC features we emit
    return null;
  }

  try {
    const previousOptimizeLevel =
      typeof binaryen.getOptimizeLevel === "function" ? binaryen.getOptimizeLevel() : undefined;
    const previousShrinkLevel = typeof binaryen.getShrinkLevel === "function" ? binaryen.getShrinkLevel() : undefined;
    const previousDebugInfo = typeof binaryen.getDebugInfo === "function" ? binaryen.getDebugInfo() : undefined;

    // Set features on the module. #1580: enable the full superset js2wasm
    // can emit so wasm-opt doesn't bail on saturating-float-to-int,
    // tail-call, multivalue, typed-function-references, or strings. The
    // binaryen Features bitset accepts ORs; unknown flags on older binaryen
    // simply read as 0 and are no-ops. The "All" feature mask covers
    // everything binaryen knows about — equivalent to the CLI
    // `--all-features`.
    // #1973: build the mask by OR-ing the NAMED feature keys, never starting
    // from `Features.All`. binaryen 125's `All` (0x3FFFFF) includes an *unnamed*
    // custom-descriptors bit (0x200000) that its JS Features enum does not
    // expose as a key, so the `CustomDescriptors !== undefined` guard below
    // silently no-ops and `mod.optimize()` can rewrite `(ref $T)` → `(ref (exact
    // $T))` — a type stock V8/JSC and wasmtime ≤ 44 reject. OR-ing only the
    // named keys covers everything js2wasm emits (the explicit list below is the
    // same superset as the non-`All` branch) without that latent bit.
    let features = 0;
    if (gc) features |= (featureFlags.GC ?? 0) | (featureFlags.ReferenceTypes ?? 0);
    if (referenceTypes) features |= featureFlags.ReferenceTypes ?? 0;
    if (exceptionHandling) features |= featureFlags.ExceptionHandling ?? 0;
    features |= featureFlags.BulkMemory ?? 0;
    features |= featureFlags.MutableGlobals ?? 0;
    features |= featureFlags.SignExt ?? 0;
    features |= featureFlags.TruncSat ?? 0;
    features |= featureFlags.TailCall ?? 0;
    features |= featureFlags.Multivalue ?? 0;
    features |= featureFlags.TypedFunctionReferences ?? 0;
    features |= featureFlags.Strings ?? 0;
    features |= featureFlags.GCNNLocals ?? 0;
    features |= featureFlags.RelaxedSIMD ?? 0;
    features |= featureFlags.ExtendedConst ?? 0;
    features |= featureFlags.SIMD128 ?? 0;
    features |= featureFlags.Atomics ?? 0;
    features |= featureFlags.MultiMemory ?? 0;
    features |= featureFlags.CallIndirectOverlong ?? 0;
    // Defensive: if a future binaryen DOES name the CustomDescriptors bit, still
    // clear it (its GC passes introduce the unparseable exact types). On 125 the
    // key is undefined, so OR-ing named keys above already excludes the bit.
    if (featureFlags.CustomDescriptors !== undefined) {
      features &= ~featureFlags.CustomDescriptors;
    }
    mod.setFeatures(features);

    // Match the requested optimization level more closely than a bare optimize() call.
    // Binaryen's npm API exposes global optimize/shrink settings that affect mod.optimize().
    if (typeof binaryen.setOptimizeLevel === "function") {
      binaryen.setOptimizeLevel(level >= 4 ? 3 : level);
    }
    if (typeof binaryen.setShrinkLevel === "function") {
      binaryen.setShrinkLevel(level >= 4 ? 1 : 0);
    }
    if (preserveNames && typeof binaryen.setDebugInfo === "function") {
      binaryen.setDebugInfo(true);
    }

    try {
      // Run optimization
      mod.optimize();
      if (level >= 4) mod.optimize();
    } finally {
      if (typeof binaryen.setOptimizeLevel === "function" && previousOptimizeLevel !== undefined) {
        binaryen.setOptimizeLevel(previousOptimizeLevel);
      }
      if (typeof binaryen.setShrinkLevel === "function" && previousShrinkLevel !== undefined) {
        binaryen.setShrinkLevel(previousShrinkLevel);
      }
      if (typeof binaryen.setDebugInfo === "function" && previousDebugInfo !== undefined) {
        binaryen.setDebugInfo(previousDebugInfo);
      }
    }

    const optimizedBinary = mod.emitBinary();
    return { binary: new Uint8Array(optimizedBinary), optimized: true };
  } finally {
    mod.dispose();
  }
}

function optimizeWithSystemBinary(
  binary: Uint8Array,
  level: number,
  gc: boolean,
  referenceTypes: boolean,
  exceptionHandling: boolean,
  preserveNames: boolean,
): OptimizeResult | null {
  const n = getNodeImportsSync();
  if (!n) return null; // Not in Node.js environment (browser)

  // Resolve a wasm-opt binary. Try in priority order:
  //   1. PATH lookup via `which` (covers system installs and npx-launched
  //      processes where node_modules/.bin is already on PATH).
  //   2. The `binaryen` npm package's bundled `bin/wasm-opt`. This is the
  //      common case for any project that lists `binaryen` as a (optional)
  //      dependency — it always ships a platform-appropriate binary. #1580:
  //      without this fallback `node script.mjs` (no npx) reaches optimize
  //      but `which` returns "not found", and we silently skip optimization.
  let wasmOptPath: string | undefined;
  try {
    const p = n.execFileSync("which", ["wasm-opt"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (p) wasmOptPath = p;
  } catch {
    // not on PATH — try the binaryen package below
  }
  if (!wasmOptPath) {
    // Resolve binaryen's bin/wasm-opt via Node's module resolver so this
    // works regardless of the caller's cwd.
    try {
      // Get a sync require we can use to resolve packages — same
      // `process.getBuiltinModule` path as `getNodeImportsSync`. Works in
      // both CJS and ESM hosts without relying on `eval` or a lexical
      // `require` binding.
      let req: NodeRequire | undefined;
      const getBuiltin = (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule;
      if (typeof getBuiltin === "function") {
        const moduleNs = getBuiltin("node:module") as typeof import("node:module") | undefined;
        if (moduleNs && typeof moduleNs.createRequire === "function") {
          req = moduleNs.createRequire(`file://${process.cwd()}/`);
        }
      }
      if (req && typeof req.resolve === "function") {
        // `binaryen/package.json` resolves cleanly even when binaryen is a
        // peer/optional dep with an ESM-only main entry. From there derive
        // the bin path.
        const pkgJsonPath = req.resolve("binaryen/package.json");
        const wasmOptCandidate = n.join(pkgJsonPath, "..", "bin", "wasm-opt");
        // Probe by spawning --version (don't fs.access; that's an extra
        // sync system call and execFileSync below will surface a clear
        // error if the file is missing).
        n.execFileSync(wasmOptCandidate, ["--version"], {
          stdio: ["ignore", "ignore", "ignore"],
          timeout: 5_000,
        });
        wasmOptPath = wasmOptCandidate;
      }
    } catch {
      // resolution or probe failed — fall through to "not available"
    }
  }
  if (!wasmOptPath) return null;

  // Write to temp file, run wasm-opt, read result
  const tmpDir = n.mkdtempSync(n.join(n.tmpdir(), "js2wasm-opt-"));
  const inputPath = n.join(tmpDir, "input.wasm");
  const outputPath = n.join(tmpDir, "output.wasm");

  try {
    n.writeFileSync(inputPath, binary);

    // #1580: js2wasm emits constructs from a broad set of post-MVP proposals:
    // saturating float-to-int (nontrapping-float-to-int), array.copy / array.fill
    // (bulk-memory), tail calls in return position, multivalue blocks, and the
    // string proposal when targeting JS hosts. Enable everything wasm-opt
    // understands; the cost of an unused-feature flag is zero, the cost of a
    // missing one is a fatal validator error inside wasm-opt (which previously
    // surfaced as the misleading "wasm-opt not available" warning at the
    // outer try/catch). Use `--all-features` rather than enumerating; it's
    // the same set wasm-opt uses for `wasm-opt --all-features`.
    // `--disable-custom-descriptors` excludes the unfinished
    // custom-descriptors / exact-ref proposal from `--all-features`.
    // Without this, wasm-opt's GC optimization passes will introduce
    // `(ref (exact $T))` types that wasmtime ≤ 44 (and most other engines)
    // refuse to parse. The cost of the disable is zero — js2wasm doesn't
    // emit exact refs itself, so the only effect is preventing wasm-opt
    // from inserting them as a width refinement.
    // (#4157) `JS2WASM_INLINE_HINTS` — binaryen's inlining knobs. Both lists
    // are empty (and the argv byte-identical) unless the flag is set. `pre`
    // must precede `-O<level>`: `--no-inline` is a PASS and binaryen runs
    // passes in command order.
    const hints = inlineHintArgs();
    const args: string[] = [
      inputPath,
      ...hints.pre,
      `-O${level}`,
      "-o",
      outputPath,
      "--all-features",
      "--disable-custom-descriptors",
      ...hints.post,
    ];
    if (preserveNames) args.push("-g");
    void gc;
    void referenceTypes;
    void exceptionHandling;

    const execOptions = {
      // (#4157 entry 31) 600s, was 60s: acorn-scale modules with the inline
      // caches enabled exceed 60s under -O4, and the catch below silently
      // shipped the UNOPTIMIZED binary — measured as a phantom +57% size.
      timeout: 600_000,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    };
    let stderr: Buffer | string = "";
    try {
      n.execFileSync(wasmOptPath, args, execOptions);
    } catch (err) {
      // Surface wasm-opt's actual error message instead of falling through to
      // the misleading "not available" warning. A validator error here means
      // we emitted something wasm-opt rejected — that's a compiler bug worth
      // seeing, not a missing-binary problem.
      const e = err as { stderr?: Buffer | string; message?: string };
      stderr = e.stderr ?? e.message ?? "unknown error";
      let text = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr);

      // (#4586) Standardized Wasm EH uses `try_table`, which Binaryen 125's
      // O4-only Flatten pass classifies as control flow but does not implement.
      // Binaryen aborts at Flatten.cpp instead of declining the pass. Preserve
      // the standardized output required by current Wasmtime/Wasmer and retry
      // the SAME O4 pipeline with only that unsupported pass omitted. Keep this
      // signature deliberately narrow: every other optimizer failure must
      // remain loud and return the raw binary below.
      const unsupportedFlatten =
        level === 4 &&
        text.includes("Flatten.cpp:") &&
        (text.includes("unexpected expr type") || text.includes("Unsupported instruction for Flatten: try_table"));
      if (unsupportedFlatten) {
        try {
          n.execFileSync(wasmOptPath, [...args, "--skip-pass=flatten"], execOptions);
          const optimizedBinary = n.readFileSync(outputPath);
          return {
            binary: new Uint8Array(optimizedBinary),
            optimized: true,
            warning:
              "wasm-opt -O4 omitted Binaryen's unsupported flatten pass for standardized try_table output; all remaining O4 passes completed.",
          };
        } catch (retryError) {
          const retry = retryError as { stderr?: Buffer | string; message?: string };
          const retryStderr = retry.stderr ?? retry.message ?? "unknown error";
          const retryText = Buffer.isBuffer(retryStderr) ? retryStderr.toString("utf-8") : String(retryStderr);
          text = `${text.trim()}\nRetry without flatten failed: ${retryText.trim()}`;
        }
      }
      // (#4157 entry 31) LOUD, unconditionally: the warning field alone was
      // ignored by every consumer, so a timeout here silently shipped an
      // unoptimized binary into perf measurements twice. stderr is the one
      // channel every harness keeps.
      process.stderr.write(
        `[optimize] wasm-opt -O${level} FAILED — shipping UNOPTIMIZED binary (${binary.length} bytes). ` +
          `Perf/size numbers from this build are not comparable to an optimized one. ` +
          `Cause: ${text.slice(0, 200).trim() || "(no stderr — likely the 600s timeout)"}\n`,
      );
      return {
        binary,
        optimized: false,
        warning: `wasm-opt -O${level} failed: ${text.slice(0, 800).trim()}`,
      };
    }

    const optimizedBinary = n.readFileSync(outputPath);
    return { binary: new Uint8Array(optimizedBinary), optimized: true };
  } finally {
    // Cleanup temp files
    try {
      n.unlinkSync(inputPath);
    } catch {
      /* ignore */
    }
    try {
      n.unlinkSync(outputPath);
    } catch {
      /* ignore */
    }
    try {
      // The temp dir is a directory, so `unlinkSync` is expected to fail;
      // remove it with `rmdirSync`. #1763: route this through the same
      // dynamic node-builtin bundle (`n` = getNodeImportsSync()) the rest of
      // this function uses, rather than a bare `require("node:fs")` that a
      // bundler can't bind in ESM (GH #986).
      n.rmdirSync(tmpDir);
    } catch {
      /* ignore */
    }
  }
}
