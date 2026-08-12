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
import { createRequire } from "node:module";
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

/**
 * (#2928 E7) The message the REFUSAL provider reports. Deliberately worded as
 * the same #2960 Tier-3 contract the direct-eval fallback already throws, so a
 * build without the interpreter and a direct-eval call site refuse identically.
 */
export const RUNTIME_EVAL_REFUSAL_MESSAGE =
  "dynamic code evaluation is not supported in this standalone build " +
  "(no js2wasm:runtime-eval interpreter linked — tracking: #2928)";

/**
 * (#2928 E7) The REFUSAL provider: the same `js2wasm:runtime-eval` ABI as the
 * real provider (canonical rec-groups, `[ok, value]` envelope), with zero
 * capability — every entry point returns `[false, TypeError]`.
 *
 * Why this exists. The provider import is MODULE-LEVEL: a standalone module
 * that mentions dynamic `new Function` / indirect eval anywhere carries the
 * import, so with no namespace supplied the module cannot even INSTANTIATE
 * ("Import #0 \"js2wasm:runtime-eval\": module is not an object or function").
 * Every assertion in such a file is then lost, including the majority that
 * never reach the dynamic call at all — §20.2.1.1.1 ToString coercion of the
 * arguments happens AOT at the call site, so e.g. a throwing `toString` throws
 * before the provider is ever consulted.
 *
 * Linking this refusal module restores the honest Tier-3 behaviour: the file
 * runs, and ONLY the dynamic-code call itself throws a typed, catchable
 * TypeError. It injects no JS-host capability — it is a js2wasm-compiled,
 * zero-import core-Wasm module like the real provider, just an empty one.
 */
const REFUSAL_PROVIDER_SOURCE = `
      function runtimeEvalResult(ok: boolean, value: any): any {
        const result: any[] = [ok, __runtime_eval_wrap_result(value)];
        return result;
      }

      var refusalIntrinsicEval: any = undefined;
      var refusalIntrinsicFunction: any = undefined;
      function refusalEvalTarget(): any {
        return undefined;
      }
      function refusalFunctionTarget(): any {
        return undefined;
      }

      function refusalEvalValue(globalObject: any): any {
        if (refusalIntrinsicFunction === undefined) {
          refusalIntrinsicFunction = __runtime_eval_wrap_intrinsic_function_callback(
            refusalFunctionTarget,
            "Function",
            1
          );
        }
        if (refusalIntrinsicEval === undefined) {
          refusalIntrinsicEval = __runtime_eval_wrap_intrinsic_callback(
            refusalEvalTarget,
            "eval",
            1,
            refusalIntrinsicFunction
          );
        }
        if (!("eval" in globalObject)) globalObject.eval = refusalIntrinsicEval;
        if (!("Function" in globalObject)) globalObject.Function = refusalIntrinsicFunction;
        return globalObject.eval;
      }

      function refuse(): any {
        return runtimeEvalResult(
          false,
          new TypeError(${JSON.stringify(RUNTIME_EVAL_REFUSAL_MESSAGE)})
        );
      }

      export function __runtime_new_function(
        paramString: any,
        bodyString: any,
        globalObject: any
      ): any {
        return refuse();
      }

      export function __runtime_indirect_eval(
        source: any,
        globalObject: any
      ): any {
        // Reading the first-class intrinsic is not itself dynamic code
        // execution. Let a first-class eval alias materialize a callable marker;
        // invoking it still reaches __runtime_apply_interpreted and refuses.
        if (source === "eval") return runtimeEvalResult(true, refusalEvalValue(globalObject));
        if (source === "Function") {
          refusalEvalValue(globalObject);
          return runtimeEvalResult(true, globalObject.Function);
        }
        return refuse();
      }

      export function __runtime_direct_eval(
        source: any,
        globalObject: any,
        thisArg: any,
        activationState: any,
        activationSeedNames: any,
        activationSeedSlots: any,
        lexicalNames: any,
        lexicalSlots: any,
        outerNames: any,
        outerSlots: any,
        callerStrict: boolean,
        mappedParamNames: any
      ): any {
        return refuse();
      }

      export function __runtime_apply_interpreted(
        callable: any,
        receiver: any,
        argc: number,
        a0: any,
        a1: any,
        a2: any,
        a3: any,
        a4: any,
        a5: any,
        a6: any,
        a7: any
      ): any {
        return refuse();
      }
    `;

