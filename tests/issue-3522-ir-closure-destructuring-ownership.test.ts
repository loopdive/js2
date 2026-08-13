// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

const OBJECT_SOURCE = `
export function run(input: number): number {
  const offset = 3;
  const project = ({ x, y: renamed }: { x: number; y: number }): number => x * renamed + offset;
  return project({ x: input, y: 2 });
}
`;

const ARRAY_SOURCE = `
export function run(input: number): number {
  const project = ([first, , third]: number[]): number => first + third;
  return project([input, 10, 2]);
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

async function compilePrepared(source: string, target: (typeof TARGETS)[number]): Promise<CompileResult> {
  const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
  try {
    process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0";
    return await compile(source, {
      fileName: `closure-destructuring-prepared-${target}.ts`,
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
}

describe("#3522 closure destructuring ownership", () => {
  it.each(TARGETS)("prepares a flat inline-object closure parameter in the %s lane", async (target) => {
    const direct = await compile(OBJECT_SOURCE, {
      fileName: `closure-object-destructuring-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      emitWat: true,
      target,
    });
    const prepared = await compilePrepared(OBJECT_SOURCE, target);

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(20)).toBe(43);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
    expect(prepared.wat).toContain("struct.get");
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoNewImports(prepared, direct, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)("prepares a flat numeric-array closure parameter in the %s lane", async (target) => {
    const direct = await compile(ARRAY_SOURCE, {
      fileName: `closure-array-destructuring-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      emitWat: true,
      target,
    });
    const prepared = await compilePrepared(ARRAY_SOURCE, target);

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(42);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
    expect(prepared.wat).toContain("array.get");
    expect(prepared.wat).toContain("call_ref");
    expectNoNewImports(prepared, direct, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });
});
