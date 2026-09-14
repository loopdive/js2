// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { planNativeValueResources } from "../src/ir/program-physical-plan.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";

const options = { backend: "wasmgc", target: "standalone" } as const;
function prepare(replay = false) {
  const { packet } = sourcePacket({ "./entry.ts": "export function main(): number { return 42; }" });
  const input = replay ? decodeTypedPacket(encodeTypedPacket(packet)) : packet;
  if (replay) expect(input).not.toBe(packet);
  return requireProgram(prepareTypedIrProgram(input, typedOptions));
}
type Program = ReturnType<typeof prepare>;
function positive(program: Program) {
  const projection = program.runtime[0]!;
  const plan = planNativeValueResources(program, options, projection, "primitive-only");
  expect(plan.owners).toEqual(program.ir.functions.map((fn) => fn.unitId));
  expect(plan.owners.length).toBeGreaterThan(0);
  expect(plan.strings).toBe("primitive-only");
  return projection;
}

describe("checked native value whole-program/current-projection boundary", () => {
  it("accepts the genuine complete program", () => {
    positive(prepare());
  });
  it("accepts preparation from actual serialized and decoded typed input", () => {
    positive(prepare(true));
  });
  it("rejects an unsealed program after a real positive", () => {
    const program = prepare(),
      projection = positive(program);
    expect(() =>
      planNativeValueResources(
        { ...program, sealed: false } as unknown as Program,
        options,
        projection,
        "primitive-only",
      ),
    ).toThrow("program is not a complete prepared program");
  });
  it("rejects a detached selected projection after a real positive", () => {
    const program = prepare(),
      projection = positive(program);
    expect(() => planNativeValueResources(program, options, { ...projection }, "primitive-only")).toThrow(
      "native value resources: selected projection does not belong",
    );
  });
  it("rejects another genuinely prepared program's projection", () => {
    const program = prepare(),
      foreign = prepare(true);
    positive(program);
    const projection = positive(foreign);
    expect(() => planNativeValueResources(program, options, projection, "primitive-only")).toThrow(
      "native value resources: selected projection does not belong",
    );
  });
  it("rejects a backend mismatch after a real positive", () => {
    const program = prepare(),
      projection = positive(program);
    expect(() =>
      planNativeValueResources(program, { ...options, backend: "linear" }, projection, "primitive-only"),
    ).toThrow("native value resources: selected projection does not belong");
  });
  it("rejects a target mismatch after a real positive", () => {
    const program = prepare(),
      projection = positive(program);
    expect(() =>
      planNativeValueResources(
        program,
        { ...options, target: "host" } as unknown as typeof options,
        projection,
        "primitive-only",
      ),
    ).toThrow("native value resources: selected projection does not belong");
  });
  it("rejects changed selected instructions despite identical owner coordinates", () => {
    const program = prepare(),
      original = positive(program);
    let changed = 0;
    const functions = original.prepared.functions.map((fn) => ({
      ...fn,
      blocks: fn.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) => {
          if (instr.kind !== "const") return instr;
          changed++;
          return { ...instr, value: 43 };
        }),
      })),
    }));
    expect(changed).toBeGreaterThan(0);
    expect(functions).not.toEqual(original.prepared.functions);
    const projection = { ...original, prepared: { ...original.prepared, functions } };
    const mutated = {
      ...program,
      runtime: program.runtime.map((row) => (row === original ? projection : row)),
    } as Program;
    expect(projection.prepared.functions.map((fn) => fn.unitId)).toEqual(program.ir.functions.map((fn) => fn.unitId));
    expect(() => planNativeValueResources(mutated, options, projection, "native-string")).toThrow(
      "contradicts complete semantic/provider data",
    );
  });
  it("rejects a missing ABI entry after a real positive", () => {
    const program = prepare(),
      projection = positive(program);
    expect(program.abi.entries.length).toBeGreaterThan(0);
    const mutated = { ...program, abi: { ...program.abi, entries: [] } };
    expect(() => planNativeValueResources(mutated, options, projection, "native-string")).toThrow(
      PreparedIrProgramInvariantError,
    );
  });
  it("rejects a missing unit receipt despite retained sealed flags", () => {
    const program = prepare(),
      projection = positive(program);
    expect(program.units.size).toBeGreaterThan(0);
    const mutated = { ...program, units: new Map() };
    expect(() => planNativeValueResources(mutated, options, projection, "native-string")).toThrow(
      PreparedIrProgramInvariantError,
    );
  });
});
