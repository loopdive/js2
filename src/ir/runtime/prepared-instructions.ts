// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrBlock, type IrInstr } from "../core/nodes.js";
import type { PreparedIrFunction } from "./contracts/prepared.js";
import { assertPreparedIrAsyncRuntimeCurrent } from "./async-attachment.js";

/** Physical dependencies belong to executable states, not their retained semantic counterparts. */
export function forEachPreparedIrInstruction(
  fn: PreparedIrFunction,
  visit: (instruction: IrInstr, block?: IrBlock) => void,
): void {
  const runtime =
    fn.asyncPlan || fn.asyncRuntime
      ? assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime)
      : undefined;
  for (const block of fn.blocks)
    for (const root of block.instrs) forEachInstrDeep(root, (instruction) => visit(instruction, block));
  for (const state of runtime?.states ?? []) for (const root of state.body) forEachInstrDeep(root, visit);
}
