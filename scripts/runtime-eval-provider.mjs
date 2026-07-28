// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2928 E6 — shared standalone runtime-eval provider: source assembly, compile
// options, disk cache, and instantiation helpers.
//
// The provider is ONE ordered-initializer source unit: the pinned Acorn entry
// module (tests/dogfood/setup-acorn.mjs — committed tarball, sha1-verified) +
// the import-clean interpreter sources (src/interp/*) + the
// `js2wasm:runtime-eval` export wrapper proven end-to-end by
// tests/issue-2928-runtime-link.test.ts and
// tests/interp/runtime-acorn-package-probe.mjs.
//
// Consumers:
//   - scripts/build-runtime-eval-provider.mjs — prebuilds + canary-verifies the
//     provider binary into .test262-cache (invoked by run-test262-vitest.sh for
//     TEST262_TARGET=standalone).
//   - scripts/test262-worker.mjs — on a standalone test whose compiled module
//     imports `js2wasm:runtime-eval`, loads the CACHED binary and links a fresh
//     provider instance. Cache miss = status quo (unresolved import, the same
//     LinkError as before this wiring) — the worker NEVER compiles the provider
//     itself (Acorn compilation takes minutes; the pool kills jobs at 30s).
//   - tests/interp/runtime-acorn-package-probe.mjs — the dedicated harness
//     probe, now consuming the SAME source assembly so the tested artifact and
//     the distributed artifact cannot drift.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { setupAcorn } from "../tests/dogfood/setup-acorn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** Core-Wasm provider namespace owned by #2928/#2527 (mirrors
 *  RUNTIME_EVAL_IMPORT_MODULE in src/codegen/expressions/eval-inline.ts). */
export const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";

/** Provider compile options — the runtime library is an internal subcompile and
 *  retains the explicit legacy fallback policy used by the eval subcompile. */
export const RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS = Object.freeze({
  experimentalIR: false,
  fileName: "runtime-eval-provider.ts",
  skipSemanticDiagnostics: true,
  target: "standalone",
});

/** Import-clean interpreter sources, in initializer order. */
const INTERP_FILES = [
  "types.ts",
  "opcodes.ts",
  "encoder.ts",
  "runtime-ops.ts",
  "emitter.ts",
  "loop.ts",
  "dynamic-function.ts",
];

function stripModuleSyntax(source) {
  return source
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export \{[^;]+;\n/gm, "")
    .replace(/\bexport (?=(?:type|interface|class|const|function)\b)/g, "");
}

// The export wrapper: the published `parse(nativeString, optionsObject) ->
// ESTree $Object` seam feeds `createDynamicFunction` / `executeIndirectEval`;
// provider exceptions cross the module boundary in the `[ok, value]` result
// envelope (see emitRuntimeEvalResultUnwrap in eval-inline.ts). The three
// canaries are the build-time positive control: a provider that cannot
// evaluate "1 + 2" is refused before it is ever cached.
const PROVIDER_EXPORT_WRAPPER = `
      function runtimeEvalResult(ok: boolean, value: any): any {
        const result: any[] = [ok, value];
        return result;
      }

      export function __runtime_new_function(
        paramString: any,
        bodyString: any,
        globalObject: any
      ): any {
        try {
          return runtimeEvalResult(
            true,
            createDynamicFunction(
              parse,
              String(paramString),
              String(bodyString),
              globalObject
            )
          );
        } catch (error) {
          return runtimeEvalResult(false, error);
        }
      }

      export function __runtime_indirect_eval(
        source: any,
        globalObject: any
      ): any {
        try {
          return runtimeEvalResult(
            true,
            executeIndirectEval(parse, source, globalObject)
          );
        } catch (error) {
          return runtimeEvalResult(false, error);
        }
      }

      export function __runtime_eval_canary(): number {
        return executeIndirectEval(parse, "1 + 2", {}) as number;
      }

      export function __runtime_function_canary(): number {
        const fn = createDynamicFunction(
          parse,
          "a,b",
          "return a + b",
          {}
        );
        return fn(1, 2) as number;
      }

      export function __runtime_positive_corpus_canary(): number {
        // Thirty Phase-1-positive bodies drawn from the Test262-shaped corpus
        // in differential.test.ts. Every case parses through the real Acorn
        // artifact and executes in the self-compiled interpreter.
        const sources: string[] = [
          "1 + 2",
          "1 + 2 * 3 - 4 / 2",
          "17 % 5",
          "-3 + 4",
          "var r = 0; if (5 > 3) r = 1; r",
          "var r = 0; if (3 >= 3) r = 1; r",
          "var r = 0; if (1 != 2) r = 1; r",
          "var r = 0; if (1 !== '1') r = 1; r",
          "12",
          "var x = 1; x = x + 41; x",
          "let a = 1, b = 2; a + b",
          "var x = 5; x * 2",
          "var x = 7; x -= 2; x",
          "var x = 2; x *= 3; x",
          "8 / 2",
          "9 % 4",
          "var o = { a: 1, b: 2 }; o.a + o.b",
          "var o = {}; var k = 'z'; o[k] = 9; o[k]",
          "var o = { a: 10, b: 30 }; o.a + o.b",
          "function add(a, b) { return a + b; } add(4, 5)",
          "function twice(n) { return n * 2; } twice(4)",
          "function square(x) { return x * x; } square(6)",
          "function multiply(a, b) { return a * b; } multiply(6, 7)",
          "var g = 0; function inc() { g = g + 1; return g; } inc(); inc(); inc()",
          "var r = 0; try { throw 42; } catch (e) { r = e + 1; } r",
          "var r = 0; try { throw 10; } catch (e) { r = e + 1; } r",
          "function boom() { throw 7; } var r = 0; try { boom(); } catch (e) { r = e; } r",
          "var r = 0; try { throw new Error('x'); } catch (e) { r = 1; } r",
          "Number('4') + Number()",
          "Math.max(3, 7, 2) + Math.min(3, 7, 2) + Math.abs(-5) + Math.floor(2.9) + Math.ceil(2.1)",
        ];
        const expected: number[] = [
          3, 5, 2, 1, 1, 1, 1, 1, 12, 42,
          3, 10, 5, 6, 4, 1, 3, 9, 40, 9,
          8, 36, 42, 3, 43, 11, 7, 1, 4, 19,
        ];
        for (let i = 0; i < sources.length; i += 1) {
          try {
            const actual = executeIndirectEval(parse, sources[i], {});
            if (actual !== expected[i]) return -(i + 1);
          } catch (error) {
            return -(1001 + i);
          }
        }
        return sources.length;
      }
    `;

