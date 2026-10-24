// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { IR_CONSTRUCT } from "../src/ir/core/closure-invocation-callables.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { requireProgram, typedOptions } from "./helpers/typed-program-fixtures.js";
import { expect, it } from "vitest";
import {
  prepareClassConstructProgram,
  classConstructInput,
  constructPolicy,
} from "./helpers/prepared-class-construct.js";
import { realmFixture } from "./helpers/native-realm-source-integration.js";
import {
  bindNativeSourceClosureUnits,
  nativeSourceClosureCallableBindings,
  nativeRealmSourceClosureCallableBindings,
} from "../src/ir/program-native-invocation.js";
import { requireNativeRealmSourceClosureCallables } from "../src/backend/wasmgc/resources/native-source-closure-callables.js";

it("retains actual private Construct slots while excluding them from public realm Call", () => {
  const fixture = prepareClassConstructProgram("nested");
  const f = realmFixture(fixture.program);
  f.tx.freezeReservations();
  bindNativeSourceClosureUnits(f.tx, f.source!, f.slots);
  const requirements = f.input.invocationRequirements!;
  const selected = nativeSourceClosureCallableBindings(f.tx, f.source!, requirements);
  const publicCalls = nativeRealmSourceClosureCallableBindings(f.tx, f.source!, f.requirements);
  const privateUnits = new Set(
    requirements.uses.filter((use) => use.kind === "construct").map((use) => use.liftedUnitId!),
  );
  expect(privateUnits.size).toBe(2);
  for (const unit of privateUnits) {
    expect(selected.entries.some((row) => row.unitId === unit)).toBe(true);
    expect(publicCalls.entries.some((row) => row.unitId === unit)).toBe(false);
  }
  const publicUnits = f.requirements.description.sourceUnits.filter((unit) => !privateUnits.has(unit));
  expect(publicUnits.length).toBeGreaterThan(0);
  expect(publicCalls.entries.map((row) => row.unitId)).toEqual(publicUnits);
  expect(() =>
    requireNativeRealmSourceClosureCallables(f.tx, { ...publicCalls }, f.source!.types, f.requirements),
  ).toThrow(/copied/);
  requireNativeRealmSourceClosureCallables(f.tx, publicCalls, f.source!.types, f.requirements);
});

it.each([false, true])(
  "keeps stored internal Construct entries private without any Construct call site, uncertified=%s",
  (uncertified) => {
    const fixture = classConstructInput();
    const outer = {
      ...fixture.outer,
      blocks: fixture.outer.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instruction) =>
          instruction.kind === "try"
            ? {
                ...instruction,
                body: instruction.body.map((row) =>
                  row.kind === "call" &&
                  row.target.binding.kind === "intrinsic" &&
                  row.target.binding.symbol === IR_CONSTRUCT
                    ? {
                        kind: "coerce.to_externref" as const,
                        value: row.args[0]!,
                        result: row.result!,
                        resultType: { kind: "val" as const, val: { kind: "externref" as const } },
                      }
                    : row,
                ),
              }
            : instruction,
        ),
      })),
    };
    const input = {
      ...fixture.input,
      ir: {
        ...fixture.input.ir,
        functions: fixture.input.ir.functions.map((fn) => (fn === fixture.outer ? outer : fn)),
      },
    };
    if (uncertified) {
      const raw: import("../src/ir/core/nodes.js").IrInstr = {
        kind: "raw.wasm",
        ops: [{ op: "nop" }],
        stackDelta: 0,
        result: null,
        resultType: null,
      };
      input.ir.functions = input.ir.functions.map((fn) =>
        fn.unitId === fixture.left.unitId
          ? {
              ...fn,
              blocks: fn.blocks.map((block, index) =>
                index === 0 ? { ...block, instrs: [raw, ...block.instrs] } : block,
              ),
            }
          : fn,
      );
    }
    const program = requireProgram(
      prepareTypedIrProgram(input, { ...typedOptions, policy: constructPolicy, runtimePolicies: [constructPolicy] }),
    );
    const f = realmFixture(program);
    expect(f.input.invocationRequirements!.uses.some((use) => use.kind === "construct")).toBe(false);
    expect(f.requirements.source!.classValues!.length).toBeGreaterThan(0);
    f.tx.freezeReservations();
    bindNativeSourceClosureUnits(f.tx, f.source!, f.slots);
    if (uncertified) {
      expect(() => nativeRealmSourceClosureCallableBindings(f.tx, f.source!, f.requirements)).toThrow(/raw.wasm/);
      return;
    }
    const publicCalls = nativeRealmSourceClosureCallableBindings(f.tx, f.source!, f.requirements);
    expect(publicCalls.entries.length).toBeGreaterThan(0);
    for (const unit of [fixture.left.unitId, fixture.right.unitId]) {
      expect(f.requirements.description.sourceUnits).toContain(unit);
      expect(publicCalls.entries.some((row) => row.unitId === unit)).toBe(false);
    }
  },
);
