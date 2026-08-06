// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4191) The in-process test262 runner must attach the standalone
 * `js2wasm:runtime-eval` provider namespace, exactly like the sharded CI lane.
 *
 * Without it, every `--target standalone` module that merely MENTIONS
 * `Function`/`eval` as a value — which the compiler's own pre-scan
 * (`sourceUsesRuntimeEvalBoundary`, src/codegen/index.ts) turns into a
 * module-level import of the linked runtime-eval carrier — fails at
 * `WebAssembly.instantiate` with
 *
 *     Import #0 module="js2wasm:runtime-eval": module is not an object …
 *
 * and that link error OVERWRITES the test's real failure signature. Three
 * separate triage lanes lost time to it before the seam was closed; the
 * measurement it corrupts is the ES5-standalone conformance census, where
 * `built-ins/Function/prototype` alone had 46 of 95 failures collapsed onto
 * this one bogus label.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { attachRuntimeEvalProvider } from "./test262-runner.js";
import {
  RUNTIME_EVAL_IMPORT_MODULE,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  buildRuntimeEvalRefusalProviderSource,
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  readCachedRuntimeEvalProvider,
  runtimeEvalProviderCacheKey,
  runtimeEvalRefusalCachePath,
  writeCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";

/** A standalone source whose compiled module imports the runtime-eval carrier. */
const EVAL_MENTIONING_SOURCE = "var g = Function; var z = 1;";

const COMPILE_OPTIONS = {
  target: "standalone" as const,
  fileName: "issue-4191.js",
  allowJs: true,
  deferTopLevelInit: true,
  skipSemanticDiagnostics: true,
  hostBridge: "always" as const,
};

/**
 * Put the REFUSAL-tier provider in the shared cache if it is not already
 * there. `selectCachedRuntimeEvalProvider` (which `attachRuntimeEvalProvider`
 * consults) reads that cache; a bare checkout has no provider at all, and the
 * point of this test is the attachment, not the cache-miss path.
 */
async function ensureRefusalProviderCached(): Promise<boolean> {
  const source = buildRuntimeEvalRefusalProviderSource();
  const key = runtimeEvalProviderCacheKey(source, computeCompilerBundleHash());
  const dir = defaultRuntimeEvalProviderCacheDir();
  if (readCachedRuntimeEvalProvider(dir, key, runtimeEvalRefusalCachePath)) return true;
  const built = await compile(source, { ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS, fileName: "refusal-provider.ts" });
  if (!built.success) return false;
  writeCachedRuntimeEvalProvider(dir, key, built.binary, runtimeEvalRefusalCachePath);
  return true;
}

async function compileStandalone(source: string) {
  const result = await compile(source, COMPILE_OPTIONS);
  expect(result.success).toBe(true);
  return result;
}

function importModules(binary: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(binary)).map((entry) => entry.module);
}

describe("#4191 in-process test262 runner attaches the runtime-eval provider", () => {
  it("compiles a Function-as-value standalone module to a runtime-eval IMPORT (premise)", async () => {
    const result = await compileStandalone(EVAL_MENTIONING_SOURCE);
    expect(importModules(result.binary)).toContain(RUNTIME_EVAL_IMPORT_MODULE);
  });

  it("without the provider namespace such a module CANNOT instantiate (the defect)", async () => {
    const result = await compileStandalone(EVAL_MENTIONING_SOURCE);
    const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
    await expect(WebAssembly.instantiate(result.binary, imports as never)).rejects.toThrow(/js2wasm:runtime-eval/);
  });

  it("attachRuntimeEvalProvider makes it instantiate on the standalone lane (the fix)", async () => {
    expect(await ensureRefusalProviderCached()).toBe(true);
    const result = await compileStandalone(EVAL_MENTIONING_SOURCE);
    const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
    const linked = attachRuntimeEvalProvider(result.binary, imports, "standalone");
    expect(typeof imports[RUNTIME_EVAL_IMPORT_MODULE]).toBe("object");
    const instance = await WebAssembly.instantiate(linked, imports as never);
    expect(instance).toBeInstanceOf(WebAssembly.Instance);
  });

  it("gives every module its OWN provider instance (interpreter globals never leak)", async () => {
    expect(await ensureRefusalProviderCached()).toBe(true);
    const result = await compileStandalone(EVAL_MENTIONING_SOURCE);
    const a = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
    const b = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
    attachRuntimeEvalProvider(result.binary, a, "standalone");
    attachRuntimeEvalProvider(result.binary, b, "standalone");
    expect(a[RUNTIME_EVAL_IMPORT_MODULE]).not.toBe(b[RUNTIME_EVAL_IMPORT_MODULE]);
  });

  it("leaves the JS-host lane untouched", async () => {
    const result = await compileStandalone(EVAL_MENTIONING_SOURCE);
    const imports: Record<string, unknown> = {};
    attachRuntimeEvalProvider(result.binary, imports, undefined);
    expect(Object.hasOwn(imports, RUNTIME_EVAL_IMPORT_MODULE)).toBe(false);
  });

  it("leaves a standalone module that does NOT ask for the carrier untouched", async () => {
    const result = await compileStandalone("var y = 1 + 1;");
    expect(importModules(result.binary)).not.toContain(RUNTIME_EVAL_IMPORT_MODULE);
    const imports: Record<string, unknown> = {};
    attachRuntimeEvalProvider(result.binary, imports, "standalone");
    expect(Object.hasOwn(imports, RUNTIME_EVAL_IMPORT_MODULE)).toBe(false);
  });
});
