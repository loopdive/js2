// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId } from "./nodes.js";

/** Shared SSA remapping for constructor values and nominal instance allocation. */
export function mapIrClassAllocationOperands(
  instruction: Extract<IrInstr, { kind: "class.new" | "class.value.new" }>,
  map: (value: IrValueId) => IrValueId,
): typeof instruction {
  if (instruction.kind === "class.value.new") {
    const properties = map(instruction.properties),
      construct = map(instruction.construct),
      parent = map(instruction.parent);
    return properties === instruction.properties && construct === instruction.construct && parent === instruction.parent
      ? instruction
      : { ...instruction, properties, construct, parent };
  }
  let changed = false;
  const args = instruction.args.map((value) => {
    const next = map(value);
    changed ||= next !== value;
    return next;
  });
  return changed ? { ...instruction, args } : instruction;
}
