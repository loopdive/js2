// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi, afterEach } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { generateMultiModule } from "../src/codegen/index.js";
import { compileMulti } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

import "../src/codegen/expressions.js";

afterEach(() => vi.unstubAllEnvs());

describe("#3525 M2 prepared multi-source module-init", () => {
  it("owns the contributor's exact unit and never enters compileModuleInitBody", async () => {
    const files = {
      "./dep.ts": `let value: number = 40; value = value + 2; export { value };`,
      "./entry.ts": `import { value } from "./dep"; export function read(): number { return value; }`,
    };
    const options = {
      experimentalIR: true,
      nativeStrings: true,
      target: "standalone" as const,
      trackIrOutcomes: true,
    };
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");

    const generated = generateMultiModule(analyzeMultiSource(files, "./entry.ts"), options);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    expect(generated.multiPreparedProgramAudit?.moduleInit).toMatchObject({
      executablePlanCount: 1,
      emptyPlanCount: 1,
      directCompileModuleInitBodyRoots: 0,
      irBodyEmissions: 1,
      invocationKind: "wasm-start",
    });
    expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations).toHaveLength(1);
    expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations[0]?.routeKind).toBe("module-init");

    const result = await compileMulti(files, "./entry.ts", options);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(
      result.irBodyRouteAudit?.legacyEntries.filter((entry) => entry.entryPoint === "compileModuleInitBody"),
    ).toEqual([]);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.read as () => number)()).toBe(42);

    // The exact gate is a real kill switch: with it off, the poison must
    // reach the legacy module-init root and fail the compile.
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "0");
    const killed = await compileMulti(files, "./entry.ts", options);
    expect(killed.success).toBe(false);
    expect(killed.errors.map((error) => error.message).join("\n")).toContain("injected direct module-init body poison");
  });
});
