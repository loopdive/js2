// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { collectTerminatorUses, collectUses, forEachInstrDeep, type IrInstr, type IrValueId } from "../core/nodes.js";
import type { PreparedIrFunction as IrFunction } from "./contracts/prepared.js";
import type { IrVerifyError } from "./verify.js";

/**
 * (#7291) A `stringBuilder` slot is written only by its `""` initializer and
 * by an owned append of its own single-use read, outside a resumable body, so
 * a backend may keep it as buffer locals.
 */
export function verifyStringBuilderSlots(func: IrFunction, errors: IrVerifyError[]): void {
  const builders = new Set((func.slots ?? []).filter((slot) => slot.stringBuilder).map((slot) => slot.index));
  if (builders.size === 0) return;
  if ((func.funcKind ?? "regular") !== "regular") {
    errors.push({ message: "a string-builder slot requires a regular function", func: func.name });
  }
  const defOf = new Map<IrValueId, IrInstr>();
  const useCount = new Map<IrValueId, number>();
  const countUse = (value: IrValueId): void => void useCount.set(value, (useCount.get(value) ?? 0) + 1);
  const writes: Extract<IrInstr, { kind: "slot.write" }>[] = [];
  for (const block of func.blocks) {
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null) defOf.set(instr.result, instr);
        for (const value of collectUses(instr)) countUse(value);
        if (instr.kind === "slot.write" && builders.has(instr.slotIndex)) writes.push(instr);
      });
    }
    for (const value of collectTerminatorUses(block)) countUse(value);
  }
  const soleDef = (value: IrValueId): IrInstr | undefined => (useCount.get(value) === 1 ? defOf.get(value) : undefined);
  for (const write of writes) {
    const def = soleDef(write.value);
    const lhs = def?.kind === "string.concat" && def.concatMode === "owned-append" ? soleDef(def.lhs) : undefined;
    const isInitializer = def?.kind === "string.const" && def.value === "";
    const isOwnAppend = lhs?.kind === "slot.read" && lhs.slotIndex === write.slotIndex;
    if (!isInitializer && !isOwnAppend) {
      errors.push({
        message: `string-builder slot ${write.slotIndex} has a write that is neither "" nor an owned append of itself`,
        func: func.name,
      });
    }
  }
}
