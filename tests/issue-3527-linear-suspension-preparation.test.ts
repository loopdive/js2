// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #3527 B2 — generic linear suspension splitting, reaching definitions, and liveness. */
import { describe, expect, it } from "vitest";

import { verifyIrAsyncPlan } from "../src/ir/async-plan.js";
import { prepareLinearSuspendingIrFunction } from "../src/ir/async-linear-prepare.js";
import { createIrSourceId, createIrUnitId } from "../src/ir/identity.js";
import { asBlockId, asValueId, irVal, type IrFunction, type IrInstr, type IrValueId } from "../src/ir/nodes.js";

const F64 = irVal({ kind: "f64" });
const EXTERN = irVal({ kind: "externref" });

function owner(ordinal: number): ReturnType<typeof createIrUnitId> {
  const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "tests/issue-3527-linear.ts" });
  return createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "function-declaration", ordinal });
}

function nullConst(result: IrValueId): Extract<IrInstr, { readonly kind: "const" }> {
  return { kind: "const", value: { kind: "null", ty: EXTERN }, result, resultType: EXTERN };
}

function add(lhs: IrValueId, rhs: IrValueId, result: IrValueId): Extract<IrInstr, { readonly kind: "binary" }> {
  return { kind: "binary", op: "f64.add", lhs, rhs, result, resultType: F64 };
}

function genericThreeState(): IrFunction {
  const seed = asValueId(0);
  const one = asValueId(1);
  const prefix = asValueId(2);
  const promise0 = asValueId(3);
  const first = asValueId(4);
  const promise1 = asValueId(5);
  const second = asValueId(6);
  const sum = asValueId(7);
  const result = asValueId(8);
  return {
    unitId: owner(0),
    name: "arbitraryChain",
    params: [{ name: "seed", value: seed, type: F64 }],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          { kind: "const", value: { kind: "f64", value: 1 }, result: one, resultType: F64 },
          add(seed, one, prefix),
          nullConst(promise0),
          { kind: "await", operand: promise0, result: first, resultType: F64 },
          nullConst(promise1),
          { kind: "await", operand: promise1, result: second, resultType: F64 },
          add(first, second, sum),
          add(sum, seed, result),
        ],
        terminator: { kind: "return", values: [result] },
      },
    ],
    exported: false,
    valueCount: 9,
    funcKind: "async",
  };
}

function slotBackedChain(): IrFunction {
  const seed = asValueId(0);
  const initialRead = asValueId(1);
  const promise0 = asValueId(2);
  const first = asValueId(3);
  const finalRead = asValueId(4);
  const promise1 = asValueId(5);
  const second = asValueId(6);
  return {
    unitId: owner(1),
    name: "slotChain",
    params: [{ name: "seed", value: seed, type: F64 }],
    resultTypes: [F64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          { kind: "slot.write", slotIndex: 0, value: seed, result: null, resultType: null },
          { kind: "slot.read", slotIndex: 0, result: initialRead, resultType: F64 },
          nullConst(promise0),
          { kind: "await", operand: promise0, result: first, resultType: F64 },
          { kind: "slot.write", slotIndex: 0, value: first, result: null, resultType: null },
          { kind: "slot.read", slotIndex: 0, result: finalRead, resultType: F64 },
          nullConst(promise1),
          { kind: "await", operand: promise1, result: second, resultType: F64 },
        ],
        terminator: { kind: "return", values: [finalRead] },
      },
    ],
    exported: false,
    valueCount: 7,
    funcKind: "async",
    slots: [{ index: 0, name: "live", type: { kind: "f64" } }],
  };
}

