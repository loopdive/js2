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

const OWNER_AWARE_CALL_SOURCE = `
function seed(value: number): number { return value + 1; }
export function run(): number {
  class Calculator {
    value: number;
    constructor(value: number) { this.value = seed(value); }
    add(delta: number): number { return seed(this.value + delta); }
  }
  return new Calculator(39).add(1);
}
`;

const ADMITTED_FIELD_CALL_SOURCE = `
function seed(value: number): number { return value + 2; }
export function run(): number {
  class Box {
    value = seed(40);
    read(): number { return this.value; }
  }
  return new Box().read();
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

  it.each(TARGETS)("keeps nested constructor and method calls on their exact owners in the %s lane", async (target) => {
    const direct = await compile(OWNER_AWARE_CALL_SOURCE, {
      fileName: `nested-owner-call-direct-${target}.ts`,
      experimentalIR: false,
      target,
    });
    const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Calculator_new,Calculator_add";
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "seed,run";
      prepared = await compile(OWNER_AWARE_CALL_SOURCE, {
        fileName: `nested-owner-call-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
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
      expect((await instantiate(compiled)).run!()).toBe(42);
    }
    const seedOutcome = outcome(prepared, "seed");
    const ownerOutcomes = [
      outcome(prepared, "run"),
      outcome(prepared, "Calculator_new"),
      outcome(prepared, "Calculator_add"),
    ];
    const observed = [seedOutcome, ...ownerOutcomes];
    expect(new Set(ownerOutcomes.map((candidate) => candidate.preparedComponentId)).size).toBe(1);
    expect(seedOutcome.preparedComponentId).not.toBe(ownerOutcomes[0]!.preparedComponentId);
    for (const candidate of observed) {
      expect(candidate).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    }
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(TARGETS)("prepares the call-bearing nested field family once in the %s lane (#3522 F4)", async (target) => {
    // Pinned CLOSED until #3522 F4. Measured on `origin/main` 81e54a98e this
    // shape reported `run`/`Box_new`/`Box_read` as
    // `class-member-unsupported@select`; F4 validates the F3 proof, derives
    // the one admitted-class marker before selection, and the whole family
    // now compiles once. `seed` keeps its own single-unit component.
    const fileName = `nested-field-call-${target}.ts`;
    const direct = await compile(ADMITTED_FIELD_CALL_SOURCE, {
      fileName,
      experimentalIR: false,
      target,
    });
    const preparedControl = await compile(ADMITTED_FIELD_CALL_SOURCE, {
      fileName,
      experimentalIR: true,
      target,
    });
    const preparedObserved = await compile(ADMITTED_FIELD_CALL_SOURCE, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      target,
    });

    for (const compiled of [direct, preparedControl, preparedObserved]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!()).toBe(42);
    }
    // Outcome TRACKING must still be observation-only.
    expect(Array.from(preparedObserved.binary)).toEqual(Array.from(preparedControl.binary));
    expect(preparedObserved.irPostClaimErrors ?? []).toEqual([]);
    expect(preparedObserved.irOutcomes ?? []).toHaveLength(4);
    for (const name of ["seed", "run", "Box_new", "Box_read"]) {
      expect(outcome(preparedObserved, name), name).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }
    const ownerComponents = new Set(
      ["run", "Box_new", "Box_read"].map((name) => outcome(preparedObserved, name).preparedComponentId),
    );
    expect(ownerComponents.size).toBe(1);
    expect(outcome(preparedObserved, "seed").preparedComponentId).not.toBe([...ownerComponents][0]);
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
