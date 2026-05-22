// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Post-processing pass using Binaryen's wasm-opt optimizer.
 *
 * Tries two strategies in order:
 * 1. The `binaryen` npm package (if installed as an optional dependency)
 * 2. A system `wasm-opt` binary on PATH
 *
 * If neither is available, returns the original binary unchanged and emits a warning.
 */

// Dynamic imports to avoid vite bundling node-only modules for the browser.
// These are only used by optimizeWithSystemBinary which only runs in Node.js.
let _nodeImports: {
  execFileSync: typeof import("node:child_process").execFileSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
  readFileSync: typeof import("node:fs").readFileSync;
  unlinkSync: typeof import("node:fs").unlinkSync;
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
      mkdtempSync: fs.mkdtempSync,
      join: path.join,
      tmpdir: os.tmpdir,
    };
    return _nodeImports;
  } catch {
    return null;
  }
}

export interface OptimizeOptions {
  /** Optimization level: 1 (-O1), 2 (-O2), 3 (-O3), 4 (-O4). Default: 3 */
  level?: 1 | 2 | 3 | 4;
  /** Enable GC proposal (default: true) */
  gc?: boolean;
  /** Enable reference types (default: true) */
  referenceTypes?: boolean;
  /** Enable exception handling (default: true) */
  exceptionHandling?: boolean;
}

export interface OptimizeResult {
  binary: Uint8Array;
  /** true if optimization was applied */
  optimized: boolean;
  /** Warning message if optimization was skipped */
  warning?: string;
}

let _binaryenModulePromise: Promise<any | null> | null = null;

function isBrowserLikeRuntime(): boolean {
  return typeof window !== "undefined" || typeof (globalThis as any).WorkerGlobalScope !== "undefined";
}

/**
 * Optimize a Wasm binary using Binaryen.
 * Returns the optimized binary, or the original if optimization is unavailable.
 */
export function optimizeBinary(binary: Uint8Array, options: OptimizeOptions = {}): OptimizeResult {
  const level = options.level ?? 3;
  const gc = options.gc !== false;
  const referenceTypes = options.referenceTypes !== false;
  const exceptionHandling = options.exceptionHandling !== false;

  // Strategy 1: Try the binaryen npm package
  try {
    const result = optimizeWithBinaryenPackage(binary, level, gc, referenceTypes, exceptionHandling);
    if (result) return result;
  } catch {
    // Fall through to system binary
  }

  // Strategy 2: Try system wasm-opt binary
  try {
    const result = optimizeWithSystemBinary(binary, level, gc, referenceTypes, exceptionHandling);
    if (result) return result;
  } catch {
    // Fall through to warning
  }

  return {
    binary,
    optimized: false,
    warning:
      "wasm-opt not available: install the 'binaryen' npm package or add wasm-opt to PATH. Skipping optimization.",
  };
}

/**
 * Async optimizer variant for environments that can lazy-load the ESM
 * `binaryen` package (for example the browser playground via Vite).
 */
export async function optimizeBinaryAsync(binary: Uint8Array, options: OptimizeOptions = {}): Promise<OptimizeResult> {
  const level = options.level ?? 3;
  const gc = options.gc !== false;
  const referenceTypes = options.referenceTypes !== false;
  const exceptionHandling = options.exceptionHandling !== false;

  try {
    const binaryen = await getBinaryenModule();
    if (binaryen) {
      const result = optimizeWithBinaryenModule(binaryen, binary, level, gc, referenceTypes, exceptionHandling);
      if (result) return result;
    }
  } catch {
    // Fall through to sync system-binary fallback in Node.js
  }

  try {
    const result = optimizeWithSystemBinary(binary, level, gc, referenceTypes, exceptionHandling);
    if (result) return result;
  } catch {
    // Fall through to warning
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
      const mod = await import("binaryen");
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

function optimizeWithBinaryenPackage(
  binary: Uint8Array,
  level: number,
  gc: boolean,
  referenceTypes: boolean,
  exceptionHandling: boolean,
): OptimizeResult | null {
  // Dynamic import to avoid hard dependency
  let binaryen: any;
  try {
    binaryen = require("binaryen");
  } catch {
    return null;
  }

  return optimizeWithBinaryenModule(binaryen, binary, level, gc, referenceTypes, exceptionHandling);
}

function optimizeWithBinaryenModule(
  binaryen: any,
  binary: Uint8Array,
  level: number,
  gc: boolean,
  referenceTypes: boolean,
  exceptionHandling: boolean,
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

    // Set features on the module. #1580: enable the full superset js2wasm
    // can emit so wasm-opt doesn't bail on saturating-float-to-int,
    // tail-call, multivalue, typed-function-references, or strings. The
    // binaryen Features bitset accepts ORs; unknown flags on older binaryen
    // simply read as 0 and are no-ops. The "All" feature mask covers
    // everything binaryen knows about — equivalent to the CLI
    // `--all-features`.
    let features = 0;
    if (featureFlags.All !== undefined) {
      features = featureFlags.All;
    } else {
      if (gc) features |= featureFlags.GC | featureFlags.ReferenceTypes;
      if (referenceTypes) features |= featureFlags.ReferenceTypes;
      if (exceptionHandling) features |= featureFlags.ExceptionHandling;
      features |= featureFlags.BulkMemory ?? 0;
      features |= featureFlags.MutableGlobals ?? 0;
      features |= featureFlags.SignExt ?? 0;
      features |= featureFlags.TruncSat ?? 0;
      features |= featureFlags.TailCall ?? 0;
      features |= featureFlags.Multivalue ?? 0;
      features |= featureFlags.TypedFunctionReferences ?? 0;
      features |= featureFlags.Strings ?? 0;
    }
    // Mirror the CLI's `--disable-custom-descriptors`: clear the
    // CustomDescriptors bit if `All` set it, so wasm-opt's GC passes don't
    // introduce `(ref (exact $T))` types that wasmtime ≤ 44 can't parse.
    // See the matching comment in `optimizeWithSystemBinary`.
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
    const args: string[] = [
      inputPath,
      `-O${level}`,
      "-o",
      outputPath,
      "--all-features",
      "--disable-custom-descriptors",
    ];
    void gc;
    void referenceTypes;
    void exceptionHandling;

    let stderr: Buffer | string = "";
    try {
      n.execFileSync(wasmOptPath, args, {
        timeout: 60_000, // 60 second timeout
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // Surface wasm-opt's actual error message instead of falling through to
      // the misleading "not available" warning. A validator error here means
      // we emitted something wasm-opt rejected — that's a compiler bug worth
      // seeing, not a missing-binary problem.
      const e = err as { stderr?: Buffer | string; message?: string };
      stderr = e.stderr ?? e.message ?? "unknown error";
      const text = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr);
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
      n.unlinkSync(tmpDir);
    } catch {
      try {
        const fs = require("node:fs");
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
    }
  }
}
