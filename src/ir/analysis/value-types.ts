// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachInstrDeep, type IrFunction, type IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";

/**
 * The type each SSA value of `fn` is defined with: parameters, async-plan
 * values, block arguments and instruction results, nested buffers included.
 */
export function irValueTypes(fn: IrFunction): ReadonlyMap<IrValueId, IrType> {
  const types = new Map<IrValueId, IrType>();
  for (const param of fn.params) types.set(param.value, param.type);
  for (const value of fn.asyncPlan?.values ?? []) types.set(value.value, value.type);
  for (const block of fn.blocks) {
    block.blockArgs.forEach((value, index) => types.set(value, block.blockArgTypes[index]!));
    for (const root of block.instrs)
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null && instr.resultType) types.set(instr.result, instr.resultType);
      });
  }
  return types;
}
