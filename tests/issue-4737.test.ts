// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4737 — the global eval value is callable but not constructable.
//
// The exact Test262 case is intentionally run on both lanes. Its source only
// probes the value through IsConstructor/Reflect.construct; it never executes
// dynamic eval, so standalone uses the repository's interpreter-refusal
// provider rather than requiring QuickJS.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import {
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  buildRuntimeEvalRefusalProviderSource,
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  readCachedRuntimeEvalProvider,
  runtimeEvalProviderCacheKey,
  runtimeEvalRefusalCachePath,
  writeCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";
import { instantiateTest262Module, resetTest262RuntimeEvalProviderForTest } from "../scripts/test262-import-object.mjs";
import { runTest262File } from "./test262-runner.js";

const TEST262_CASE = resolve("test262/test/built-ins/eval/not-a-constructor.js");
let previousEvalEngine: string | undefined;

async function ensureRefusalProviderCached(): Promise<void> {
  const source = buildRuntimeEvalRefusalProviderSource();
  const key = runtimeEvalProviderCacheKey(source, computeCompilerBundleHash());
  const cacheDir = defaultRuntimeEvalProviderCacheDir();
  if (readCachedRuntimeEvalProvider(cacheDir, key, runtimeEvalRefusalCachePath)) return;
  const result = await compile(source, RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS);
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  writeCachedRuntimeEvalProvider(cacheDir, key, result.binary!, runtimeEvalRefusalCachePath);
  resetTest262RuntimeEvalProviderForTest();
}

async function runStandalone(source: string): Promise<number> {
  await ensureRefusalProviderCached();
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-4737-controls.ts",
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const instance = await instantiateTest262Module(result.binary!, imports, {
    target: "standalone",
    providerLabel: "#4737",
  });
  return (instance.exports as Record<string, () => number>).test();
}

async function runHost(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-4737-host-controls.ts" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const instance = await instantiateTest262Module(result.binary!, imports);
  return (instance.exports as Record<string, () => number>).test();
}

beforeAll(async () => {
  previousEvalEngine = process.env.JS2WASM_EVAL_ENGINE;
  process.env.JS2WASM_EVAL_ENGINE = "interpreter";
  await ensureRefusalProviderCached();
}, 600_000);

afterAll(() => {
  if (previousEvalEngine === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EVAL_ENGINE");
  else process.env.JS2WASM_EVAL_ENGINE = previousEvalEngine;
  resetTest262RuntimeEvalProviderForTest();
});

describe("#4737 eval is not a constructor", () => {
  it("passes the exact Test262 case on the host lane", async () => {
    expect(existsSync(TEST262_CASE)).toBe(true);
    const result = await runTest262File(TEST262_CASE, "issue-4737-host", 60_000);
    expect(result?.status).toBe("pass");
  }, 120_000);

  it("passes the exact Test262 case standalone with the refusal provider", async () => {
    expect(existsSync(TEST262_CASE)).toBe(true);
    const result = await runTest262File(TEST262_CASE, "issue-4737-standalone", 60_000, "standalone");
    expect(result?.status).toBe("pass");
  }, 120_000);

  it("keeps Function and ordinary constructor controls constructable", async () => {
    const standaloneValue = await runStandalone(`
      function isConstructor(f: any): boolean {
        try { Reflect.construct(function () {}, [], f); } catch (e) { return false; }
        return true;
      }
      const ordinaryFunction: any = function () {};
      export function test(): number {
        const arrow: any = () => 1;
        return isConstructor(eval) === false &&
          isConstructor(ordinaryFunction) === true &&
          isConstructor(arrow) === false ? 1 : 0;
      }
    `);
    expect(standaloneValue).toBe(1);

    const hostFunctionValue = await runHost(`
      function isConstructor(f: any): boolean {
        try { Reflect.construct(function () {}, [], f); } catch (e) { return false; }
        return true;
      }
      export function test(): number {
        return isConstructor(Function) === true ? 1 : 0;
      }
    `);
    expect(hostFunctionValue).toBe(1);
  }, 120_000);
});
