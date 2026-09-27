// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrSourceId, IrUnitId } from "../shared/contracts/ir-identity.js";
import type { IrFuncRef, IrInstrCall } from "./core/nodes.js";
import { irRuntimeFuncRef } from "./core/callable-bindings.js";

export const IR_UNDEFINED_VALUE_FN = "__ir_undefined_value";

/** Semantic demand only: no allocator, context or physical index crosses this seam. */
export interface IrUndefinedValueDemand {
  readonly sourceId: IrSourceId;
  readonly terminalUnitId: IrUnitId;
  readonly ref: IrFuncRef;
  readonly signature: { readonly params: readonly []; readonly results: readonly [{ readonly kind: "externref" }] };
}

export function assertIrUndefinedValueDemand(demand: IrUndefinedValueDemand): void {
  if (
    !demand ||
    typeof demand.sourceId !== "string" ||
    !demand.sourceId ||
    typeof demand.terminalUnitId !== "string" ||
    !demand.terminalUnitId ||
    demand.ref?.kind !== "func" ||
    demand.ref.binding?.kind !== "runtime" ||
    demand.ref.binding.symbol !== IR_UNDEFINED_VALUE_FN ||
    demand.signature?.params?.length !== 0 ||
    demand.signature.results?.length !== 1 ||
    demand.signature.results[0]?.kind !== "externref"
  ) {
    throw new TypeError("invalid undefined value demand");
  }
}

export function irUndefinedValueDemand(
  sourceId: IrSourceId,
  terminalUnitId: IrUnitId,
  instruction: IrInstrCall,
): IrUndefinedValueDemand {
  if (
    instruction.target.binding.kind !== "runtime" ||
    instruction.target.binding.symbol !== IR_UNDEFINED_VALUE_FN ||
    instruction.args.length !== 0 ||
    instruction.result === null ||
    instruction.resultType?.kind !== "val" ||
    instruction.resultType.val.kind !== "externref"
  ) {
    throw new TypeError("undefined value call requires exact () -> externref ABI");
  }
  const demand: IrUndefinedValueDemand = Object.freeze({
    sourceId,
    terminalUnitId,
    ref: irRuntimeFuncRef(IR_UNDEFINED_VALUE_FN),
    signature: Object.freeze({
      params: Object.freeze([]) as readonly [],
      results: Object.freeze([Object.freeze({ kind: "externref" })]) as readonly [{ readonly kind: "externref" }],
    }),
  });
  assertIrUndefinedValueDemand(demand);
  return demand;
}
