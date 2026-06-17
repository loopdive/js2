// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
export type ImportIntent =
  | { type: "string_literal"; value: string }
  | { type: "math"; method: string }
  | { type: "console_log"; variant: string }
  | {
      type: "extern_class";
      className: string;
      action: "new" | "method" | "get" | "set";
      member?: string;
      namespacePath?: string[];
    }
  | { type: "string_method"; method: string }
  | { type: "builtin"; name: string }
  | { type: "callback_maker" }
  | { type: "getter_callback_maker" }
  | { type: "await" }
  | { type: "typeof_check"; targetType: string }
  | { type: "box"; targetType: string }
  | { type: "unbox"; targetType: string }
  | { type: "extern_get" }
  | { type: "extern_set" }
  | { type: "truthy_check" }
  | { type: "date_new" }
  | { type: "date_method"; method: string }
  | { type: "date_now" }
  | { type: "declared_global"; name: string }
  | { type: "host_eq" }
  | { type: "host_loose_eq" }
  | { type: "host_add" }
  | { type: "host_compare" }
  | { type: "same_value_zero" }
  | { type: "dynamic_import" }
  | { type: "proxy_create" }
  | { type: "node_builtin"; moduleName: string }
  | { type: "node_builtin_fn"; moduleName: string; name: string }
  | { type: "web_storage"; which: "local" | "session" }
  | { type: "timer_set"; mode: "timeout" | "interval" }
  | { type: "timer_clear"; mode: "timeout" | "interval" }
  | { type: "node_dirname" }
  | { type: "node_filename" }
  | { type: "node_import_meta_url" }
  | {
      // (#1540) JSX runtime binding — `_jsx`/`_jsxs`/`_Fragment`/`_jsxDEV`
      // emitted by TypeScript when `jsx: react-jsx` is set. The host binding
      // is either a user-supplied runtime (`deps.jsxRuntime`) or a built-in
      // React-shaped fallback that constructs `{ $$typeof, type, props, key,
      // ref }` objects suitable for `React.isValidElement` consumers.
      type: "jsx_runtime";
      method: "jsx" | "jsxs" | "Fragment" | "jsxDEV";
      specifier: string;
    };

export interface ImportDescriptor {
  module: "env" | "wasm:js-string" | "string_constants";
  name: string;
  kind: "func" | "global";
  intent: ImportIntent;
}

export type { ExportSignature, TypedArrayKind } from "./ir/types.js";
import type { ExportSignature } from "./ir/types.js";

