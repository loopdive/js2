// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  selectNativeStringLiteral,
  planNativeStringLiteral,
} from "../src/runtime/wasmgc/values/string-literal-bodies.js";
import { reserveNativeStringLiteralTypes } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createEmptyModule } from "../src/ir/types.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { planNativeStringValuePhysical } from "../src/backend/wasmgc/program/native-string-values.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";

const policy = { target: "standalone", backend: "wasmgc", stringConst: { storage: "native" } } as const;
function genuine(replay = false) {
  const { packet } = sourcePacket({ "./entry.ts": 'export function text(): string { return " hello "; }' });
  const program = requireProgram(prepareTypedIrProgram(packet, { ...typedOptions, policy, runtimePolicies: [policy] }));
  return replay ? decodePreparedIrProgram(encodePreparedIrProgram(program)) : program;
}
describe("canonical native string selection", () => {
  it.each([false, true])("agrees with initializer selection, utf8=%s", (utf8) => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const types = reserveNativeStringLiteralTypes(tx, "selection", utf8);
    for (const value of ["", "é".repeat(5001), "x".repeat(10001), "x".repeat(9999) + "😀"])
      for (const encoding of ["ascii", "utf8-guaranteed", "wtf16"] as const) {
        const selected = selectNativeStringLiteral(utf8, utf8, value, encoding);
        const planned = planNativeStringLiteral(types.layout, utf8, value, encoding);
        expect(planned.kind).toBe(selected.kind);
        expect(planned.key).toBe(selected.key);
        if (selected.kind === "callable" && planned.kind === "callable")
          expect(planned.chunks).toEqual(selected.chunks);
      }
  });
  it("distinguishes byte overflow from UTF16 overflow and preserves surrogate boundaries", () => {
    expect(selectNativeStringLiteral(true, true, "é".repeat(5001), "utf8-guaranteed")).toMatchObject({
      kind: "global",
      encoding: "wtf16",
    });
    expect(selectNativeStringLiteral(true, true, "", "ascii").key).toBe("u8:");
    expect(selectNativeStringLiteral(true, true, "", "wtf16").key).toBe("u16:");
    expect(selectNativeStringLiteral(true, false, "", "ascii").key).toBe("u16:");
    expect(() => selectNativeStringLiteral(true, true, "\ud800", "utf8-guaranteed")).toThrow(/surrogate/);
    expect(selectNativeStringLiteral(false, false, "\ud800", "utf8-guaranteed").kind).toBe("global");
    const selection = selectNativeStringLiteral(false, false, "x".repeat(9999) + "😀");
    if (selection.kind !== "callable") throw new Error("expected oversized literal");
    expect(selection.chunks.map((chunk) => chunk.length)).toEqual([10000, 1]);
    expect(selection.chunks.join("")).toBe("x".repeat(9999) + "😀");
  });
});
describe("descriptive projection planning", () => {
  it.each([false, true])("retains source-produced projection demand indices, decoded=%s", (replay) => {
    const program = genuine(replay);
    const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
    const outcome = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false });
    expect(outcome.kind).toBe("planned");
    if (outcome.kind !== "planned") throw new Error("expected genuine literal plan");
    expect(outcome.plan.mode).toBe("literals");
    expect(outcome.plan.literalUses.length).toBeGreaterThan(0);
    for (const use of outcome.plan.literalUses) {
      const demand = demands.literals[use.demandIndex]!;
      const occurrence = demands.occurrences[demand.occurrence]!;
      expect(demands.buffers[occurrence.bufferIndex]!.view).toBe("projection");
      expect(use.cacheKey).toBe("u16: hello ");
    }
    expect(demands.literals.length).toBeGreaterThan(outcome.plan.literalUses.length);
    expect(Object.isFrozen(outcome.plan.literalRequirements)).toBe(true);
    expect(outcome.plan.declarations.map((row) => row.key)).toEqual(
      ["data", "any", "flat", "cons", "hashed", "u16: hello "].map((role) => `${outcome.plan.key}:${role}`),
    );
    expect(outcome.plan.reservationSteps).toEqual(
      outcome.plan.declarations.map((row, index) => ({
        phase: index < 5 ? "string-types" : "resources",
        kind: "reserve",
        resourceKey: row.key,
      })),
    );
    expect(Object.isFrozen(outcome.plan.declarations)).toBe(true);
    expect(Object.isFrozen(outcome.plan.reservationSteps)).toBe(true);
  });
  it("leaves genuine no-demand programs on the existing path", () => {
    const { packet } = sourcePacket();
    const program = requireProgram(prepareTypedIrProgram(packet, typedOptions));
    expect(
      planNativeStringValuePhysical(collectNativeStringValueDemands(program, program.runtime[0]!), {
        representation: "native-string",
        utf8Storage: false,
      }),
    ).toEqual({ kind: "none" });
  });
  it("rejects a mismatched descriptive census after its genuine positive", () => {
    const program = genuine();
    const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
    expect(planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false }).kind).toBe(
      "planned",
    );
    expect(() =>
      planNativeStringValuePhysical(
        { ...demands, literals: [] },
        { representation: "native-string", utf8Storage: false },
      ),
    ).toThrow(/census/);
  });
});
