// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { irUnitFuncRef, irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import type { IrClosureSignature, IrFunction, IrInstr, IrType } from "../src/ir/core/nodes.js";
import { asValueId } from "../src/ir/core/nodes.js";
import { asAsyncStateId, canonicalPromiseAbi } from "../src/ir/async-plan.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { verifyAllocProvenance } from "../src/ir/analysis/alloc-verification.js";
import { analyzeOwnership } from "../src/ir/analysis/ownership.js";
import { analyzeEscape } from "../src/ir/analysis/escape.js";
import { attachIrStringCarrier } from "../src/ir/string-carrier.js";
import { attachIrVecLayouts } from "../src/ir/vec-layout.js";
import { attachIrPhysicalRefTypeRefs } from "../src/ir/physical-ref-support.js";
import { irRuntimeTypeRef } from "../src/ir/abi-bindings.js";
import { findReferencedWithdrawnIrUnit } from "../src/ir/integration.js";
import {
  collectNativeAsyncCallableDemands,
  NATIVE_ASYNC_CALLABLE_DECLARATIONS,
} from "../src/ir/runtime/native-async-callables.js";
import { collectVectorCallableDemands, VECTOR_CALLABLE_DECLARATION } from "../src/ir/runtime/vector-callables.js";
import { renameInstrOperands } from "../src/ir/passes/inline-small.js";

const identities = createTestIrFunctionIdentityFactory("issue-7139/class-value-contracts");
const number: IrType = { kind: "val", val: { kind: "f64" } };
const signature: IrClosureSignature = { params: [number], returnType: number };
function allocationControl(callSignature = signature) {
  const registry = new AllocSiteRegistry();
  const builder = new IrFunctionBuilder(
    identities.next("allocate"),
    [{ kind: "callable", signature: callSignature }],
    false,
    registry,
  );
  builder.openBlock();
  const seed = builder.emitConst({ kind: "f64", value: 1 }, number);
  const construct = builder.emitClosureNew(irUnitFuncRef(identities.next("construct")), signature, [number], [seed]);
  const parent = builder.emitExternNew("Object", []),
    properties = builder.emitExternNew("Object", []);
  const callTarget = irUnitFuncRef(identities.next("call"));
  const result = builder.emitClassValueNew({
    callTarget,
    signature: callSignature,
    allocator: irRuntimeFuncRef("__class_value_new"),
    construct,
    parent,
    properties,
  });
  builder.terminate({ kind: "return", values: [result] });
  const fn = builder.finish();
  const instruction = fn.blocks[0]!.instrs.find(
    (row): row is Extract<IrInstr, { kind: "class.value.new" }> => row.kind === "class.value.new",
  )!;
  return {
    fn,
    instruction,
    registry,
    construct,
    parent,
    properties,
    callTarget,
  };
}
function replaceInstruction(fn: IrFunction, instruction: IrInstr): IrFunction {
  return {
    ...fn,
    blocks: fn.blocks.map((block) => ({
      ...block,
      instrs: block.instrs.map((row) => (row.kind === "class.value.new" ? instruction : row)),
    })),
  };
}

