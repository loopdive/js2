// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileProject, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const ENTRY = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/string.ts");
const CUTOVER = "JS2WASM_MULTI_PREPARED_STRING_CUTOVER";
const REQUIRE_ROUTE = "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_STRING_LEAF";
const TAMPER = "JS2WASM_TEST_TAMPER_MULTI_PREPARED_STRING_LEAF";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const STRING_BUILDER = "JS2WASM_IR_STRING_BUILDER";
const TARGET = "bench_string";

const TAMPER_PHASES = [
  "support",
  "preparation-receipt",
  "skip-report",
  "post-direct-currentness",
  "post-merge-receipt",
] as const;

function targetLegacyRows(result: CompileResult) {
  return result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === TARGET) ?? [];
}

function nonTargetLegacyRows(result: CompileResult) {
  return result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName !== TARGET) ?? [];
}

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);
}

function targetOutcome(result: CompileResult) {
  return result.irOutcomes?.find((outcome) => outcome.displayName === TARGET);
}

async function compileBenchString(options: { optimize?: 4 } = {}): Promise<CompileResult> {
  return compileProject(ENTRY, {
    experimentalIR: true,
    target: "standalone",
    trackIrOutcomes: true,
    emitWat: true,
    emitWatOnlyFunctions: [TARGET, "__ir_string_repeat_native", "__str_repeat"],
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

function watFunction(wat: string, name: string): string {
  const sameLine = wat.indexOf(`(func $${name} `);
  const start = sameLine >= 0 ? sameLine : wat.indexOf(`(func $${name}\n`);
  if (start < 0) throw new Error(`missing WAT function ${name}`);
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated WAT function ${name}`);
}

function watOpCount(body: string, op: string): number {
  return body.split("\n").filter((line) => line.trimStart().startsWith(op)).length;
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
    const prepared = await compileBenchString();

    expectSuccess(prepared);
    expect(targetLegacyRows(prepared)).toEqual([]);
    expect(targetOutcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });

    vi.stubEnv(CUTOVER, "0");
    vi.stubEnv(DIRECT_POISON, "");
    const routeOff = await compileBenchString();

    expectSuccess(routeOff);
    expect(
      targetLegacyRows(routeOff)
        .map((row) => row.entryPoint)
        .sort(),
    ).toEqual(["compileFunctionBody", "compileStatement"]);
    expect(targetOutcome(routeOff)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect(prepared.dts).toBe(routeOff.dts);
    expect(prepared.imports).toEqual(routeOff.imports);
    expect(new Set(prepared.stringPool)).toEqual(new Set(routeOff.stringPool));
    expect(wasmSurface(prepared.binary)).toEqual(wasmSurface(routeOff.binary));
    await expect(benchStringRuntime(prepared)).resolves.toBe(5000);
    await expect(benchStringRuntime(routeOff)).resolves.toBe(5000);

    vi.stubEnv(DIRECT_POISON, TARGET);
    const poisonedDirect = await compileBenchString();
    expect(poisonedDirect.success).toBe(false);
    expect(poisonedDirect.errors.map((error) => error.message).join("\n")).toContain(
      `injected direct function-body poison: ${TARGET}`,
    );
  });

  it("keeps builder-off as the true direct artifact for raw and optimized A/Bs", async () => {
    vi.stubEnv(REQUIRE_ROUTE, "1");
    const prepared = await compileBenchString();
    expectSuccess(prepared);

    vi.stubEnv(REQUIRE_ROUTE, "0");
    vi.stubEnv(STRING_BUILDER, "0");
    const direct = await compileBenchString();

    expectSuccess(direct);
    expect(
      targetLegacyRows(direct)
        .map((row) => row.entryPoint)
        .sort(),
    ).toEqual(["compileFunctionBody", "compileStatement"]);
    expect(targetOutcome(direct)).toMatchObject({
      kind: "unsupported",
      code: "string-builder-candidate",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(targetOutcome(prepared)?.unitId).toBe(targetOutcome(direct)?.unitId);
    expect(nonTargetLegacyRows(prepared)).toEqual(nonTargetLegacyRows(direct));
    expect(prepared.dts).toBe(direct.dts);
    expect(prepared.imports).toEqual(direct.imports);
    expect(new Set(prepared.stringPool)).toEqual(new Set(direct.stringPool));
    expect(wasmSurface(prepared.binary)).toEqual(wasmSurface(direct.binary));
    expect(prepared.binary.length).toBeLessThanOrEqual(direct.binary.length);
    expect(prepared.wat).not.toContain("(func $__ir_string_repeat_native");
    expect(prepared.wat).toContain("(func $__str_repeat");
    const preparedTarget = watFunction(prepared.wat, TARGET);
    const directTarget = watFunction(direct.wat, TARGET);
    expect(preparedTarget).toContain("i32.trunc_f64_s");
    expect(preparedTarget).not.toContain("i32.trunc_sat_f64_s");
    expect(watOpCount(preparedTarget, "call ")).toBeLessThanOrEqual(watOpCount(directTarget, "call "));
    expect(watOpCount(preparedTarget, "array.new")).toBeLessThanOrEqual(watOpCount(directTarget, "array.new"));
    expect(watOpCount(preparedTarget, "struct.new")).toBeLessThanOrEqual(watOpCount(directTarget, "struct.new"));
    await expect(benchStringRuntime(prepared)).resolves.toBe(5000);
    await expect(benchStringRuntime(direct)).resolves.toBe(5000);

    vi.stubEnv(STRING_BUILDER, "1");
    vi.stubEnv(REQUIRE_ROUTE, "1");
    const optimizedPrepared = await compileBenchString({ optimize: 4 });
    expectSuccess(optimizedPrepared);

    vi.stubEnv(STRING_BUILDER, "0");
    vi.stubEnv(REQUIRE_ROUTE, "0");
    const optimizedDirect = await compileBenchString({ optimize: 4 });
    expectSuccess(optimizedDirect);
    expect(wasmSurface(optimizedPrepared.binary)).toEqual(wasmSurface(optimizedDirect.binary));
    expect(optimizedPrepared.binary.length).toBeLessThanOrEqual(optimizedDirect.binary.length);
    await expect(benchStringRuntime(optimizedPrepared)).resolves.toBe(5000);
    await expect(benchStringRuntime(optimizedDirect)).resolves.toBe(5000);

    vi.stubEnv(DIRECT_POISON, TARGET);
    const poisoned = await compileBenchString();
    expect(poisoned.success).toBe(false);
    expect(poisoned.errors.map((error) => error.message).join("\n")).toContain(
      `injected direct function-body poison: ${TARGET}`,
    );
  });

  it("fails closed for every post-certification tamper phase and an unmatched UnitId", async () => {
    vi.stubEnv(REQUIRE_ROUTE, "1");
    const control = await compileBenchString();
    expectSuccess(control);
    const unitId = targetOutcome(control)?.unitId;
    expect(unitId).toBeTruthy();
    vi.stubEnv(DIRECT_POISON, TARGET);

    for (const phase of TAMPER_PHASES) {
      vi.stubEnv(TAMPER, JSON.stringify({ unitId, phase }));
      const result = await compileBenchString();
      expect(result.success, `${phase} unexpectedly compiled`).toBe(false);
      expect(targetLegacyRows(result), `${phase} retried the target direct body`).toEqual([]);
      const diagnostics = result.errors.map((error) => error.message).join("\n");
      expect(diagnostics, phase).toMatch(/multi-source string leaf|string route|route string|body skip/i);
      expect(diagnostics, `${phase} reached the direct-body poison`).not.toContain(
        `injected direct function-body poison: ${TARGET}`,
      );
    }

    vi.stubEnv(TAMPER, JSON.stringify({ unitId: `${unitId}:foreign`, phase: "support" }));
    const unmatched = await compileBenchString();
    expect(unmatched.success).toBe(false);
    expect(unmatched.errors.map((error) => error.message).join("\n")).toContain(
      "test tamper selector did not match exact route",
    );
    expect(unmatched.errors.map((error) => error.message).join("\n")).not.toContain(
      `injected direct function-body poison: ${TARGET}`,
    );
    expect(targetLegacyRows(unmatched)).toEqual([]);
  });
});