export interface CompileResult {
  /** Wasm binary with GC proposal */
  binary: Uint8Array;
  /** WAT text representation (debug) */
  wat: string;
  /** TypeScript declaration file for exports and imports */
  dts: string;
  /** JS module with createImports() helper function */
  importsHelper: string;
  /** true if compilation was successful */
  success: boolean;
  /** Error messages with line numbers */
  errors: CompileError[];
  /** String literal pool (values used in the source) */
  stringPool: string[];
  /** Source map v3 JSON string (only present when sourceMap option is enabled) */
  sourceMap?: string;
  /** Import descriptors for closed import building */
  imports: ImportDescriptor[];
  /** C header file content (only present when abi: "c") */
  cHeader?: string;
  /** WIT interface definition (only present when wit option is enabled) */
  wit?: string;
  /** Whether the source declares an exported main() function */
  hasMain: boolean;
  /** Whether the source has top-level executable statements (module init code) */
  hasTopLevelStatements: boolean;
  /**
   * Per-export TypedArray classifications (#1700). Surfaced so
   * {@link wrapExports} can marshal `Uint8Array` (and other TypedArray)
   * params/results across the JS↔Wasm boundary — the Wasm signature is
   * ambiguous (`Uint8Array` and `number[]` share the same `(ref null $Vec[f64])`
   * lowering), so we expose the TS-level distinction as metadata.
   *
   * Only present (and even then, possibly an empty object) when at least
   * one exported function has a TypedArray param or return. Forward the
   * value to `wrapExports(exports, { signatures: result.exportSignatures })`.
   */
  exportSignatures?: Record<string, ExportSignature>;
  /**
   * Ready-to-pass JS-host import object for default/JS-host mode (#1667).
   *
   * In default mode the compiled binary needs host imports (`env.*`,
   * `wasm:js-string`, `string_constants`), so `WebAssembly.instantiate(binary,
   * {})` throws. This getter wires the runtime helpers from {@link buildImports}
   * into a single object the caller passes directly:
   *
   * ```js
   * const r = await compile(src);
   * const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
   * ```
   *
   * Standalone / `wasi` mode is the zero-import portable default and needs no
   * import object; for those targets this is an empty object. Computed lazily —
   * accessing it builds the runtime once and caches the result.
   *
   * Always present on results from the public `compile*` entry points; the
   * low-level `compile*Source` helpers in compiler.ts do not attach it.
   */
  readonly importObject?: WebAssembly.Imports;
  /**
   * #2089 — silent-fallback telemetry counters captured during codegen
   * (per class → per site → count). Only populated when the
   * `trackSilentFallbacks` option is set (the gate
   * `scripts/check-codegen-fallbacks.ts` sets it); `undefined` otherwise so
   * normal compiles pay nothing.
   */
  fallbackCounts?: import("./codegen/fallback-telemetry.js").FallbackCounts;
  /**
   * #1923 — IR post-claim demotions. When the IR selector *claims* a function
   * but it then fails during build/verify/lower/backend-legality, it demotes to
   * the legacy path through the warning channel (`codegen/index.ts`) and is
   * counted by no selector-level metric (`IrFallbackReason` covers only
   * selector-level rejections). Always collected on the WasmGC path (cheap,
   * mirrors `fallbackCounts`); empty/absent for the linear backend (no IR path).
   * Each entry carries the `IrIntegrationError.kind` (build/verify/lower/
   * backend-legality) and the function/message so the ratchet gate
   * `scripts/check-ir-fallbacks.ts` can bucket by kind + normalized message
   * class.
   */
  irPostClaimErrors?: { kind: string; func: string; message: string }[];
}

export interface CompileError {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  /** TS diagnostic code (if from TypeScript diagnostics) */
  code?: number;
  /**
   * Source file the diagnostic originated in (#1929). Populated from
   * `diag.file.fileName` for TypeScript diagnostics; absent for diagnostics
   * with no associated file (global/options errors). Essential for the
   * multi-file / files APIs where `line`/`column` alone can't say *which*
   * file. Additive — existing single-file callers can ignore it.
   */
  file?: string;
}

export interface DomContainmentOptions {
  domRoot: Element | ShadowRoot;
}

export interface ImportPolicy {
  blocked: Set<string>;
}

