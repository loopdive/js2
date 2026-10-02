// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6723 P0 — the linked-harness test262 oracle made correct on STANDALONE.
//
// D1  the default include-set could not build a standalone provider: exporting
//     `$262` keeps its `evalScript` direct eval live, so the provider imports
//     `js2wasm:runtime-eval`, which the package linker's provider allow-list
//     did not admit → bundled plan → `buildHarnessProvider` threw.
// D2  linked rows scored `verifyProperty is not defined`: the compile-timeout /
//     poison RETRY re-sent the body-only unit WITHOUT the linked descriptor, so
//     the body was compiled with no harness at all.
// D3  a fallback row compiled `prefix + bodySource`, which puts a strict
//     variant's directive after the harness (not a prologue) — the row ran
//     sloppy. The fallback now compiles the honest assembly the parent sends.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { CompilerPool } from "../scripts/compiler-pool.js";
import { assembleLinkedHarness, assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module, resetTest262RuntimeEvalProviderForTest } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6723-"));
let pool: CompilerPool | undefined;
afterAll(() => {
  pool?.shutdown();
  rmSync(CACHE, { recursive: true, force: true });
});

const STANDALONE = {
  allowJs: true,
  emitWat: false,
  skipSemanticDiagnostics: true,
  target: "standalone",
} as const;

const RUNTIME_EVAL = "js2wasm:runtime-eval";

function importModules(binary: Uint8Array): string[] {
  return [...new Set(WebAssembly.Module.imports(new WebAssembly.Module(binary)).map((entry) => entry.module))];
}

async function linkedStandalone(source: string) {
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await buildHarnessProvider({
    harnessPrefix: assembly.harnessPrefix,
    cacheDir: CACHE,
    compileOptions: STANDALONE,
  });
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...STANDALONE,
    fileName: "test.js",
    strict: assembly.primary.strict,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
  });
  return { provider, result };
}

describe("#6723 D1 — the default include-set builds a standalone provider", () => {
  it("links separately and the consumer reports no host imports", async () => {
    const { provider, result } = await linkedStandalone(`/*---\n---*/\nassert.sameValue(1, 1);\n`);
    expect(result.success).toBe(true);
    expect(result.imports ?? []).toEqual([]);
    // The consumer reaches the harness only through the provider namespace.
    expect(importModules(result.binary)).toEqual([provider.namespace]);
    // Why the allow-list had to move: the provider itself needs the eval ABI,
    // which the row supplies once and the provider inherits.
    expect(importModules(provider.artifact.binary)).toContain(RUNTIME_EVAL);
  }, 600_000);
});

