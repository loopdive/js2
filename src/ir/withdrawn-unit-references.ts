// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrFunction } from "./core/nodes.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
export function findReferencedWithdrawnIrUnit(
  fn: IrFunction,
  unitIds: ReadonlySet<IrUnitId>,
): { readonly unitId: IrUnitId; readonly name: string } | undefined {
  let found: { readonly unitId: IrUnitId; readonly name: string } | undefined;
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (nested) => {
        if (found) return;
        const ref =
          nested.kind === "call" ? nested.target : nested.kind === "closure.new" ? nested.liftedFunc : undefined;
        if (ref?.binding.kind === "unit" && unitIds.has(ref.binding.unitId)) {
          found = { unitId: ref.binding.unitId, name: ref.name };
        }
      });
      if (found) return found;
    }
  }
  return found;
}
