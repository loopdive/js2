// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr } from "../core/nodes.js";
import { closureSignatureEquals } from "../core/types.js";
import { closureInvocationKind } from "../core/closure-invocation-callables.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import { createNativeSelectedValueFlow } from "./native-selected-value-flow.js";

type Allocation = NativeSourceClosureRequirements["allocations"][number];
type Closure = Extract<IrInstr, { kind: "closure.new" }>;

/** Returned callables retain their actual runtime value; a family proves code/layout only. */
export function createNativeCallableFlow(source: NativeSourceClosureRequirements) {
  const flow = createNativeSelectedValueFlow<Allocation, Closure>(source, {
    closureReturns: true,
    allocation(unit, view, value, instruction, index) {
      if (instruction.kind !== "closure.new" || instruction.liftedFunc.binding.kind !== "unit") return undefined;
      let current = index.definitions.get(value)?.instruction;
      let packed = false;
      while (current?.kind === "coerce.to_externref") {
        if (
          current.resultType?.kind === "callable" &&
          closureSignatureEquals(current.resultType.signature, instruction.signature)
        )
          packed = true;
        current = index.definitions.get(current.value)?.instruction;
      }
      if (!packed) return undefined;
      const allocation = source.allocations.find((row) => {
        const occurrence = source.demands.occurrences[row.occurrence]!,
          region = source.demands.buffers[occurrence.bufferIndex]!;
        return region.view === view && row.ownerUnitId === unit && occurrence.instruction === instruction;
      });
      return allocation && { allocation, instruction };
    },
    calledUnit(unit, view, instruction, resolve) {
      const binding = instruction.target.binding;
      if (binding.kind === "unit") return { target: binding.unitId, dependencies: [] };
      if (
        binding.kind !== "intrinsic" ||
        closureInvocationKind(binding.symbol) !== "method" ||
        instruction.args.length < 2
      )
        return undefined;
      const callee = resolve(unit, view, instruction.args[1]!);
      return callee && { target: callee.allocation.liftedUnitId, dependencies: [callee] };
    },
  });
  return {
    resolve(unit: Parameters<typeof flow.resolve>[0], value: Parameters<typeof flow.resolve>[2]) {
      const projected = flow.resolve(unit, "projection", value);
      if (!projected) return { gap: "invocation callee needs its actual selected allocation/return flow" };
      if (projected.calls.length) {
        const original = flow.resolve(unit, "program", value);
        if (
          !original ||
          original.allocation.allocationId !== projected.allocation.allocationId ||
          original.allocation.ownerUnitId !== projected.allocation.ownerUnitId
        )
          return { gap: "returned callable differs across semantic/projection flows" };
        for (const ownerUnit of new Set([...projected.owners, ...original.owners])) {
          if (!flow.projectionMatches(ownerUnit))
            return { gap: "returned callable needs its exact call/argument/capture transformation mapping" };
        }
      }
      return { proof: projected };
    },
  };
}
