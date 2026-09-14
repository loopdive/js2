// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { planNativeValueResources } from "../src/ir/program-physical-plan.js";
import { assertNativeValueResourcePlanFor } from "../src/ir/program/native-value-resources.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";

const options = { backend: "wasmgc", target: "standalone" } as const;
function fixture(replay = false) {
  const { packet } = sourcePacket({ "./entry.ts": "export function main(): number { return 42; }" });
  const input = replay ? decodeTypedPacket(encodeTypedPacket(packet)) : packet;
  const program = requireProgram(prepareTypedIrProgram(input, typedOptions));
  const projection = program.runtime[0]!;
  const plan = planNativeValueResources(program, options, projection, "native-string");
  expect(plan.owners.length).toBeGreaterThan(0);
  expect(() => assertNativeValueResourcePlanFor(plan, program, projection, "native-string")).not.toThrow();
  return { program, projection, plan };
}

describe("native value plan exact source join", () => {
  for (const replay of [false, true])
    it(`accepts its exact genuine source, replay=${replay}`, () => {
      fixture(replay);
    });

  it("rejects another genuinely issued plan with equal visible data", () => {
    const own = fixture();
    const foreign = fixture(true);
    expect(foreign.plan).toStrictEqual(own.plan);
    expect(foreign.plan).not.toBe(own.plan);
    expect(() => assertNativeValueResourcePlanFor(foreign.plan, own.program, own.projection, "native-string")).toThrow(
      /not issued for this/,
    );
    expect(() =>
      assertNativeValueResourcePlanFor(own.plan, foreign.program, foreign.projection, "native-string"),
    ).toThrow(/not issued for this/);
  });

  it("rejects cloned plans, detached projections and representation substitution", () => {
    const { plan, program, projection } = fixture();
    expect(() => assertNativeValueResourcePlanFor({ ...plan }, program, projection, "native-string")).toThrow(
      /not issued for this/,
    );
    expect(() => assertNativeValueResourcePlanFor(plan, program, { ...projection }, "native-string")).toThrow(
      /not issued for this/,
    );
    expect(() => assertNativeValueResourcePlanFor(plan, program, projection, "primitive-only")).toThrow(
      /not issued for this/,
    );
    expect(() => assertNativeValueResourcePlanFor(plan, program, projection, "native-string")).not.toThrow();
  });
});