export interface CompileOptions {
  /** Emit WAT debug output (default: true) */
  emitWat?: boolean;
  /** Module name (for debugging) */
  moduleName?: string;
  /** Generate source map (default: false) */
  sourceMap?: boolean;
  /** Source map URL to embed in the wasm binary (default: "module.wasm.map") */
  sourceMapUrl?: string;
  /** Compilation target: "gc" (WasmGC, default), "linear" (linear memory),
   *  "wasi" (WASI-compatible GC), or "standalone" (pure WasmGC, no JS host
   *  and no WASI runtime — #1470). `target: "standalone"` implies
   *  `nativeStrings: true` and refuses to emit any `wasm:js-string` or
   *  `env` JS-host string imports. */
  target?: "gc" | "linear" | "wasi" | "standalone";
  /** Enable fast mode — i32 default numbers, performance optimizations */
  fast?: boolean;
  /** Use WasmGC-native strings (array i16) instead of wasm:js-string imports.
   *  Enabled automatically when fast: true or target: "wasi".
   *  Required for non-browser runtimes (wasmtime, wasmer, etc.) */
  nativeStrings?: boolean;
  /** #1588 PR-B: dual i8/i16 string storage. When true, string allocation
   *  sites the encoding analysis proves `ascii`/`utf8-guaranteed` are stored
   *  as i8-backed `Utf8String`; all others stay i16. Default false →
   *  byte-identical output. Implies `nativeStrings` on the WasmGC backend. */
  utf8Storage?: boolean;
  /** Test-only: emit `__test_str_from_externref` and `__test_str_to_externref`
   *  exports so test code can pass JS strings to/from native-string params (#1187).
   *  Has no effect unless `nativeStrings` is also true. Production builds should
   *  leave this unset — when off, the helpers are absent from the module entirely. */
  testRuntime?: boolean;
  /** Enable SIMD-accelerated string/array helpers (requires engine SIMD support) */
  simd?: boolean;
  /** Enable safe mode — reject unsafe TypeScript patterns at compile time */
  safe?: boolean;
  /** Globals allowed in safe mode (e.g. ["document"]) */
  allowedGlobals?: string[];
  /** Extern class members allowed in safe mode (e.g. { Element: ["textContent"] }) */
  allowedExternMembers?: Record<string, string[]>;
  /** Allow JavaScript source files as input (auto-detected for .js fileName) */
  allowJs?: boolean;
  /** Virtual file name for the source (controls language: use ".js" for JS input) */
  fileName?: string;
  /** Module resolution options for npm packages */
  resolve?: {
    /** Directories to search for modules (default: ["node_modules"]) */
    modules?: string[];
    /** File extensions to try during resolution (default: [".ts", ".tsx", ".d.ts"]) */
    extensions?: string[];
  };
  /** Packages to keep as host imports (not resolved/bundled) */
  externals?: string[];
  // NOTE: there is no `treeshake` compile option. The standalone `treeshake()`
  // helper (exported below) is used directly by callers/tests; no compile path
  // ever read a `CompileOptions.treeshake` flag, so the dead option was removed
  // (#1931) rather than left as documented-but-inert API surface.
  /** ABI for exported functions: "default" (normal) or "c" (C-compatible calling conventions).
   *  C ABI is only supported with target: "linear". Strings/arrays become (ptr, len) pairs. */
  abi?: "default" | "c";
  /** Enable hardened mode: reject eval, Function constructor, with, __proto__ at compile time */
  hardened?: boolean;
  /** Skip semantic diagnostics for faster compilation (checker still available for type queries) */
  skipSemanticDiagnostics?: boolean;
  /** Generate a WIT (WebAssembly Interface Types) file from exported functions.
   *  When set, the result will include a `wit` field with the WIT interface definition.
   *  Value can be true (derive package name from fileName/moduleName) or an object with
   *  packageName/worldName options. */
  wit?: boolean | { packageName?: string; worldName?: string };
  /** Run Binaryen wasm-opt post-processing on the output binary (default: false).
   *  Requires either the 'binaryen' npm package or wasm-opt on PATH.
   *  Set to true for -O3 defaults, or pass a number (1-4) for a specific level. */
  optimize?: boolean | 1 | 2 | 3 | 4;
  /**
   * Experimental: route a narrow set of functions through the middle-end IR
   * (see `src/ir/`). Defaults to off. Ship as off until the IR reaches
   * parity with the legacy direct-emission path.
   */
  experimentalIR?: boolean;
  /** Compile-time constant definitions. Substitutes identifiers/dotted paths with literal values
   *  before TypeScript parsing. Example: `{ "process.env.NODE_ENV": '"production"' }`.
   *  Values must be valid JS expression literals (strings need inner quotes).
   *  Also supports shorthand: `"production"` mode sets process.env.NODE_ENV and typeof guards. */
  define?: Record<string, string>;
  /** Allow synchronous file-system access via `node:fs` (`readFileSync`, `writeFileSync`)
   *  as JS host imports in non-WASI targets (#1491). Gated behind an explicit flag
   *  to prevent accidental capability leakage when compiling third-party code.
   *  Default: false (calls to fs.readFileSync / fs.writeFileSync raise a compile error). */
  allowFs?: boolean;
  /**
   * Enforce dual-mode discipline (#1524): when true, codegen rejects any
   * JS-host `env` import that is not on
   * `src/codegen/host-import-allowlist.ts`. Auto-enabled under
   * `target: "wasi"` unless this option is explicitly set to `false`
   * (the `--allow-host-imports` CLI escape hatch).
   *
   * Compile errors raised by the gate name the offending import and the
   * tracking issue that owns its Wasm-native replacement.
   */
  strictNoHostImports?: boolean;
  /**
   * Linear backend (`target: "linear"`) allocator behaviour (#1856).
   *
   * The linear backend always uses a **bump/arena** allocator — each
   * allocation advances a single heap pointer and nothing is freed until
   * the Wasm instance is dropped (the "allocate-and-exit" model that suits
   * most standalone/WASI short-lived programs; see R10 in
   * `docs/architecture/compiler-design-lessons.md` and ADR-0017). There is
   * deliberately no pluggable GC abstraction.
   *
   * - `"bump"` (default): the plain allocate-and-exit arena, smallest binary.
   * - `"arena-reset"`: same allocator, but also exports `__arena_reset()`
   *   (O(1) rewind of the whole arena) and `__arena_used()` (bytes
   *   allocated). Use this when an embedder reuses one instance across many
   *   short-lived tasks and wants to reclaim between them.
   *
   * Ignored for non-`linear` targets — the WasmGC backends delegate object
   * lifetime to the host GC and have no linear allocator.
   */
  allocator?: "bump" | "arena-reset";
}

