// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

const SOURCE = `
export function run(): number {
  const Calculator = class {
    value: number;
    constructor(value: number) { this.value = value; }
    add(delta: number): number { return this.value + delta; }
    scale(factor: number): number { return this.value * factor; }
  };
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

describe("#3522 nested class-expression ownership", () => {
  it.each(TARGETS)("prepares an exact const-bound class expression atomically in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `nested-class-expression-direct-${target}.ts`,
      experimentalIR: false,
      emitWat: true,
      target,
    });
    const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "__anonClass_0_new,__anonClass_0_add,__anonClass_0_scale";
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
      prepared = await compile(SOURCE, {
        fileName: `nested-class-expression-prepared-${target}.ts`,
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
      outcome(prepared, "<anonymous-class>_new"),
      outcome(prepared, "<anonymous-class>_add"),
      outcome(prepared, "<anonymous-class>_scale"),
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
    for (const name of ["__anonClass_0_init", "__anonClass_0_add", "__anonClass_0_scale", "run"]) {
      expect(watFunctionBody(prepared.wat, name)).not.toMatch(
        /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.(?:test|cast)/,
      );
    }
    expect(watFunctionBody(prepared.wat, "__anonClass_0_init")).toContain("struct.set");
    expect(watFunctionBody(prepared.wat, "__anonClass_0_add")).toContain("struct.get");
    expect(watFunctionBody(prepared.wat, "__anonClass_0_scale")).toContain("struct.get");
  });

  it("withdraws the whole component when the class constructor binding is used as a first-class value", async () => {
    const result = await compile(
      `
      export function run(): number {
        const Calculator = class {
          value: number;
          constructor(value: number) { this.value = value; }
          read(): number { return this.value; }
        };
        return Calculator === Calculator ? 1 : 0;
      }
      `,
      { fileName: "nested-class-expression-value-fallback.ts", trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(1);
    for (const name of ["run", "<anonymous-class>_new", "<anonymous-class>_read"]) {
      expect(outcome(result, name)).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a same-named inner class identity on the exact binding", async () => {
    const result = await compile(
      `
      export function run(): number {
        const Calculator = class Calculator {
          value: number;
          constructor(value: number) { this.value = value; }
          read(): number { return this.value; }
        };
        return new Calculator(42).read();
      }
      `,
      { fileName: "nested-class-expression-same-name.ts", trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    for (const candidate of result.irOutcomes ?? []) {
      expect(candidate).toMatchObject({ kind: "emitted", legacyBodyEmitted: false, irBodyEmitted: true });
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("does not widen mutable or differently named class-expression bindings", async () => {
    for (const [fileName, declaration] of [
      ["mutable", "let Calculator = class"],
      ["different-inner-name", "const Calculator = class Inner"],
    ] as const) {
      const result = await compile(
        `
        export function run(): number {
          ${declaration} {
            value: number;
            constructor(value: number) { this.value = value; }
            read(): number { return this.value; }
          };
          return new Calculator(42).read();
        }
        `,
        { fileName: `nested-class-expression-${fileName}-fallback.ts`, trackIrOutcomes: true },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect((await instantiate(result)).run!()).toBe(42);
      expect(outcome(result, "run")).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    }
  });
});
