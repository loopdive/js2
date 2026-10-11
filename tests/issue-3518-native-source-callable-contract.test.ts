// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";

afterEach(async () => new Promise<void>((resolve) => setImmediate(resolve)));

describe("checker-certified whole-program callable annotations", () => {
  it("keeps aliases tied to the actual callable signature and lifted capture", () => {
    const result = prepareIrProgramSources(
      sourceInput({
        "./entry.ts": `type Unary = (value: number) => number;
        export function make(seed: number): Unary {
          const captured = seed + 3;
          return function add(value: number): number { return captured + value; };
        }`,
      }),
    );
    if (result.kind !== "prepared") throw new Error(result.detail);
    const make = result.ir.functions.find((fn) => fn.name === "make")!;
    expect(make.resultTypes).toEqual([
      {
        kind: "callable",
        signature: {
          params: [{ kind: "val", val: { kind: "f64" } }],
          returnType: { kind: "val", val: { kind: "f64" } },
        },
      },
    ]);
    const lifted = result.ir.functions.filter((fn) => fn.closureSubtype);
    expect(lifted).toHaveLength(1);
    expect(lifted[0]!.closureSubtype!.captureFieldTypes).toEqual([{ kind: "val", val: { kind: "f64" } }]);
    expect(result.inventory.allUnits.find((unit) => unit.id === lifted[0]!.unitId)?.terminal).toBe(false);
    expect(result.derivedUnits.some((unit) => unit.id === lifted[0]!.unitId)).toBe(false);
  });

  it("collects distinct nested signatures without inventing a source-body population", () => {
    const program = requireProgram(
      prepareWholeIrProgram(
        sourceInput({
          "./entry.ts": `export function inspect(
        factory: (callback: (value: number) => number) => (value: boolean) => number
      ): number { return 17; }`,
        }),
      ),
    );
    const requirements = planNativeSourceClosureRequirements(program, program.runtime[0]!);
    expect(requirements).toBeDefined();
    expect(requirements!.signatures).toHaveLength(3);
    expect(new Set(requirements!.signatures.map((row) => row.id)).size).toBe(3);
    expect(requirements!.gaps).toEqual([]);
    expect(requirements!.units).toEqual([]);
    expect(requirements!.allocations).toEqual([]);
    const outer = requirements!.signatures[0]!.signature;
    expect(outer.params[0]?.kind).toBe("callable");
    expect(outer.returnType?.kind).toBe("callable");
    if (outer.params[0]?.kind !== "callable" || outer.returnType?.kind !== "callable")
      throw new Error("missing actual nested callable types");
    expect(requirements!.signatures[1]!.signature).toEqual(outer.params[0].signature);
    expect(requirements!.signatures[2]!.signature).toEqual(outer.returnType.signature);
  });

  const refusals = [
    ["overload", "{ (value: number): number; (value: string): string }", /one non-constructing/],
    ["constructor", "{ (value: number): number; new (value: number): object }", /one non-constructing/],
    ["generic", "<T>(value: T) => T", /generic\/this/],
    ["this", "(this: object, value: number) => number", /generic\/this/],
    ["optional", "(value?: number) => number", /exact required parameter/],
    ["rest", "(...values: number[]) => number", /exact required parameter/],
    ["recursive", "(value: Unsupported) => number", /recursive anonymous/],
    ["any argument", "(value: any) => number", /one non-constructing/],
  ] as const;
  it.each(refusals)("refuses the unsupported %s contract before physical planning", (_label, type, detail) => {
    const result = prepareIrProgramSources(
      sourceInput({
        "./entry.ts": `type Unsupported = ${type};
        export function inspect(value: Unsupported): number { return 1; }`,
      }),
    );
    expect(result).toMatchObject({ kind: "unsupported", code: "type-resolution-unsupported", stage: "build" });
    if (result.kind === "prepared") throw new Error("unsupported callable was admitted");
    expect(result.detail).toMatch(detail);
    expect(result.sourceFile).toBe("entry.ts");
    expect(result.unitId).toBeTruthy();
    expect(result.location.line).toBeGreaterThan(0);
  });
});
