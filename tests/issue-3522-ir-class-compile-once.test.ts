// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isEarlyPreparableClassLayout } from "../src/codegen/program-abi-type-planning.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function classMemberOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "class-member" && candidate.displayName === name,
  );
  expect(observed, `terminal outcome count for ${name}`).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult, deps?: Record<string, unknown>): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, deps, result.stringPool);
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

describe("#3522 instance class-method compile-once ownership", () => {
  it("admits scalar, reference-bearing, and inherited layouts through remappable Program ABI cells", () => {
    expect(
      isEarlyPreparableClassLayout({
        kind: "struct",
        name: "ScalarBox",
        fields: [
          { name: "__tag", type: { kind: "i32" }, mutable: false },
          { name: "value", type: { kind: "f64" }, mutable: true },
        ],
      }),
    ).toBe(true);
    expect(
      isEarlyPreparableClassLayout({
        kind: "struct",
        name: "StringBox",
        superTypeIdx: 3,
        fields: [
          { name: "__tag", type: { kind: "i32" }, mutable: false },
          { name: "value", type: { kind: "ref_null", typeIdx: 7 }, mutable: true },
        ],
      }),
    ).toBe(true);
  });

  it.each(["gc", "standalone"] as const)(
    "prepares the exact Animal/Dog method-accessor component once in the %s lane",
    async (target) => {
      const source = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
      const result = await compile(source, {
        fileName: "website/playground/examples/js/classes.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const prepared = [
        "Animal_get_name",
        "Animal_set_name",
        "Animal_get_age",
        "Animal_speak",
        "Dog_speak",
        "Dog_get_breed",
        "Animal_kingdom",
        "Dog_kingdom",
      ];
      const componentIds = new Set<string>();
      for (const name of prepared) {
        const observed = classMemberOutcome(result, name);
        expect(observed).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
        componentIds.add(observed.preparedComponentId!);
      }
      expect(componentIds.size).toBeGreaterThan(0);
      for (const name of ["Animal_new", "Dog_new"]) {
        expect(classMemberOutcome(result, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: true,
          irBodyEmitted: true,
        });
      }
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    },
  );

  it("preserves the unchanged Animal/Dog runtime trace", async () => {
    const source = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
    const result = await compile(source, {
      fileName: "website/playground/examples/js/classes.ts",
      experimentalIR: true,
      target: "gc",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const observed: string[] = [];
    const consoleCapture = {
      log: (value: unknown): void => {
        observed.push(String(value));
      },
    };
    const exports = await instantiate(result, { console: consoleCapture });
    exports.main!();
    expect(observed).toEqual([
      "name  = Rex",
      "age   = 4",
      "breed = Labrador",
      "Rex makes a sound — woof!",
      "renamed: Rex Jr.",
      "rex instanceof Dog    = true",
      "rex instanceof Animal = true",
      "Animal.kingdom() = Animalia",
      "Dog.kingdom()    = Animalia (canine)",
    ]);
  });

  it("never enters the direct emitter for the prepared Animal/Dog members, with a direct positive control", async () => {
    const source = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = [
        "Animal_get_name",
        "Animal_set_name",
        "Animal_get_age",
        "Animal_speak",
        "Dog_speak",
        "Dog_get_breed",
      ].join(",");
      const prepared = await compile(source, {
        fileName: "website/playground/examples/js/classes.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);

      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Animal_new";
      const direct = await compile(source, {
        fileName: "website/playground/examples/js/classes.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expect(direct.success).toBe(false);
      expect(
        direct.errors.some((error) => error.message.includes("injected direct class-body poison: Animal_new")),
      ).toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });

  it("preserves typed receivers, private struct fields, direct super dispatch, and string concat", async () => {
    const source = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
    const direct = await compile(source, {
      fileName: "website/playground/examples/js/classes.ts",
      experimentalIR: false,
      emitWat: true,
    });
    const prepared = await compile(source, {
      fileName: "website/playground/examples/js/classes.ts",
      experimentalIR: true,
      emitWat: true,
    });
    for (const result of [direct, prepared]) {
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    }

    for (const wat of [direct.wat, prepared.wat]) {
      for (const name of ["Animal_get_name", "Animal_get_age", "Animal_speak", "Dog_get_breed"]) {
        expect(watFunctionBody(wat, name)).toContain("struct.get");
      }
      expect(watFunctionBody(wat, "Animal_set_name")).toContain("struct.set");
    }
    const directAnimalSpeak = watFunctionBody(direct.wat, "Animal_speak");
    expect(directAnimalSpeak).toMatch(/ref\.test|ref\.cast/);

    const directDogSpeak = watFunctionBody(direct.wat, "Dog_speak");
    const preparedAnimalSpeak = watFunctionBody(prepared.wat, "Animal_speak");
    const preparedDogSpeak = watFunctionBody(prepared.wat, "Dog_speak");
    expect(preparedAnimalSpeak.match(/\bcall \d+/g) ?? []).toHaveLength(1);
    expect(preparedDogSpeak.match(/\bcall \d+/g) ?? []).toHaveLength(2);
    for (const body of [directDogSpeak, preparedDogSpeak]) {
      expect(body.match(/ref\.cast/g) ?? []).toHaveLength(1);
      expect(body).not.toMatch(/ref\.test|__extern_(?:get|set)|extern\.convert_any/);
    }
    for (const body of [
      preparedAnimalSpeak,
      watFunctionBody(prepared.wat, "Animal_get_name"),
      watFunctionBody(prepared.wat, "Animal_set_name"),
      watFunctionBody(prepared.wat, "Dog_get_breed"),
    ]) {
      expect(body).not.toMatch(/__extern_(?:get|set)|extern\.convert_any|ref\.(?:test|cast)/);
    }
  });

  it.each(["gc", "standalone"] as const)(
    "keeps inherited class-call targets inside the sealed prepared component in the %s lane",
    async (target) => {
      const source = `
        class Base {
          value: number = 10;
          getValue(): number { return this.value; }
        }
        class Child extends Base {
          extra: number = 20;
          sum(): number { return this.getValue() + this.extra; }
        }
        export function run(): number { return new Child().sum(); }
      `;
      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      let result: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Base_getValue,Child_sum";
        result = await compile(source, {
          fileName: `ir-inherited-prepared-target-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        });
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      for (const name of ["Base_getValue", "Child_sum"]) {
        expect(classMemberOutcome(result, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect((await instantiate(result)).run!()).toBe(30);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares a two-method %s class component once while an Unsupported sibling stays direct",
    async (target) => {
      const result = await compile(
        `
        class Calculator {
          value: number;
          constructor(value: number) { this.value = value; }
          add(delta: number): number { return this.value + delta; }
          scale(factor: number): number { return this.value * factor; }
        }
        class LegacyCalculator {
          label: string;
          constructor(label: string) { this.label = label; }
          withDefault(value: number = 9): number { return this.label.length + value; }
        }
        export function run(value: number): number {
          const calculator = new Calculator(value);
          return calculator.add(2) * 100 + calculator.scale(3) * 10 + new LegacyCalculator("legacy").withDefault();
        }
        `,
        {
          fileName: `ir-instance-method-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const add = classMemberOutcome(result, "Calculator_add");
      const scale = classMemberOutcome(result, "Calculator_scale");
      for (const observed of [add, scale]) {
        expect(observed).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect(scale.preparedComponentId).toBe(add.preparedComponentId);
      expect(classMemberOutcome(result, "LegacyCalculator_withDefault")).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect((await instantiate(result)).run!(5)).toBe(865);
    },
  );

  it("fails an instance-method invariant without retrying the direct body emitter", async () => {
    const previous = process.env.JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE;
    process.env.JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE = "Box_read";
    let result: CompileResult;
    try {
      result = await compile(
        `
        class Box {
          value: number;
          constructor(value: number) { this.value = value; }
          read(): number { return this.value; }
        }
        export function run(): number { return new Box(7).read(); }
        `,
        {
          fileName: "ir-instance-method-invariant.ts",
          experimentalIR: true,
          trackIrOutcomes: true,
        },
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE");
      else process.env.JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE = previous;
    }

    expect(result.success).toBe(false);
    expect(classMemberOutcome(result, "Box_read")).toMatchObject({
      kind: "invariant",
      code: "verifier-failure",
      stage: "verify",
      legacyBodyEmitted: false,
      irBodyEmitted: false,
    });
  });
});
