// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AllocSiteId, IrInstrObjectNew, IrObjectShape, IrType, IrValueId } from "./nodes.js";

/** Preflight before allocating SSA/site identities. */
export function assertObjectNewArity(shape: IrObjectShape, values: readonly IrValueId[], funcName: string): void {
  if (values.length !== shape.fields.length)
    throw new Error(
      `IrFunctionBuilder: object.new value count ${values.length} != shape field count ${shape.fields.length} (func ${funcName})`,
    );
}

export function objectNewInstruction(
  shape: IrObjectShape,
  values: readonly IrValueId[],
  result: IrValueId,
  resultType: IrType,
  alloc?: AllocSiteId,
): IrInstrObjectNew {
  return { kind: "object.new", shape, values: [...values], result, resultType, alloc };
}
