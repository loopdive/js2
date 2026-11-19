// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachInstrDeep, type IrFunction, type IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";

/**
 * Visit each SSA definition of `fn` with its type: parameters, async-plan values, typed block arguments, and
 * instruction results in block and async-plan state bodies, nested buffers included.
 */
export function forEachIrValueDefinition(fn: IrFunction, visit: (value: IrValueId, type: IrType) => void): void {
  for (const param of fn.params) visit(param.value, param.type);
  for (const value of fn.asyncPlan?.values ?? []) visit(value.value, value.type);
  for (const block of fn.blocks)
    block.blockArgs.forEach((value, index) => {
      const type = block.blockArgTypes[index];
      if (type) visit(value, type);
    });
  const bodies = [
    ...fn.blocks.map((block) => block.instrs),
    ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
  ];
  for (const body of bodies)
    for (const root of body)
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null && instr.resultType) visit(instr.result, instr.resultType);
      });
}

/** The type each SSA value of `fn` is defined with ({@link forEachIrValueDefinition}); a later definition wins. */
export function irValueTypes(fn: IrFunction): ReadonlyMap<IrValueId, IrType> {
  const types = new Map<IrValueId, IrType>();
  forEachIrValueDefinition(fn, (value, type) => types.set(value, type));
  return types;
}
