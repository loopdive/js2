// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

const SOURCE = `
export function run(input: number): number {
  const offset: number = 2;
  const operations = {
    add(value: number): number { return value + offset; },
    positive(value: number): boolean { return value > 0; }
  };
  return operations.add(input) + (operations.positive(input) ? 1 : 0);
}
`;

const METHOD_VALUE_SOURCE = `
export function run(input: number): number {
  const offset: number = 2;
  const operations = {
    add(value: number): number { return value + offset; }
  };
  const add = operations.add;
  return add(input);
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

describe("#3522 object-method call ownership", () => {
  it.each(TARGETS)("prepares parameterized direct object-method calls in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `object-method-call-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
      prepared = await compile(SOURCE, {
        fileName: `object-method-call-prepared-${target}.ts`,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(43);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0", "run__closure_1"]));
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)("prepares an exact object-method value call in the %s lane", async (target) => {
    const direct = await compile(METHOD_VALUE_SOURCE, {
      fileName: `object-method-value-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
      prepared = await compile(METHOD_VALUE_SOURCE, {
        fileName: `object-method-value-prepared-${target}.ts`,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

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
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it("keeps mutable object-method value aliases on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        let add = operations.add;
        return add(input);
      }`,
      {
        fileName: "object-method-value-let-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "call-resolution-unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps receiver-sensitive object methods on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return this.double(value) + 2; },
          double(value: number): number { return value * 2; }
        };
        return operations.add(input);
      }`,
      {
        fileName: "object-method-call-this-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(20)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps mixed method/data objects on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          offset: 2,
          add(value: number): number { return value + 2; }
        };
        return operations.add(input) + operations.offset;
      }`,
      {
        fileName: "object-method-call-mixed-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(38)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
