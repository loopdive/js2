// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2928 E7 — the REFUSAL runtime-eval provider.
 *
 * `js2wasm:runtime-eval` is a MODULE-LEVEL import. A standalone module that
 * merely MENTIONS dynamic `new Function` / indirect eval therefore carries the
 * import, and with no namespace supplied it cannot even instantiate:
 *
 *     TypeError: WebAssembly.Instance(): Import #0 "js2wasm:runtime-eval":
 *                module is not an object or function
 *
 * Every assertion in such a file is then lost — including the majority that
 * never reach the dynamic call at all, because §20.2.1.1.1 ToString-coerces the
 * constructor arguments AOT at the call site (see
 * emitStandaloneDynamicFunctionRuntime). 361 files in the published standalone
 * baseline die exactly this way.
 *
 * The refusal provider is a js2wasm-compiled, ZERO-IMPORT core-Wasm module with
 * the same `[ok, value]` envelope ABI as the real Acorn+interpreter provider and
 * no capability whatsoever. Linking it restores the honest #2960 Tier-3
 * behaviour: the file runs, and only the dynamic-code call itself throws a
 * typed, catchable TypeError. It compiles in seconds, which is what makes it
 * affordable in every CI standalone shard (the real provider takes minutes).
 *
 * These assertions are the ones that must not rot: the unlinked failure is real
 * (a control, so the fix is not proving something that already worked), the
 * refusal module has no imports (no smuggled host capability), and the
 * non-eval-dependent code path produces its REAL value rather than merely
 * "not crashing".
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  RUNTIME_EVAL_IMPORT_MODULE,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  RUNTIME_EVAL_REFUSAL_CANARY_EXPECTED,
  RUNTIME_EVAL_REFUSAL_CANARY_SOURCE,
  buildRuntimeEvalRefusalProviderSource,
  instantiateRuntimeEvalNamespace,
  runtimeEvalProviderCacheKey,
  runtimeEvalRefusalCachePath,
} from "../scripts/runtime-eval-provider.mjs";

// The compiled probes export plain Wasm functions; `WebAssembly.Exports` is
// typed as `any` at the boundary anyway.
type AnyExports = Record<string, () => number>;

async function compileStandalone(source: string, fileName: string): Promise<Uint8Array> {
  const result = await compile(source, { ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS, fileName });
  if (!result.success || !result.binary) {
    throw new Error(`compile failed for ${fileName}: ${JSON.stringify((result.errors ?? []).slice(0, 3))}`);
  }
  return result.binary;
}

describe("#2928 E7 — refusal runtime-eval provider", () => {
  it("keeps a distinct cache path from the real provider", () => {
    const key = runtimeEvalProviderCacheKey(buildRuntimeEvalRefusalProviderSource(), "bundle");
    expect(runtimeEvalRefusalCachePath("/cache", key)).toBe(`/cache/runtime-eval-refusal-${key}.wasm`);
    // Distinct SOURCE ⇒ distinct key ⇒ the two tiers can coexist in one cache
    // dir and a stale one can never be served for the other.
    expect(key).not.toBe(runtimeEvalProviderCacheKey("something-else", "bundle"));
  });

  it(
    "makes an eval-mentioning standalone module instantiable, and only the dynamic call throws",
    { timeout: 600_000 },
    async () => {
      const refusalBinary = await compileStandalone(buildRuntimeEvalRefusalProviderSource(), "runtime-eval-refusal.ts");
      const refusalModule = new WebAssembly.Module(refusalBinary);
      // No host capability smuggled in: this is core Wasm, produced by the
      // same compiler under test, with nothing to import.
      expect(WebAssembly.Module.imports(refusalModule)).toEqual([]);
      expect(WebAssembly.Module.exports(refusalModule).map((e) => e.name)).toEqual(
        expect.arrayContaining([
          "__runtime_new_function",
          "__runtime_indirect_eval",
          "__runtime_direct_eval",
          "__runtime_apply_interpreted",
        ]),
      );

      // A file shaped like test262's built-ins/Function/S15.3.2.1_A1_T1.js: the
      // body argument's `toString` throws, so §20.2.1.1.1 argument coercion
      // throws BEFORE the provider is ever consulted. Nothing about this test
      // needs a working interpreter — only an instantiable module.
      const userBinary = await compileStandalone(
        `
          var body = { toString: function () { throw 7; } };
          var caught = 0;
          try {
            var fn = new Function(body);
            caught = -1;
          } catch (err) {
            caught = err;
          }
          export function probe(): number { return caught; }
        `,
        "refusal-user.ts",
      );
      const userModule = new WebAssembly.Module(userBinary);
      expect(WebAssembly.Module.imports(userModule)).toEqual([
        { module: RUNTIME_EVAL_IMPORT_MODULE, name: "__runtime_apply_interpreted", kind: "function" },
        { module: RUNTIME_EVAL_IMPORT_MODULE, name: "__runtime_new_function", kind: "function" },
      ]);

      // CONTROL — the failure this change targets must actually be present.
      expect(() => new WebAssembly.Instance(userModule, {})).toThrow(/js2wasm:runtime-eval/);

      const instance = new WebAssembly.Instance(userModule, {
        [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(refusalModule),
      });
      // The REAL value, not just "did not crash": ToString threw 7.
      expect((instance.exports as AnyExports).probe()).toBe(7);

      // Merely making dynamic direct eval available turns every potentially
      // replaceable script function into a live binding. Calling an untouched
      // four-formal function with three arguments must still reach its original
      // AOT closure through the runtime-eval callable adapter. This is the
      // propertyHelper.js `verifyProperty(obj, name, desc, options)` shape used
      // by the standalone Test262 lane.
      const liveFunctionBinary = await compileStandalone(
        `
          interface Options { label?: boolean; restore?: boolean }
          function verify(a: any, b: any, c: any, options?: Options) {
            return arguments.length + (options && options.restore ? 10 : 0);
          }
          function dynamic(source: string) {
            return eval(source);
          }
          export function probe(): number {
            return verify(1, 2, 3) * 100 + verify(1, 2, 3, { restore: true });
          }
        `,
        "runtime-eval-live-function.ts",
      );
      const liveFunctionModule = new WebAssembly.Module(liveFunctionBinary);
      const liveFunctionInstance = new WebAssembly.Instance(liveFunctionModule, {
        [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(refusalModule),
      });
      // 3 actual arguments in the omitted case; 4 actual arguments plus the
      // supplied object's visible `restore` property in the second case.
      expect((liveFunctionInstance.exports as AnyExports).probe()).toBe(314);

      // And a call that DOES reach the provider still refuses — as a catchable
      // TypeError carrying the refusal message, never a silent value.
      const canaryBinary = await compileStandalone(
        RUNTIME_EVAL_REFUSAL_CANARY_SOURCE,
        "runtime-eval-refusal-canary.ts",
      );
      const canaryModule = new WebAssembly.Module(canaryBinary);
      expect(WebAssembly.Module.imports(canaryModule).map((i) => i.module)).toContain(RUNTIME_EVAL_IMPORT_MODULE);
      const canaryInstance = new WebAssembly.Instance(canaryModule, {
        [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(refusalModule),
      });
      expect((canaryInstance.exports as AnyExports).probe()).toBe(RUNTIME_EVAL_REFUSAL_CANARY_EXPECTED);
    },
  );
});
