// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

const SOURCE = `
export function run(input: number): number {
  const factorial = function recur(value: number): number {
    if (value <= 1) return 1;
    return value * recur(value - 1);
  };
  return factorial(input);
}
`;

const CAPTURED_SOURCE = `
export function run(input: number): number {
  const scale = 2;
  const factorial = function recur(value: number): number {
    if (value <= 1) return 1;
    return scale * value * recur(value - 1);
  };
  return factorial(input);
}
`;

function outcome(result: CompileResult): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName === "run");
  expect(observed).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

function importLabels(result: CompileResult): string[] {
  return result.imports.map((entry) => `${entry.module}::${entry.name}`).sort();
}

function expectNoNewImports(prepared: CompileResult, direct: CompileResult, target: (typeof TARGETS)[number]): void {
  const preparedImports = importLabels(prepared);
  const directImports = importLabels(direct);
  expect(preparedImports.filter((label) => !directImports.includes(label))).toEqual([]);
  expect(preparedImports.length).toBeLessThanOrEqual(directImports.length);
  if (target === "standalone") {
    expect(preparedImports).toEqual(directImports);
    expect(preparedImports).toEqual([]);
  }
}

describe("#3522 recursive closure ownership", () => {
  it.each(TARGETS)("prepares a named recursive function expression in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `recursive-closure-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      emitWat: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0";
      prepared = await compile(SOURCE, {
        fileName: `recursive-closure-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        optimize: true,
        emitWat: true,
        target,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(5)).toBe(120);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoNewImports(prepared, direct, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)("keeps the self binding separate from captured state in the %s lane", async (target) => {
    const direct = await compile(CAPTURED_SOURCE, {
      fileName: `recursive-captured-closure-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0";
      prepared = await compile(CAPTURED_SOURCE, {
        fileName: `recursive-captured-closure-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        optimize: true,
        target,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(5)).toBe(1_920);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
    expectNoNewImports(prepared, direct, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });
});