/**
 * (#2928 E7) Cross-module positive control for the refusal provider: a tiny
 * standalone user module that takes the DYNAMIC `new Function` route and
 * reports what it caught. Returns 21 only when the refusal envelope surfaced
 * as a real, catchable `TypeError` carrying the refusal message — i.e. the
 * envelope ABI actually round-trips, not merely that the module linked.
 */
export const RUNTIME_EVAL_REFUSAL_CANARY_SOURCE = `
      var suffix = 1;
      var body = "return a + " + suffix;
      var code = 0;
      try {
        var fn = new Function("a", body);
        code = 100 + fn(41);
      } catch (err) {
        if (err instanceof TypeError) {
          code = 2;
          if (typeof err.message === "string" && err.message.length > 0) {
            code = 20 + (err.message.indexOf("standalone") >= 0 ? 1 : 0);
          }
        } else {
          code = 3;
        }
      }
      export function probe(): number { return code; }
    `;

/** Expected `probe()` value for RUNTIME_EVAL_REFUSAL_CANARY_SOURCE. */
export const RUNTIME_EVAL_REFUSAL_CANARY_EXPECTED = 21;

/** Import-clean interpreter sources, in initializer order. */
const INTERP_FILES = [
  "types.ts",
  "opcodes.ts",
  "encoder.ts",
  "runtime-ops.ts",
  "eval-environment.ts",
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
        const result: any[] = [ok, __runtime_eval_wrap_result(exposeRuntimeEvalValue(value))];
        return result;
      }

      function exposeRuntimeEvalSlots(slots: any): void {
        if (slots === undefined || slots === null) return;
        for (let i = 0; i < slots.length; i += 1) {
          const cell: any = slots[i];
          if (cell !== undefined && cell !== null) {
            cell.value = exposeRuntimeEvalSharedValue(cell.value);
          }
        }
      }

      function exposeRuntimeEvalCallerSlots(
        activationSeedSlots: any,
        lexicalSlots: any,
        outerSlots: any
      ): void {
        exposeRuntimeEvalSlots(activationSeedSlots);
        exposeRuntimeEvalSlots(lexicalSlots);
        exposeRuntimeEvalSlots(outerSlots);
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
          const value = executeIndirectEval(parse, source, globalObject);
          exposeRuntimeEvalGlobalLexicalCells(globalObject);
          exposeRuntimeEvalObject(globalObject);
          return runtimeEvalResult(true, value);
        } catch (error) {
          exposeRuntimeEvalGlobalLexicalCells(globalObject);
          exposeRuntimeEvalObject(globalObject);
          return runtimeEvalResult(false, error);
        }
      }

      export function __runtime_direct_eval(
        source: any,
        globalObject: any,
        thisArg: any,
        activationState: any,
        activationSeedNames: any,
        activationSeedSlots: any,
        lexicalNames: any,
        lexicalSlots: any,
        outerNames: any,
        outerSlots: any,
        callerStrict: boolean,
        mappedParamNames: any
      ): any {
        const liveNames: any[] = [];
        const liveSlots: any[] = [];
        try {
          restoreDirectEvalActivationState(activationState, liveNames, liveSlots);
          const evalResult = executeDirectEval(
            parse,
            source,
            globalObject,
            __runtime_eval_unwrap_result(thisArg),
            liveNames,
            liveSlots,
            activationSeedNames,
            activationSeedSlots,
            lexicalNames,
            lexicalSlots,
            outerNames,
            outerSlots,
            callerStrict,
            mappedParamNames,
            activationState
          );
          exposeRuntimeEvalCallerSlots(activationSeedSlots, lexicalSlots, outerSlots);
          exposeRuntimeEvalGlobalLexicalCells(globalObject);
          exposeRuntimeEvalObject(globalObject);
          snapshotDirectEvalActivationState(activationState, liveNames);
          return runtimeEvalResult(true, evalResult);
        } catch (error) {
          exposeRuntimeEvalCallerSlots(activationSeedSlots, lexicalSlots, outerSlots);
          exposeRuntimeEvalGlobalLexicalCells(globalObject);
          exposeRuntimeEvalObject(globalObject);
          snapshotDirectEvalActivationState(activationState, liveNames);
          return runtimeEvalResult(false, error);
        }
      }

      export function __runtime_apply_interpreted(
        callable: any,
        receiver: any,
        argc: number,
        a0: any,
        a1: any,
        a2: any,
        a3: any,
        a4: any,
        a5: any,
        a6: any,
        a7: any
      ): any {
        const args: any[] = [];
        if (argc > 0) args.push(__runtime_eval_unwrap_result(a0));
        if (argc > 1) args.push(__runtime_eval_unwrap_result(a1));
        if (argc > 2) args.push(__runtime_eval_unwrap_result(a2));
        if (argc > 3) args.push(__runtime_eval_unwrap_result(a3));
        if (argc > 4) args.push(__runtime_eval_unwrap_result(a4));
        if (argc > 5) args.push(__runtime_eval_unwrap_result(a5));
        if (argc > 6) args.push(__runtime_eval_unwrap_result(a6));
        if (argc > 7) args.push(__runtime_eval_unwrap_result(a7));
        try {
          const value = applyRuntimeEvalCallable(
            callable,
            __runtime_eval_unwrap_result(receiver),
            args
          );
          exposeRuntimeEvalCallableEnvironment(callable);
          return runtimeEvalResult(true, value);
        } catch (error) {
          exposeRuntimeEvalCallableEnvironment(callable);
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

      export function __runtime_direct_eval_canary(): number {
        const names: any[] = ["x"];
        const cell: EvalBindingCell = { value: 40 };
        const slots: any[] = [cell];
        const result = executeDirectEval(
          parse,
          "x = x + 2; x",
          {},
          undefined,
          [],
          [],
          names,
          slots,
          [],
          [],
          [],
          [],
          false,
          []
        );
        return (result as number) + (cell.value as number);
      }

      export function __runtime_apply_interpreted_canary(): number {
        const fn = createDynamicFunction(parse, "a,b", "return a + b", {});
        const result: any = __runtime_apply_interpreted(
          fn,
          undefined,
          2,
          1,
          2,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined
        );
        return result[0] ? __runtime_eval_unwrap_result(result[1]) as number : -1;
      }

      export function __runtime_positive_corpus_canary(): number {
        const declarationPlan = collectEvalDeclarations(
          parse("var declaredVar; let declaredLexical;", {
            ecmaVersion: 2025,
            sourceType: "script"
          })
        );
        if (declarationPlan.varNames.length !== 1) return -2001;
        if (declarationPlan.varNames[0] !== "declaredVar") return -2002;
        if (declarationPlan.lexicalNames.length !== 1) return -2003;
        if (declarationPlan.lexicalNames[0] !== "declaredLexical") return -2004;
        const declarationAst = parse("'use strict'; var privateVar = 1; privateVar", {
          ecmaVersion: 2025,
          sourceType: "script"
        });
        const declarationGlobal: any = {};
        const declarationGlobalEnv = new EnvRec(ENV_GLOBAL, null, null, null, declarationGlobal);
        const declarationEnv = prepareEvalEnvironment(
          declarationAst,
          declarationGlobalEnv,
          declarationGlobalEnv,
          true
        );
        if (declarationEnv.kind !== ENV_DECLARATIVE) return -2005;
        const declarationNames: any = declarationEnv.names;
        if (declarationNames.length !== 1) return -2006;
        if (declarationNames[0] !== "privateVar") return -2007;
        const declarationSlots: any = declarationEnv.slots;
        if (declarationSlots.length !== 1) return -2008;

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
 * (#2928 E7) Assemble the refusal-provider source. Standalone by construction:
 * no Acorn, no interpreter, no imports — it compiles in seconds, which is what
 * makes it affordable in every CI shard (the real provider takes minutes).
 */
export function buildRuntimeEvalRefusalProviderSource() {
  return REFUSAL_PROVIDER_SOURCE;
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

/**
 * (#2928 E7) Cache path for the REFUSAL provider. A distinct filename prefix
 * (not just a distinct key) so CI can glob/upload the two artifacts
 * independently — the refusal one is built in every standalone shard, the real
 * one is not.
 */
export function runtimeEvalRefusalCachePath(cacheDir, key) {
  return join(cacheDir, `runtime-eval-refusal-${key}.wasm`);
}

/** Read the cached provider binary, or null when absent. */
export function readCachedRuntimeEvalProvider(cacheDir, key, pathOf = runtimeEvalProviderCachePath) {
  const path = pathOf(cacheDir, key);
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Select the cached provider tier for one Test262 process.
 *
 * Both the fork worker and the in-process fixture-graph lane must make the
 * identical choice. Keeping cache keys, the opt-in full-provider switch, and
 * the refusal fallback here prevents a fixture-only link path from silently
 * drifting back to an unresolved `js2wasm:runtime-eval` import.
 */
export function selectCachedRuntimeEvalProvider() {
  // (#4238) Engine selector. Read + VALIDATED here, OUTSIDE the try/catch
  // below: an unknown engine must fail the process loudly, never degrade into
  // the NONE tier where it would look like an ordinary missing-cache result.
  const engine = process.env.JS2WASM_EVAL_ENGINE ?? "quickjs";
  if (engine !== "interpreter" && engine !== "quickjs") {
    throw new Error(
      `JS2WASM_EVAL_ENGINE=${JSON.stringify(engine)} is not a known eval engine ` +
        `(expected "interpreter" or "quickjs")`,
    );
  }
  if (process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER === "1") {
    // Precedence: the disable switch wins over the engine flag.
    return {
      module: null,
      engine: "none",
      message: "NONE (TEST262_DISABLE_RUNTIME_EVAL_PROVIDER=1) — eval-mentioning modules cannot link",
    };
  }
  if (engine === "quickjs") return selectQuickjsEngine();
  try {
    const compilerHash = computeCompilerBundleHash();
    const load = (source, pathOf) => {
      const key = runtimeEvalProviderCacheKey(source, compilerHash);
      const binary = readCachedRuntimeEvalProvider(defaultRuntimeEvalProviderCacheDir(), key, pathOf);
      return { key, module: binary ? new WebAssembly.Module(binary) : null };
    };
    const full =
      process.env.TEST262_FULL_RUNTIME_EVAL === "1"
        ? load(buildRuntimeEvalProviderSource(), undefined)
        : { key: "(not requested)", module: null };
    if (full.module) {
      return {
        module: full.module,
        engine: "interpreter",
        message:
          `INTERPRETER (key ${full.key}, TEST262_FULL_RUNTIME_EVAL=1) — authoritative CI-comparable ` +
          `standalone tier (#2928 E7) — selected via JS2WASM_EVAL_ENGINE=interpreter ` +
          `(kept native bytecode engine, #4242)`,
      };
    }
    const refusal = load(buildRuntimeEvalRefusalProviderSource(), runtimeEvalRefusalCachePath);
    return {
      module: refusal.module,
      engine: refusal.module ? "refusal" : "none",
      message: refusal.module
        ? `REFUSAL (key ${refusal.key}; interpreter ${full.key}) — fast local diagnostic only, NOT ` +
          `CI-comparable: eval-mentioning modules instantiate and dynamic-code calls throw TypeError — ` +
          `selected via JS2WASM_EVAL_ENGINE=interpreter (kept native bytecode engine, #4242)`
        : `NONE — refusal provider missing (key ${refusal.key}); eval-mentioning standalone modules stay ` +
          `unlinkable. Prebuild with: node scripts/build-runtime-eval-provider.mjs --refusal-only — ` +
          `selected via JS2WASM_EVAL_ENGINE=interpreter (kept native bytecode engine, #4242)`,
    };
  } catch (err) {
    return {
      module: null,
      engine: "none",
      message:
        `NONE — provider load failed: ${err?.message ?? err} — ` +
        `selected via JS2WASM_EVAL_ENGINE=interpreter (kept native bytecode engine, #4242)`,
    };
  }
}

/**
 * (#4238) Lazily load the quickjs engine module and make the selection.
 *
 * Loaded with `createRequire` rather than `await import()` on purpose: this
 * selector is SYNCHRONOUS for every existing caller, and a top-level `await`
 * anywhere in this file would turn it into an async module (and outright fail
 * wherever the toolchain transpiles these .mjs files to CJS). `require(esm)` is
 * supported natively on the Node versions this repo targets and keeps the load
 * both synchronous and lazy — with the flag unset this function is never
 * called, so `quickjs-eval-provider.mjs` is never even read from disk and no
 * quickjs cache path is stat'ed.
 */
function selectQuickjsEngine() {
  const require = createRequire(import.meta.url);
  const qjs = require("./quickjs-eval-provider.mjs");
  return qjs.selectQuickjsEvalProvider(
    defaultRuntimeEvalProviderCacheDir(),
    computeCompilerBundleHash(),
    runtimeEvalProviderCacheKey,
  );
}

/**
 * (#4238 slice 2) Load a `compile` for a provider PREBUILD script.
 *
 * Both prebuild scripts prefer a prebuilt `scripts/compiler-bundle.mjs` over
 * compiling the compiler from `src/` under tsx, because the bundle is an order
 * of magnitude faster to load. The hazard the `capability` hook exists for: a
 * bundle built BEFORE a compiler feature the provider source depends on is
 * still importable and still exports a working `compile`, so the build proceeds
 * and fails much later with a message that accuses the provider source. That
 * cost real hours on #4238 — a stale bundle made the quickjs adapter's
 * `wasm:memory` accessors fall back to `env::store8`, and the resulting error
 * ("an extern leaked outside the provider namespace") pointed squarely at the
 * adapter, which was fine.
 *
 * So: when `capability` is supplied, the bundle is probed BEFORE it is
 * accepted. A bundle that fails the probe is skipped (with a loud warning that
 * names the bundle as the suspect) and the source path is used instead; if the
 * source path is unavailable too, the thrown error names the bundle first. The
 * probe is deliberately the caller's business — this helper knows nothing about
 * which compile options matter to which provider.
 *
 * @param {{label?: string, capability?: (compile: Function) => Promise<string | null> | string | null}} [options]
 *   `capability` returns null when the compiler is usable, or a short reason
 *   string when it is not.
 */
export async function loadProviderCompiler(options = {}) {
  const label = options.label ?? "runtime-eval";
  const capability = options.capability;
  const notes = [];
  const candidates = [
    { specifier: "./compiler-bundle.mjs", origin: "compiler-bundle.mjs", isBundle: true },
    // Dev convenience: `node --import tsx scripts/build-…-provider.mjs`.
    { specifier: "../src/index.ts", origin: "src/index.ts (tsx)", isBundle: false },
  ];
  for (const candidate of candidates) {
    let compile;
    try {
      const loaded = await import(candidate.specifier);
      if (typeof loaded.compile !== "function") continue;
      compile = loaded.compile;
    } catch {
      continue;
    }
    if (capability) {
      let reason;
      try {
        reason = await capability(compile);
      } catch (err) {
        reason = `capability probe threw: ${err?.message ?? err}`;
      }
      if (reason) {
        notes.push(`${candidate.origin}: ${reason}`);
        console.warn(
          `[${label}] SKIPPING ${candidate.origin} — it does not support a compiler feature this provider ` +
            `needs (${reason}). This is the classic STALE-BUNDLE trap: rebuild scripts/compiler-bundle.mjs, ` +
            `or run under tsx. Falling back to the next compiler source.`,
        );
        continue;
      }
    }
    return { compile, origin: candidate.origin, notes };
  }
  throw new Error(
    `no usable compiler for the ${label} provider` +
      (notes.length > 0
        ? ` — every candidate was rejected by the capability probe (${notes.join("; ")}). ` +
          `A STALE scripts/compiler-bundle.mjs is the most likely cause: rebuild it, or run under tsx.`
        : ` — build scripts/compiler-bundle.mjs first, or run under tsx.`),
  );
}

/** Atomically (tmp + rename) publish a provider binary into the cache. */
export function writeCachedRuntimeEvalProvider(cacheDir, key, binary, pathOf = runtimeEvalProviderCachePath) {
  mkdirSync(cacheDir, { recursive: true });
  const path = pathOf(cacheDir, key);
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
  // (#4238) The quickjs engine hands a 2-module BUNDLE descriptor instead of a
  // single `WebAssembly.Module`; discriminate on the instance check so every
  // existing caller (6+ test files, the import-object harness, the prebuild
  // script) is untouched.
  if (!(providerModule instanceof WebAssembly.Module) && providerModule?.engine === "quickjs") {
    const require = createRequire(import.meta.url);
    return require("./quickjs-eval-provider.mjs").instantiateQuickjsEvalNamespace(providerModule);
  }
  const instance = new WebAssembly.Instance(providerModule, {});
  return {
    __runtime_new_function: instance.exports.__runtime_new_function,
    __runtime_indirect_eval: instance.exports.__runtime_indirect_eval,
    __runtime_direct_eval: instance.exports.__runtime_direct_eval,
    __runtime_apply_interpreted: instance.exports.__runtime_apply_interpreted,
  };
}