import * as path from "path";
import { IncrementalLanguageService } from "./checker/index.js";
import { compileFilesSource, compileMultiSource, compileSource, compileToObjectSource } from "./compiler.js";
import { ModuleResolver, resolveAllImports } from "./resolve.js";
import { buildImports as buildImportsRuntime } from "./runtime.js";

/**
 * Compile TypeScript source to Wasm GC binary.
 *
 * @example
 * ```ts
 * const result = await compile(`
 *   export function add(a: number, b: number): number {
 *     return a + b;
 *   }
 * `);
 * if (result.success) {
 *   const { instance } = await WebAssembly.instantiate(result.binary, imports);
 *   console.log(instance.exports.add(2, 3)); // 5
 * }
 * ```
 */
export async function compile(source: string, options?: CompileOptions): Promise<CompileResult> {
  return withImportObject(await compileSource(source, options));
}

/**
 * Attach a lazily-computed `importObject` getter (#1667) to a compile result.
 *
 * Building the host runtime via {@link buildImports} is deferred until the
 * caller actually reads `result.importObject`, so standalone / `wasi` outputs
 * (which need no host imports) pay nothing, and the result stays cheap to
 * produce. The built object is cached on first access.
 *
 * The returned object is a valid `WebAssembly.Imports`: `{ env, "wasm:js-string",
 * string_constants }`. It targets the polyfill instantiation path
 * (`WebAssembly.instantiate(binary, importObject)` with no extra options),
 * which is what the issue's example uses.
 */
function withImportObject(result: CompileResult): CompileResult {
  let cached: WebAssembly.Imports | undefined;
  Object.defineProperty(result, "importObject", {
    enumerable: true,
    configurable: true,
    get() {
      if (cached) return cached;
      // Failed compile or zero-import (standalone / wasi) output needs no host
      // runtime — return an empty, harmless import object.
      if (!result.success || result.imports.length === 0) {
        cached = {};
        return cached;
      }
      const built = buildImportsRuntime(result.imports, undefined, result.stringPool);
      cached = {
        env: built.env,
        "wasm:js-string": built["wasm:js-string"],
        string_constants: built.string_constants,
      } as unknown as WebAssembly.Imports;
      // (#1712) Expose the runtime's exports hook. Without it, the host
      // runtime's `callbackState.getExports()` is permanently undefined on
      // this convenience path, silently disabling every exports-backed
      // capability (closure wrapping via __call_fn_N/__call_fn_method_N,
      // __sget_* struct reads, __is_closure gating). Callers wire it after
      // instantiation:
      //   const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
      //   (r.importObject as any).__setExports?.(instance.exports);
      // Non-enumerable so WebAssembly.instantiate's import resolution (which
      // only reads the module-declared namespaces) never sees it.
      if (built.setExports) {
        Object.defineProperty(cached, "__setExports", {
          value: built.setExports,
          enumerable: false,
          configurable: true,
        });
      }
      return cached;
    },
  });
  return result;
}

/**
 * Compile multiple TypeScript source files into a single Wasm GC binary.
 * Supports cross-file imports: `import { foo } from "./bar"`.
 */
export async function compileMulti(
  files: Record<string, string>,
  entryFile: string,
  options?: CompileOptions,
): Promise<CompileResult> {
  return withImportObject(await compileMultiSource(files, entryFile, options));
}

