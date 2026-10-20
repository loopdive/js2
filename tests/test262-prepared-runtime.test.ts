// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler/test262-prepared-entry.js";
import {
  instantiatePreparedArtifact,
  preparedRuntimeExecutionObservation,
} from "../src/compiler/test262-prepared-runtime.js";

const source = "export function calculate(value: number): number { return value * 3 + 2; }";

async function artifact() {
  const result = await compile(source, {
    target: "gc",
    wholeProgram: { kind: "prepared-program-required", version: 1 },
    sourceMap: false,
    optimize: false,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.errors).toEqual([]);
  return result;
}

describe("Test262 same-artifact prepared execution", () => {
  it("executes the genuine prepared binary and reports only the same engine operands", async () => {
    const result = await artifact();
    const execution = instantiatePreparedArtifact(result);
    const calculate = execution.instance.exports.calculate as (value: number) => number;
    expect(calculate(7)).toBe(23);
    expect(calculate(11)).toBe(35);
    const observation = preparedRuntimeExecutionObservation(execution, result.binary, execution.imports);
    expect(observation?.actualRuntimeContext).toBe("GENUINE_FIXED_CONSTRUCTION_AND_INSTANCE");
    expect(observation?.actualBinary).toBe("MATCHED_ACTUAL_ENGINE_OPERAND");
    expect(observation?.actualImports).toBe("MATCHED_ACTUAL_ENGINE_OPERAND");
    expect(observation?.base.units.original.length).toBeGreaterThan(0);
    expect(observation?.base.units.emitted.length).toBeGreaterThan(0);
    expect(observation?.base.units.physical).toEqual(observation?.base.units.emitted);
    expect(preparedRuntimeExecutionObservation(execution, result.binary.slice(), execution.imports)).toBeUndefined();
    expect(preparedRuntimeExecutionObservation(execution, result.binary, { ...execution.imports })).toBeUndefined();
  });

  it("executes an authentic standalone artifact with the native target association", async () => {
    const result = await compile(source, {
      target: "standalone",
      wholeProgram: { kind: "prepared-program-required", version: 1 },
      sourceMap: false,
      optimize: false,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const execution = instantiatePreparedArtifact(result);
    const calculate = execution.instance.exports.calculate as (value: number) => number;
    expect(calculate(7)).toBe(23);
    const observed = preparedRuntimeExecutionObservation(execution, result.binary, execution.imports);
    expect(observed?.base.target).toBe("standalone");
    expect(observed?.base.backend).toBe("wasmgc");
    expect(observed?.actualRuntimeContext).toBe("GENUINE_FIXED_CONSTRUCTION_AND_INSTANCE");
  });

  it("does not accept a copied compiler result with identical bytes", async () => {
    const result = await artifact();
    expect(() => instantiatePreparedArtifact({ ...result })).toThrow(/genuine final compiler artifact/);
  });

  it("does not accept a copied or serialized execution product", async () => {
    const result = await artifact();
    const execution = instantiatePreparedArtifact(result);
    expect(preparedRuntimeExecutionObservation({ ...execution })).toBeUndefined();
    expect(preparedRuntimeExecutionObservation(JSON.parse(JSON.stringify(execution)))).toBeUndefined();
    expect(
      preparedRuntimeExecutionObservation({ instance: execution.instance, imports: execution.imports }),
    ).toBeUndefined();
  });

  it("invalidates evidence when the original result's bytes are changed after construction", async () => {
    const result = await artifact();
    const execution = instantiatePreparedArtifact(result);
    result.binary[0] ^= 1;
    expect(preparedRuntimeExecutionObservation(execution, result.binary, execution.imports)).toBeUndefined();
    expect(() => instantiatePreparedArtifact(result)).toThrow(/genuine final compiler artifact/);
  });

  it("does not expose instance/export rebinding functions through the engine imports", async () => {
    const result = await artifact();
    const execution = instantiatePreparedArtifact(result);
    expect(Object.isFrozen(execution.imports)).toBe(true);
    expect(Object.hasOwn(execution.imports, "setInstance")).toBe(false);
    expect(Object.hasOwn(execution.imports, "setExports")).toBe(false);
    expect(preparedRuntimeExecutionObservation(execution, result.binary, execution.imports)).toBeDefined();
  });

  it("rejects a foreign binary before reading caller-controlled byte getters", async () => {
    const result = await artifact();
    const execution = instantiatePreparedArtifact(result);
    const originalBinary = result.binary;
    let reads = 0;
    const foreign = new Proxy(Object.create(null), {
      get(_target, key) {
        reads++;
        result.binary = foreign as Uint8Array;
        return Reflect.get(originalBinary, key, originalBinary);
      },
    });
    expect(preparedRuntimeExecutionObservation(execution, foreign as Uint8Array, execution.imports)).toBeUndefined();
    expect(reads).toBe(0);
    expect(result.binary).toBe(originalBinary);
    expect(preparedRuntimeExecutionObservation(execution, originalBinary, execution.imports)).toBeDefined();
  });

  it("keeps emissions from different compilation transactions distinct", async () => {
    const first = await artifact();
    const second = await artifact();
    const execution = instantiatePreparedArtifact(first);
    expect(preparedRuntimeExecutionObservation(execution, second.binary, execution.imports)).toBeUndefined();
  });
});
