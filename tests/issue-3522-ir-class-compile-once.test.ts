// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { isEarlyStableScalarClassLayout } from "../src/codegen/program-abi-type-planning.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function classMemberOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "class-member" && candidate.displayName === name,
  );
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

describe("#3522 instance class-method compile-once ownership", () => {
  it("admits only type-index-stable scalar class layouts before direct emission", () => {
    expect(
      isEarlyStableScalarClassLayout({
        kind: "struct",
        name: "ScalarBox",
        fields: [
          { name: "__tag", type: { kind: "i32" }, mutable: false },
          { name: "value", type: { kind: "f64" }, mutable: true },
        ],
      }),
    ).toBe(true);
    expect(
      isEarlyStableScalarClassLayout({
        kind: "struct",
        name: "StringBox",
        fields: [
          { name: "__tag", type: { kind: "i32" }, mutable: false },
          { name: "value", type: { kind: "ref_null", typeIdx: 7 }, mutable: true },
        ],
      }),
    ).toBe(false);
  });

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
