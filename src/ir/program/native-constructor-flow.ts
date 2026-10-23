// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr } from "../core/nodes.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import { createNativeSelectedValueFlow, type NativeSelectedValueFlow } from "./native-selected-value-flow.js";

type ClassAllocation = NonNullable<NativeSourceClosureRequirements["classValues"]>[number];
export type NativeConstructorFlow = NativeSelectedValueFlow<
  ClassAllocation,
  Extract<IrInstr, { kind: "class.value.new" }>
>;

/** Constructors retain their existing exact allocation and direct selected-call contract. */
export function createNativeConstructorFlow(source: NativeSourceClosureRequirements) {
  return createNativeSelectedValueFlow<ClassAllocation, Extract<IrInstr, { kind: "class.value.new" }>>(source, {
    allocation(unit, view, _value, instruction) {
      if (instruction.kind !== "class.value.new") return undefined;
      const allocation = source.classValues?.find((row) => {
        const occurrence = source.demands.occurrences[row.occurrence]!,
          region = source.demands.buffers[occurrence.bufferIndex]!;
        return region.view === view && row.ownerUnitId === unit && occurrence.instruction === instruction;
      });
      return allocation && { allocation, instruction };
    },
    calledUnit(_unit, _view, instruction) {
      return instruction.target.binding.kind === "unit"
        ? { target: instruction.target.binding.unitId, dependencies: [] }
        : undefined;
    },
  });
}