/**
 * Compile a TypeScript project from an entry file on disk.
 * Uses ts.createProgram with real filesystem access -- TypeScript resolves
 * all imports (relative and package) automatically via standard module resolution.
 * All resolved source files are compiled into a single Wasm module.
 * Only the entry file's exports become Wasm exports.
 *
 * @param entryPath - Path to the entry .ts file (absolute or relative to cwd)
 * @param options - Compile options
 *
 * @example
 * ```ts
 * // Given: src/main.ts imports from src/utils.ts
 * const result = await compileFiles("src/main.ts");
 * // TypeScript resolves src/utils.ts automatically
 * ```
 */
export async function compileFiles(entryPath: string, options?: CompileOptions): Promise<CompileResult> {
  return withImportObject(await compileFilesSource(entryPath, options));
}

/** Only WAT text (debug) */
export async function compileToWat(source: string): Promise<string> {
  const result = await compileSource(source, { emitWat: true });
  return result.wat;
}

/**
 * Compile TypeScript source to a relocatable Wasm object file (.o).
 * The output contains LLVM-style linking and relocation metadata
 * suitable for use with a Wasm linker.
 */
export function compileToObject(source: string, options?: CompileOptions) {
  return compileToObjectSource(source, options);
}

/**
 * Compile a TypeScript project from an entry file on disk.
 * Resolves npm package imports and relative imports recursively,
 * then compiles all resolved files into a single Wasm module.
 *
 * @param entryFile - Absolute or relative path to the entry .ts file
 * @param options - Compile options including resolve and externals settings
 */
export async function compileProject(entryFile: string, options?: CompileOptions): Promise<CompileResult> {
  const resolvedEntry = path.resolve(entryFile);
  const rootDir = path.dirname(resolvedEntry);

  // Auto-enable allowJs when entry file is .js/.mjs (#1107)
  const isJs = /\.[cm]?js$/.test(resolvedEntry);
  const effectiveOptions = isJs && !options?.allowJs ? { ...options, allowJs: true } : options;

  // Create resolver
  const resolver = new ModuleResolver(rootDir, effectiveOptions);

  // Resolve all imports recursively
  const allFiles = resolveAllImports(resolvedEntry, resolver);

  // Convert to the Record<string, string> format expected by compileMulti
  const files: Record<string, string> = {};
  for (const [filePath, content] of allFiles) {
    // Use relative paths from root dir as keys
    const relPath = path.relative(rootDir, filePath);
    // Ensure paths start with ./ for the multi-file compiler
    const key = relPath.startsWith(".") ? relPath : `./${relPath}`;
    files[key] = content;
  }

  // Entry file key
  const entryKey = `./${path.relative(rootDir, resolvedEntry)}`;

  return withImportObject(await compileMultiSource(files, entryKey, effectiveOptions));
}

/**
 * Create an incremental compiler that reuses a persistent TypeScript Language Service.
 * Lib files are parsed once on first compilation and cached for all subsequent compilations,
 * eliminating ~50ms of program creation overhead per compilation.
 *
 * Ideal for worker pools or batch compilation scenarios where many source files
 * are compiled sequentially in the same process.
 *
 * @example
 * ```ts
 * const compiler = createIncrementalCompiler();
 * const result1 = compiler.compile("export function a(): number { return 1; }");
 * const result2 = compiler.compile("export function b(): number { return 2; }"); // faster
 * compiler.dispose(); // free resources when done
 * ```
 */
export function createIncrementalCompiler(defaultOptions?: CompileOptions): {
  compile: (source: string, options?: CompileOptions) => Promise<CompileResult>;
  dispose: () => void;
} {
  const service = new IncrementalLanguageService();
  return {
    compile(source: string, options?: CompileOptions): Promise<CompileResult> {
      return compileSource(source, { ...defaultOptions, ...options }, service);
    },
    dispose() {
      service.dispose();
    },
  };
}

export { getBarePackageName, ModuleResolver, resolveAllImports } from "./resolve.js";
export { preloadLibFiles } from "./checker/index.js";
export { getEntryExportNames, treeshake } from "./treeshake.js";
export { generateWit } from "./wit-generator.js";
export type { WitGeneratorOptions } from "./wit-generator.js";

export {
  buildImports,
  buildStringConstants,
  buildWasiPolyfill,
  checkPolicy,
  compileAndInstantiate,
  instantiateWasm,
  instantiateWasmStreaming,
  jsString,
} from "./runtime.js";