describe("constructor-value references and retained allocations", () => {
  for (const field of ["callTarget", "allocator"] as const) {
    it(`rejects malformed ${field} and preserves exact withdrawn-unit dependencies`, () => {
      const f = allocationControl();
      expect(verifyIrFunction(f.fn)).toEqual([]);
      const malformed = replaceInstruction(f.fn, {
        ...f.instruction,
        [field]: { kind: "func", name: "forged" },
      });
      expect(verifyIrFunction(malformed).some((error) => error.message.includes("class.value.new target"))).toBe(true);
      const target = irUnitFuncRef(identities.next("withdrawn-target"));
      const referenced = replaceInstruction(f.fn, {
        ...f.instruction,
        [field]: target,
      });
      if (target.binding.kind !== "unit") throw Error("lost exact test unit");
      expect(findReferencedWithdrawnIrUnit(referenced, new Set([target.binding.unitId]))?.unitId).toBe(
        target.binding.unitId,
      );
    });
    it(`rejects canonical builtin misuse in ${field}`, () => {
      const f = allocationControl();
      expect(() =>
        collectNativeAsyncCallableDemands([
          replaceInstruction(f.fn, {
            ...f.instruction,
            [field]: NATIVE_ASYNC_CALLABLE_DECLARATIONS[0]!.ref,
          }),
        ]),
      ).toThrow(/not a lifted closure body/);
      expect(() =>
        collectVectorCallableDemands([
          replaceInstruction(f.fn, {
            ...f.instruction,
            [field]: VECTOR_CALLABLE_DECLARATION.ref,
          }),
        ]),
      ).toThrow(/not a lifted closure body/);
    });
  }
  it("visits both symbolic roles in retained async states", () => {
    const f = allocationControl();
    for (const field of ["callTarget", "allocator"] as const) {
      const target = irUnitFuncRef(identities.next("state-withdrawn-target"));
      if (target.binding.kind !== "unit") throw Error("lost exact test unit");
      const instruction = { ...f.instruction, [field]: target };
      const stateOnly: IrFunction = {
        ...f.fn,
        blocks: [],
        asyncPlan: {
          schemaVersion: 1,
          ownerUnitId: f.fn.unitId,
          kind: "async-function",
          abi: canonicalPromiseAbi(number),
          entry: asAsyncStateId(0),
          params: [],
          values: [],
          spills: [],
          handlers: [],
          runtimeIntents: [],
          states: [
            {
              id: asAsyncStateId(0),
              body: [instruction],
              terminator: { kind: "complete" },
            },
          ],
        },
      };
      expect(findReferencedWithdrawnIrUnit(stateOnly, new Set([target.binding.unitId]))?.unitId).toBe(
        target.binding.unitId,
      );
      expect(findReferencedWithdrawnIrUnit(f.fn, new Set([target.binding.unitId]))).toBeUndefined();
      const malformed: IrFunction = {
        ...stateOnly,
        asyncPlan: {
          ...stateOnly.asyncPlan!,
          states: [
            {
              ...stateOnly.asyncPlan!.states[0]!,
              body: [
                {
                  ...instruction,
                  [field]: { kind: "func", name: "forged-state-target" },
                },
              ],
            },
          ],
        },
      };
      expect(verifyIrFunction(malformed).some((error) => error.message.includes("class.value.new target"))).toBe(true);
      expect(verifyIrFunction(stateOnly).some((error) => error.message.includes("class.value.new target"))).toBe(false);
    }
  });

  it("keeps every allocation retained by a returned constructor off the stack", () => {
    const f = allocationControl(),
      ownership = analyzeOwnership(f.fn),
      escapeResult = analyzeEscape(f.fn);
    expect(verifyAllocProvenance(f.fn, f.registry)).toEqual([]);
    for (const value of [f.construct, f.parent, f.properties]) {
      expect(ownership.ownershipOf(value)).toBe("escaped");
      expect(ownership.isStackAllocatable(value)).toBe(false);
      expect(escapeResult.of(value)?.classification).toBe("captured");
      expect(escapeResult.of(value)?.stackAllocatable).toBe(false);
    }
    const missing = replaceInstruction(f.fn, {
      ...f.instruction,
      alloc: undefined,
    });
    expect(
      verifyAllocProvenance(missing, f.registry).some((error) => error.message.includes("missing an AllocSiteId")),
    ).toBe(true);
  });
  it("renames all three values without changing symbolic targets or the allocation identity", () => {
    const f = allocationControl(),
      construct = asValueId(100),
      parent = asValueId(101),
      properties = asValueId(102);
    const renamed = renameInstrOperands(
      f.instruction,
      new Map([
        [f.construct, construct],
        [f.parent, parent],
        [f.properties, properties],
      ]),
    );
    expect(renamed).toEqual({
      ...f.instruction,
      construct,
      parent,
      properties,
    });
  });
});

it("prepares string, vector and physical-reference identities in the embedded Call signature", () => {
  const anchor = allocationControl(),
    carrier = irRuntimeTypeRef(anchor.fn.unitId, "class-call-signature");
  const controls: readonly {
    type: IrType;
    attach: (fn: IrFunction) => IrFunction;
  }[] = [
    {
      type: { kind: "string" },
      attach: (fn) => attachIrStringCarrier(fn, carrier).function,
    },
    {
      type: { kind: "vec", elementType: number, nullable: false },
      attach: (fn) =>
        attachIrVecLayouts(fn, () => ({
          carrierType: carrier,
          dataType: carrier,
          lengthFieldIndex: 0,
          dataFieldIndex: 1,
        })).function,
    },
    {
      type: { kind: "val", val: { kind: "ref", typeIdx: 0 } },
      attach: (fn) =>
        attachIrPhysicalRefTypeRefs(fn, (type) =>
          type.val.kind === "ref" || type.val.kind === "ref_null" ? carrier : undefined,
        ),
    },
  ];
  for (const control of controls) {
    const f = allocationControl({ params: [control.type], returnType: null }),
      prepared = control.attach(f.fn);
    const instruction = prepared.blocks[0]!.instrs.find(
      (row): row is Extract<IrInstr, { kind: "class.value.new" }> => row.kind === "class.value.new",
    )!;
    expect(instruction.resultType?.kind).toBe("callable");
    if (instruction.resultType?.kind !== "callable") throw Error("lost callable result");
    expect(instruction.signature).toEqual(instruction.resultType.signature);
    expect(instruction.signature).not.toEqual(f.instruction.signature);
    expect(verifyIrFunction(prepared)).toEqual([]);
  }
});
