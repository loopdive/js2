// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

const SOURCE = `
export function run(): number {
  class Calculator {
    value: number;
    constructor(value: number) { this.value = value; }
    add(delta: number): number { return this.value + delta; }
    scale(factor: number): number { return this.value * factor; }
  }
  const calculator = new Calculator(5);
  return calculator.add(2) * 100 + calculator.scale(3);
}
`;

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName.startsWith(name));
  expect(observed, `terminal outcome count for ${name}`).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

function watFunctionBody(wat: string, name: string): string {
  const start = wat.indexOf(`  (func $${name}`);
  expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? wat.length : next);
}

describe("#3522 nested ordinary class ownership", () => {
  it.each(TARGETS)("prepares the enclosing function, constructor, and methods once in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `nested-class-direct-${target}.ts`,
      experimentalIR: false,
      emitWat: true,
      target,
    });
    const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Calculator_new,Calculator_add,Calculator_scale";
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
      prepared = await compile(SOURCE, {
        fileName: `nested-class-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
        target,
      });
    } finally {
      if (previousClassPoison === undefined)
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClassPoison;
      if (previousFunctionPoison === undefined)
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunctionPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!()).toBe(715);
    }
    const observed = [
      outcome(prepared, "run"),
      outcome(prepared, "Calculator_new"),
      outcome(prepared, "Calculator_add"),
      outcome(prepared, "Calculator_scale"),
    ];
    expect(new Set(observed.map((candidate) => candidate.preparedComponentId)).size).toBe(1);
    for (const candidate of observed) {
      expect(candidate).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    }
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    for (const name of ["Calculator_init", "Calculator_add", "Calculator_scale", "run"]) {
      expect(watFunctionBody(prepared.wat, name)).not.toMatch(
        /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.(?:test|cast)/,
      );
    }
    expect(watFunctionBody(prepared.wat, "Calculator_init")).toContain("struct.set");
    expect(watFunctionBody(prepared.wat, "Calculator_add")).toContain("struct.get");
    expect(watFunctionBody(prepared.wat, "Calculator_scale")).toContain("struct.get");
  });

  it("withdraws the complete nested class component when one body captures its enclosing frame", async () => {
    const result = await compile(
      `
      export function run(): number {
        let offset: number = 1;
        class Calculator {
          value: number;
          constructor(value: number) { this.value = value + offset; }
          scale(factor: number): number { return this.value * factor; }
        }
        return new Calculator(20).scale(2);
      }
      `,
      { fileName: "nested-class-capture-fallback.ts", trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    for (const name of ["run", "Calculator_new", "Calculator_scale"]) {
      expect(outcome(result, name)).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