/**
 * Assemble the full provider source (Acorn + interpreter + export wrapper) as
 * one ordered-initializer unit. Reads the pinned Acorn artifact via
 * setupAcorn() (extracts the committed tarball on first use) and the
 * interpreter sources from src/interp relative to the repo root this module
 * lives in.
 */
export function buildRuntimeEvalProviderSource() {
  const { entryModulePath } = setupAcorn();
  const acorn = stripModuleSyntax(readFileSync(entryModulePath, "utf8"));
  const interpreter = INTERP_FILES.map((name) =>
    stripModuleSyntax(readFileSync(join(REPO_ROOT, "src", "interp", name), "utf8")),
  );
  return [acorn, ...interpreter, PROVIDER_EXPORT_WRAPPER].join("\n");
}

/**
 * Compiler-bundle hash, mirroring the worker's cache-key discipline (#1521):
 * TEST262_BUNDLE_HASH env first, then sha256 of the built compiler bundle.
 * The provider cache key folds this in so a provider compiled by an older
 * compiler is never linked against modules from a newer one.
 */
export function computeCompilerBundleHash() {
  const fromEnv = process.env.TEST262_BUNDLE_HASH;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  for (const file of ["compiler-bundle.mjs", "index.js"]) {
    try {
      const buf = readFileSync(join(HERE, file));
      return createHash("sha256").update(buf).digest("hex").slice(0, 16);
    } catch {}
  }
  return "no-bundle";
}

/** Cache key: provider source + compile options + compiler bundle hash. */
export function runtimeEvalProviderCacheKey(source, bundleHash) {
  return createHash("sha256")
    .update(JSON.stringify(RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS))
    .update(" ")
    .update(bundleHash ?? "")
    .update(" ")
    .update(source)
    .digest("hex")
    .slice(0, 16);
}

/** Default provider cache directory (shared .test262-cache next to scripts/). */
export function defaultRuntimeEvalProviderCacheDir() {
  return join(REPO_ROOT, ".test262-cache");
}

export function runtimeEvalProviderCachePath(cacheDir, key) {
  return join(cacheDir, `runtime-eval-provider-${key}.wasm`);
}

/** Read the cached provider binary, or null when absent. */
export function readCachedRuntimeEvalProvider(cacheDir, key) {
  const path = runtimeEvalProviderCachePath(cacheDir, key);
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Atomically (tmp + rename) publish a provider binary into the cache. */
export function writeCachedRuntimeEvalProvider(cacheDir, key, binary) {
  mkdirSync(cacheDir, { recursive: true });
  const path = runtimeEvalProviderCachePath(cacheDir, key);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, binary);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    if (!existsSync(path)) throw err;
  }
  return path;
}

/**
 * Instantiate a FRESH provider instance (per-test isolation — the interpreter
 * roots dynamic functions at global env records) and return the import
 * namespace the user module links against.
 */
export function instantiateRuntimeEvalNamespace(providerModule) {
  const instance = new WebAssembly.Instance(providerModule, {});
  return {
    __runtime_new_function: instance.exports.__runtime_new_function,
    __runtime_indirect_eval: instance.exports.__runtime_indirect_eval,
  };
}