describe("#6723 D2 — a linked standalone body sees the harness bindings", () => {
  it("runs verifyProperty + testWithTypedArrayConstructors through the provider", async () => {
    const source =
      `/*---\nincludes: [propertyHelper.js, testTypedArray.js]\n---*/\n` +
      `var seen = 0;\n` +
      // Binding visibility only. Using the provider's `TA` from the body
      // (`new TA(2).length`) is the separate cross-module intrinsics gap
      // recorded in the issue's P0 results, not D2.
      `testWithTypedArrayConstructors(function(TA) { seen++; });\n` +
      `assert(seen > 0, "constructors visited");\n` +
      `verifyProperty(TypedArray.prototype.findIndex, "name", {\n` +
      `  value: "findIndex", writable: false, enumerable: false, configurable: true\n});\n`;
    const { result } = await linkedStandalone(source);
    expect(result.success).toBe(true);
    expect(result.imports ?? []).toEqual([]);
    const importObject = buildImports(result.imports as never, { console }, result.stringPool as never) as Record<
      string,
      unknown
    >;
    // The provider imports the eval ABI; nothing in this body calls it, so a
    // refusing stub satisfies the link without a real eval engine.
    const refuse = () => {
      throw new Error("runtime-eval not available in this test");
    };
    importObject[RUNTIME_EVAL] = new Proxy({}, { get: () => refuse });
    // The shared seam WOULD attach the real engine because the provider
    // imports the namespace (the D1 wiring); keep this unit test independent
    // of a built eval engine by selecting none, so the stub above stands.
    const previous = process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER;
    process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER = "1";
    resetTest262RuntimeEvalProviderForTest();
    try {
      await expect(
        instantiateTest262Module(result.binary, importObject, {
          target: "standalone",
          linkedModules: result.linkedModules ?? [],
          runDeferredInit: true,
          linkedRuntime,
        }),
      ).resolves.toBeDefined();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "TEST262_DISABLE_RUNTIME_EVAL_PROVIDER");
      else process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER = previous;
      resetTest262RuntimeEvalProviderForTest();
    }
  }, 600_000);

  it("every retry of a linked row carries the linked descriptor", () => {
    const shared = readFileSync(join(import.meta.dirname, "test262-shared.ts"), "utf8");
    const retries = shared.split("runRetrySerial(() =>").slice(1);
    expect(retries.length).toBeGreaterThanOrEqual(2);
    for (const retry of retries) {
      const call = retry.slice(0, retry.indexOf("RETRY_TIMEOUT_MS"));
      expect(call).toContain("...linkedHarnessOpts");
    }
  });
});

describe("#6723 D3 — a forced fallback keeps the strict variant strict", () => {
  // An onlyStrict row that passes only when the body really runs strict (the
  // shape of `language/function-code/10.4.3-1-9gs.js`). No eval: the fork has
  // no runtime-eval provider here, and the defect is independent of it.
  const SOURCE = `/*---
description: this is undefined in a strict function
flags: [onlyStrict]
---*/

var probe = (function () { return this; })();
assert.sameValue(probe, undefined, "the body must run strict");
`;

  async function runForcedFallback(withHonestSource: boolean) {
    if (!pool) {
      // A regular FILE where the provider cache directory should be: the
      // provider build fails in the fork, so every linked row falls back.
      const blocker = join(CACHE, "not-a-directory");
      writeFileSync(blocker, "");
      const previous = process.env.JS2WASM_TEST262_HARNESS_CACHE;
      process.env.JS2WASM_TEST262_HARNESS_CACHE = blocker;
      try {
        pool = new CompilerPool(1, "unified");
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST262_HARNESS_CACHE");
        else process.env.JS2WASM_TEST262_HARNESS_CACHE = previous;
      }
      await pool.ready();
    }
    const meta = parseMeta(SOURCE);
    const honest = assembleOriginalHarness(SOURCE, meta);
    const linked = assembleLinkedHarness(SOURCE, meta);
    expect(linked.primary.strict).toBe(true);
    return await pool.runTest(
      linked.primary.bodySource,
      {
        originalHarness: true,
        target: "standalone",
        label: "#6723 D3 forced fallback",
        inferModuleStrictArguments: false,
        scriptGoal: true,
        linkedHarness: true,
        linkedHarnessPrefix: linked.harnessPrefix,
        linkedHarnessBody: linked.primary.body,
        linkedHarnessStrict: linked.primary.strict,
        ...(withHonestSource ? { linkedHarnessHonestSource: honest.primary.source } : {}),
      },
      120_000,
    );
  }

  it("compiles the honest assembly and passes", async () => {
    const result = (await runForcedFallback(true)) as { status: string; error?: string; linkedFallback?: boolean };
    expect(result.linkedFallback).toBe(true);
    expect(result.error ?? "").toBe("");
    expect(result.status).toBe("pass");
  }, 300_000);

  it("the pre-#6723 reconstruction (prefix + bodySource) runs the row sloppy", async () => {
    const result = (await runForcedFallback(false)) as { status: string; linkedFallback?: boolean };
    expect(result.linkedFallback).toBe(true);
    expect(result.status).toBe("fail");
  }, 300_000);
});
