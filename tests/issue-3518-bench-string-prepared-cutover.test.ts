// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileProject, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const ENTRY = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/string.ts");
const CUTOVER = "JS2WASM_MULTI_PREPARED_STRING_CUTOVER";
const REQUIRE_ROUTE = "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_STRING_LEAF";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const TARGET = "bench_string";

function targetLegacyRows(result: CompileResult) {
  return result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === TARGET) ?? [];
}

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);
}

function wasmSurface(binary: Uint8Array) {
  const module = new WebAssembly.Module(binary);
  return {
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
  };
}

async function benchStringRuntime(result: CompileResult): Promise<number> {
  const instance = await instantiateWithRuntime(result);
  return (instance.exports.bench_string as () => number)();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#3518 bench_string Prepared C2 cutover", () => {
  it("bypasses exactly the target's two direct body entries", async () => {
    vi.stubEnv(REQUIRE_ROUTE, "1");
    vi.stubEnv(DIRECT_POISON, TARGET);
    const prepared = await compileProject(ENTRY, {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });

    expectSuccess(prepared);
    expect(targetLegacyRows(prepared)).toEqual([]);
    expect(prepared.irOutcomes?.find((outcome) => outcome.displayName === TARGET)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });

    vi.stubEnv(CUTOVER, "0");
    vi.stubEnv(DIRECT_POISON, "");
    const direct = await compileProject(ENTRY, {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });

    expectSuccess(direct);
    expect(
      targetLegacyRows(direct)
        .map((row) => row.entryPoint)
        .sort(),
    ).toEqual(["compileFunctionBody", "compileStatement"]);
    expect(direct.irOutcomes?.find((outcome) => outcome.displayName === TARGET)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect(prepared.dts).toBe(direct.dts);
    expect(prepared.imports).toEqual(direct.imports);
    expect(new Set(prepared.stringPool)).toEqual(new Set(direct.stringPool));
    expect(wasmSurface(prepared.binary)).toEqual(wasmSurface(direct.binary));
    await expect(benchStringRuntime(prepared)).resolves.toBe(5000);
    await expect(benchStringRuntime(direct)).resolves.toBe(5000);

    vi.stubEnv(DIRECT_POISON, TARGET);
    const poisonedDirect = await compileProject(ENTRY, {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(poisonedDirect.success).toBe(false);
    expect(poisonedDirect.errors.map((error) => error.message).join("\n")).toContain(
      `injected direct function-body poison: ${TARGET}`,
    );
  });
});
