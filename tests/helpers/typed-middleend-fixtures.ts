// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { asBlockId, asValueId, irVal, type IrFunction, type IrInstr } from "../../src/ir/nodes.js";
import type { IrSourceId, IrUnitId } from "../../src/shared/contracts/ir-identity.js";
import type { IrTerminalUnitRecord } from "../../src/ir/identity.js";
import type { PreparedIrProgramProducerInput } from "../../src/ir/program.js";

export const f64 = irVal({ kind: "f64" });
export const externref = irVal({ kind: "externref" });
export const sourceId = "ir-source:v1:0000000000000000:synthetic:typed-middleend.ts" as IrSourceId;
export function unitId(ordinal = 0): IrUnitId {
  return `ir-unit:v1:${encodeURIComponent(sourceId)}:root:top-level-function:${String(ordinal).padStart(16, "0")}` as IrUnitId;
}

export function identityFunction(ordinal = 0): IrFunction {
  return {
    unitId: unitId(ordinal),
    name: `identity${ordinal}`,
    params: [{ name: "x", value: asValueId(0), type: f64 }],
    resultTypes: [f64],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [],
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
    exported: true,
    valueCount: 1,
    funcKind: "regular",
  };
}

export function duplicateFunction(): IrFunction {
  const fn = identityFunction();
  const add = (lhs: number, rhs: number, result: number): IrInstr => ({
    kind: "binary",
    op: "f64.add",
    lhs: asValueId(lhs),
    rhs: asValueId(rhs),
    result: asValueId(result),
    resultType: f64,
  });
  return {
    ...fn,
    params: [...fn.params, { name: "y", value: asValueId(1), type: f64 }],
    valueCount: 5,
    blocks: [
      {
        ...fn.blocks[0]!,
        instrs: [add(0, 1, 2), add(0, 1, 3), add(2, 3, 4)],
        terminator: { kind: "return", values: [asValueId(4)] },
      },
    ],
  };
}

/** The getter is encountered only after the preceding real duplicate merged. */
export function throwingDuplicate(sentinel: object): IrFunction {
  const fn = duplicateFunction();
  const tail = { ...fn.blocks[0]!.instrs[2]! };
  Object.defineProperty(tail, "kind", {
    get() {
      throw sentinel;
    },
  });
  return { ...fn, blocks: [{ ...fn.blocks[0]!, instrs: [...fn.blocks[0]!.instrs.slice(0, 2), tail] }] };
}

/** Tiny fixture evaluator, not a compiler/backend or general IR interpreter. */
export function evaluateNumeric(fn: IrFunction, args = [2, 3]): number {
  const values = new Map(fn.params.map((param, i) => [param.value, args[i]!]));
  if (fn.blocks.length !== 1) throw new Error("fixture evaluator requires one block");
  for (const instr of fn.blocks[0]!.instrs) {
    if (instr.kind === "binary" && instr.op === "f64.add")
      values.set(instr.result, values.get(instr.lhs)! + values.get(instr.rhs)!);
    else if (instr.kind === "const" && (instr.value.kind === "f64" || instr.value.kind === "i32"))
      values.set(instr.result, instr.value.value);
    else throw new Error(`unsupported fixture instruction ${instr.kind}`);
  }
  const term = fn.blocks[0]!.terminator;
  if (term.kind !== "return" || term.values.length !== 1) throw new Error("fixture requires one return");
  const result = values.get(term.values[0]!);
  if (result === undefined) throw new Error("fixture returned an undefined SSA value");
  return result;
}

/** Nonempty hand-built inventory; it does not stand in for A's frontend corpus. */
export function producerInput(functions: readonly IrFunction[] = [identityFunction()]): PreparedIrProgramProducerInput {
  const terminals: IrTerminalUnitRecord[] = functions.map((fn, ordinal) => ({
    id: fn.unitId,
    sourceId,
    lexicalOwnerId: null,
    kind: "top-level-function",
    ordinal,
    displayName: fn.name,
    line: 1,
    column: ordinal,
    declarationStart: ordinal * 2,
    declarationEnd: ordinal * 2 + 1,
    terminal: true,
    terminalOwnerId: fn.unitId,
    observedKind: "function",
    legacyKey: fn.name,
    legacyMatchName: fn.name,
    legacyOrdinal: ordinal,
    staticClassMember: false,
    legacyBodyAvailable: true,
  }));
  return {
    inventory: {
      sources: [
        {
          id: sourceId,
          kind: "synthetic",
          order: 0,
          sourceKey: "typed-middleend.ts",
          displayName: "typed-middleend.ts",
          originalFileName: "typed-middleend.ts",
        },
      ],
      classes: [],
      allUnits: terminals,
      terminalUnits: terminals,
    },
    ir: { functions },
    derivedUnits: [],
    abi: { get: () => undefined },
    policy: { target: "standalone", backend: "wasmgc" },
  };
}

export function oneAwaitFunction(): IrFunction {
  const fn = identityFunction();
  return {
    ...fn,
    funcKind: "async",
    params: [{ name: "promise", value: asValueId(0), type: externref }],
    valueCount: 2,
    blocks: [
      {
        ...fn.blocks[0]!,
        instrs: [{ kind: "await", operand: asValueId(0), result: asValueId(1), resultType: f64 }],
        terminator: { kind: "return", values: [asValueId(1)] },
      },
    ],
  };
}