describe("#3527 generic linear async preparation", () => {
  it("splits every await and carries exact values through an empty intermediate body", () => {
    const prepared = prepareLinearSuspendingIrFunction(genericThreeState());
    expect(prepared).not.toBeNull();
    const plan = prepared!.main.asyncPlan!;
    expect(verifyIrAsyncPlan(plan)).toEqual([]);
    expect(plan.states).toHaveLength(3);
    expect(plan.states.filter((state) => state.terminator.kind === "suspend")).toHaveLength(2);
    expect(plan.states.map((state) => state.terminator.kind)).toEqual(["suspend", "suspend", "resolve"]);
    expect(
      plan.states.slice(0, 2).map((state) => state.terminator.kind === "suspend" && state.terminator.live),
    ).toEqual([[asValueId(0)], [asValueId(0), asValueId(4)]]);
    expect(plan.spills.map(({ value, storage }) => [value, storage])).toEqual([
      [asValueId(0), "ssa"],
      [asValueId(4), "ssa"],
    ]);
    expect(prepared!.stateFunctions).toHaveLength(3);
    expect(prepared!.stateFunctions.map((fn) => fn.name)).toEqual([
      "arbitraryChain__ir_async_state_0",
      "arbitraryChain__ir_async_state_1",
      "arbitraryChain__ir_async_state_2",
    ]);
    for (const state of plan.states) {
      expect(state.body.every((instr) => instr.kind === "const" || instr.kind === "call")).toBe(true);
    }
    expect(JSON.stringify(plan)).not.toContain("awaitSites");
  });

  it("resolves mutable slot reads to the reaching version and spills that version only", () => {
    const prepared = prepareLinearSuspendingIrFunction(slotBackedChain());
    expect(prepared).not.toBeNull();
    const plan = prepared!.main.asyncPlan!;
    expect(verifyIrAsyncPlan(plan)).toEqual([]);
    expect(plan.spills).toEqual([{ value: asValueId(3), type: F64, storage: "slot" }]);
    expect(
      plan.states.filter((state) => state.terminator.kind === "suspend").map((state) => state.terminator.live),
    ).toEqual([[], [asValueId(3)]]);
    expect(plan.values.some(({ value }) => value === asValueId(1))).toBe(false);
    expect(plan.values.some(({ value }) => value === asValueId(4))).toBe(false);
  });

  it("refuses a slot read without a proved reaching definition", () => {
    const fn = slotBackedChain();
    const block = fn.blocks[0]!;
    const firstWrite = block.instrs[0]!;
    expect(firstWrite.kind).toBe("slot.write");
    const malformed: IrFunction = {
      ...fn,
      blocks: [{ ...block, instrs: block.instrs.slice(1) }],
    };
    expect(prepareLinearSuspendingIrFunction(malformed)).toBeNull();
  });

  it("rejects liveness, spill, state, and runtime evidence corruption", () => {
    const plan = prepareLinearSuspendingIrFunction(genericThreeState())!.main.asyncPlan!;
    const first = plan.states[0]!;
    expect(first.terminator.kind).toBe("suspend");
    if (first.terminator.kind !== "suspend") return;

    const missingLive = {
      ...plan,
      states: [
        { ...first, terminator: { ...first.terminator, live: first.terminator.live.slice(1) } },
        ...plan.states.slice(1),
      ],
    };
    expect(verifyIrAsyncPlan(missingLive).some((error) => error.code === "liveness-mismatch")).toBe(true);

    const missingSpill = {
      ...plan,
      spills: plan.spills.filter(({ value }) => value !== asValueId(0)),
    };
    expect(verifyIrAsyncPlan(missingSpill).some((error) => error.code === "missing-spill")).toBe(true);

    const duplicateState = {
      ...plan,
      states: [...plan.states, { ...plan.states[0]!, id: plan.states[0]!.id }],
    };
    expect(verifyIrAsyncPlan(duplicateState).some((error) => error.code === "duplicate-state")).toBe(true);

    const missingRuntimeIntent = {
      ...plan,
      runtimeIntents: plan.runtimeIntents.filter((intent) => intent !== "scheduler.drain"),
    };
    expect(verifyIrAsyncPlan(missingRuntimeIntent).some((error) => error.code === "missing-runtime-intent")).toBe(true);
  });
});
