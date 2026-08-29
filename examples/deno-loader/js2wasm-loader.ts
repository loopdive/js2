// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// js2wasm loader (#642) — transparent compile-on-import of a TypeScript module
// to WebAssembly.
//
//   const mod = await loadWasmModule(new URL("./modules/greet.ts", import.meta.url));
//   mod.greet("Deno"); // "Hello, Deno!" — computed inside a WasmGC module
//
// The loader is runtime-agnostic: it runs unmodified under Deno (>= 2, npm
// support) and Node. File reading goes through `Deno.readTextFile` when the
// `Deno` namespace is present and `node:fs/promises` otherwise; both accept a
// `file:` URL, so callers can resolve modules with `new URL(..., import.meta.url)`.
//
// By default the compiler and runtime come from the published package
// (`@loopdive/js2` / `@loopdive/js2/runtime`; under Deno, map those to
// `npm:@loopdive/js2` in `deno.json` — see this directory's `deno.json`).
// Both are injectable via options, which is how the in-repo test
// (`tests/issue-642-deno-loader.test.ts`) exercises this exact file against
// the working-tree compiler without a package install.

interface CompilerModule {
  compile(source: string, options?: Record<string, unknown>): Promise<any>;
}

interface RuntimeModule {
  wrapExports(instance: WebAssembly.Instance, options?: Record<string, unknown>): Record<string, any>;
}

export interface Js2WasmLoaderOptions {
  /** Compiler module (default: `await import("@loopdive/js2")`). */
  compiler?: CompilerModule;
  /** Runtime module providing wrapExports (default: `await import("@loopdive/js2/runtime")`). */
  runtime?: RuntimeModule;
  /** Extra options forwarded to `compile()` (e.g. `{ optimize: true }`). */
  compileOptions?: Record<string, unknown>;
  /**
   * Reject the load when the compiler reports error-severity diagnostics
   * (default: true). js2wasm itself is tolerant — it still emits a module and
   * demotes many problems to diagnostics — but an import-time loader should
   * fail loudly rather than run a module the compiler flagged.
   */
  strict?: boolean;
  /** Reuse the instantiated module on repeat loads of the same specifier (default: true). */
  cache?: boolean;
}

const moduleCache = new Map<string, Promise<Record<string, any>>>();

/** Clear the loader's module cache (mainly for tests). */
export function clearModuleCache(): void {
  moduleCache.clear();
}

async function readSource(specifier: string | URL): Promise<string> {
  const deno = (globalThis as any).Deno;
  if (deno && typeof deno.readTextFile === "function") {
    return await deno.readTextFile(specifier);
  }
  const { readFile } = await import("node:fs/promises");
  return await readFile(specifier, "utf8");
}

// Indirect dynamic import: the specifier stays a runtime value so bundlers
// (vite under vitest) don't try to resolve the package at transform time.
// Deno's import map applies at runtime, so `npm:@loopdive/js2` mapping works.
function importModule(spec: string): Promise<any> {
  return import(/* @vite-ignore */ spec);
}

async function compileAndInstantiate(
  specifier: string | URL,
  options: Js2WasmLoaderOptions,
): Promise<Record<string, any>> {
  const compiler = options.compiler ?? ((await importModule("@loopdive/js2")) as CompilerModule);
  const runtime = options.runtime ?? ((await importModule("@loopdive/js2/runtime")) as RuntimeModule);

  const fileName = String(specifier).split("/").pop() ?? "module.ts";
  const source = await readSource(specifier);
  const result = await compiler.compile(source, { fileName, ...options.compileOptions });
  const errors = (result.errors ?? []).filter((e: any) => e.severity === "error");
  if (!result.success || (options.strict !== false && errors.length > 0)) {
    const shown = errors.length > 0 ? errors : (result.errors ?? []);
    const details = shown.map((e: any) => e.message ?? String(e)).join("\n  ");
    throw new Error(`js2wasm failed to compile ${String(specifier)}:\n  ${details}`);
  }

  // `importObject` is the ready-to-pass JS-host import object (#1667); for
  // standalone/wasi outputs it is empty and instantiation still succeeds.
  const importObject = (result.importObject ?? {}) as WebAssembly.Imports & {
    __setInstance?: (instance: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setInstance?.(instance);

  return runtime.wrapExports(instance, { signatures: result.exportSignatures });
}

/**
 * Load a TypeScript module as a compiled WebAssembly module and return its
 * wrapped exports. Exported functions are directly callable with plain JS
 * values; struct/array returns come back marshalled to plain objects/arrays.
 */
export async function loadWasmModule(
  specifier: string | URL,
  options: Js2WasmLoaderOptions = {},
): Promise<Record<string, any>> {
  const key = String(specifier);
  const useCache = options.cache !== false;
  if (useCache) {
    const cached = moduleCache.get(key);
    if (cached) return cached;
  }
  const loaded = compileAndInstantiate(specifier, options);
  if (useCache) {
    moduleCache.set(key, loaded);
    // Don't poison the cache with a rejected promise.
    loaded.catch(() => moduleCache.delete(key));
  }
  return loaded;
}
