// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compileMulti, compileProject, type CompileOptions, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const ENTRY = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/array.ts");
const HELPERS = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/helpers.ts");
const ARRAY_SOURCE = readFileSync(ENTRY, "utf8");
const HELPERS_SOURCE = readFileSync(HELPERS, "utf8");

const CUTOVER = "JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const REQUIRE_ROUTE = "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_ARRAY_LEAF";
const TAMPER = "JS2WASM_TEST_TAMPER_MULTI_PREPARED_ARRAY_LEAF";
const EXPECTED_RUNTIME = 49_995_000;

function expectSuccess(result: CompileResult, label: string): void {
  expect(
    result.success,
    `${label} failed:\n${result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")}`,
  ).toBe(true);
}

async function compileArray(cutover: boolean | undefined, options: CompileOptions = {}): Promise<CompileResult> {
  if (cutover !== undefined) vi.stubEnv(CUTOVER, cutover ? "1" : "0");
  return compileProject(ENTRY, {
    experimentalIR: true,
    target: "standalone",
    trackIrOutcomes: true,
    emitWat: true,
    ...options,
  });
}

function wasmSurface(binary: Uint8Array) {
  const module = new WebAssembly.Module(binary);
  return {
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
  };
}

function targetLegacyRows(result: CompileResult) {
  return result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "bench_array") ?? [];
}

function targetOutcome(result: CompileResult) {
  return result.irOutcomes?.find((outcome) => outcome.displayName === "bench_array");
}

function expectDirectPoison(result: CompileResult): void {
  expect(result.success).toBe(false);
  expect(result.errors.map((error) => error.message).join("\n")).toContain(
    "injected direct function-body poison: bench_array",
  );
  expect(targetLegacyRows(result).map((row) => row.entryPoint)).toContain("compileFunctionBody");
}

async function arrayRuntime(result: CompileResult): Promise<number> {
  const instance = await instantiateWithRuntime(result);
  return (instance.exports.bench_array as () => number)();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#3518 prepared bench_array cutover", () => {
  it("is default-on, bypasses the poisoned direct body, and restores it with the kill switch", async () => {
    vi.stubEnv(REQUIRE_ROUTE, "1");
    vi.stubEnv(DIRECT_POISON, "bench_array");
    const prepared = await compileArray(undefined);
    expectSuccess(prepared, "default-on Prepared array compile");
    expect(targetLegacyRows(prepared)).toEqual([]);
    const outcome = targetOutcome(prepared);
    expect(outcome).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irBodyRouteAudit?.dispositions.find((row) => row.unitId === outcome?.unitId)?.disposition).toBe(
      "terminal-ir",
    );

    vi.stubEnv(CUTOVER, "0");
    const direct = await compileArray(false);
    expectDirectPoison(direct);
    expect(targetLegacyRows(direct).map((row) => row.entryPoint)).toEqual(["compileFunctionBody"]);
  });

  it("preserves the external surface and runtime value across the Prepared/direct lanes", async () => {
    const prepared = await compileArray(true);
    const direct = await compileArray(false);
    expectSuccess(prepared, "Prepared array compile");
    expectSuccess(direct, "direct array control");

    expect(targetLegacyRows(prepared)).toEqual([]);
    expect(
      targetLegacyRows(direct)
        .map((row) => row.entryPoint)
        .sort(),
    ).toEqual(["compileFunctionBody", "compileStatement"]);
    expect(targetOutcome(prepared)).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(targetOutcome(direct)).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: true,
    });
    expect(targetOutcome(prepared)?.unitId).toBe(targetOutcome(direct)?.unitId);
    expect(direct.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName !== "bench_array")).toEqual(
      prepared.irBodyRouteAudit?.legacyEntries,
    );

    expect(prepared.dts).toBe(direct.dts);
    expect(prepared.importsHelper).toBe(direct.importsHelper);
    expect(prepared.imports).toEqual(direct.imports);
    expect(prepared.stringPool).toEqual(direct.stringPool);
    expect(wasmSurface(prepared.binary)).toEqual(wasmSurface(direct.binary));
    await expect(arrayRuntime(prepared)).resolves.toBe(EXPECTED_RUNTIME);
    await expect(arrayRuntime(direct)).resolves.toBe(EXPECTED_RUNTIME);
  });

  it("fails closed when the certified Prepared body drifts", async () => {
    vi.stubEnv(REQUIRE_ROUTE, "1");
    vi.stubEnv(TAMPER, "bench_array");
    const result = await compileArray(true);
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("drifted after certification");
    expect(targetLegacyRows(result)).toEqual([]);
  });

  it("keeps an exact-shape mutation on the direct path", async () => {
    vi.stubEnv(CUTOVER, "1");
    vi.stubEnv(DIRECT_POISON, "bench_array");
    const mutated = ARRAY_SOURCE.replace("i < 10000", "i <= 10000");
    expect(mutated).not.toBe(ARRAY_SOURCE);
    const result = await compileMulti({ "helpers.ts": HELPERS_SOURCE, "array.ts": mutated }, "array.ts", {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectDirectPoison(result);
  });

  it("keeps the array leaf direct-owned outside the standalone Prepared lane", async () => {
    vi.stubEnv(DIRECT_POISON, "bench_array");
    expectDirectPoison(await compileArray(true, { fast: true }));
  });
});
