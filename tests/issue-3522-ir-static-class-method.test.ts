// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function classMemberOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "class-member" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing class-member outcome for ${name}`);
  return observed;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

describe("#3522 static class-method IR integration", () => {
  it.each(["gc", "standalone"] as const)("patches a %s static method through IR without a receiver", async (target) => {
    const result = await compile(
      `
      class MathBox {
        static double(value: number): number { return value * 2; }
      }
      class OffsetBox {
        offset(value: number = 2): number { return value; }
      }
      export function run(value: number): number { return MathBox.double(value) + new OffsetBox().offset(); }
      `,
      {
        fileName: `ir-static-method-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(classMemberOutcome(result, "MathBox_double")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.any(String),
    });
    expect(classMemberOutcome(result, "OffsetBox_offset")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(classMemberOutcome(result, "OffsetBox_offset")).not.toHaveProperty("preparedComponentId");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiate(result)).run!(20)).toBe(42);
  });

  it("patches same-named static overrides as distinct structural owners", async () => {
    const result = await compile(
      `
      class Animal { static kingdom(): string { return "Animalia"; } }
      class Dog extends Animal { static kingdom(): string { return "Canine"; } }
      export function run(): boolean { return Animal.kingdom() + "/" + Dog.kingdom() === "Animalia/Canine"; }
      `,
      {
        fileName: "ir-static-method-overrides.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    for (const name of ["Animal_kingdom", "Dog_kingdom"]) {
      expect(classMemberOutcome(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.any(String),
      });
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiate(result)).run!()).toBe(1);
  });
});
