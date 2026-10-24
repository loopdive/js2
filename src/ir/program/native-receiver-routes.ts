// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { collectTerminatorUses } from "../core/terminator-operands.js";
import { directUses, type IrValueId } from "../core/nodes.js";
import { directIrCallableReferences } from "../core/callable-operands.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import type { NativeInvocationUse } from "./native-invocation-requirements.js";

/** A receiver read is valid only when every route to its closure installs the same issued boundary. */
export function nativeReceiverRouteGaps(
  source: NativeSourceClosureRequirements,
  uses: readonly NativeInvocationUse[],
): readonly { readonly unitId: NativeInvocationUse["ownerUnitId"]; readonly detail: string }[] {
  const readers = new Set(uses.filter((use) => use.kind === "receiver").map((use) => use.ownerUnitId));
  const gaps: { unitId: NativeInvocationUse["ownerUnitId"]; detail: string }[] = [];
  const { demands } = source;
  const occurrences = demands.occurrences.flatMap((row, occurrence) => {
    const buffer = demands.buffers[row.bufferIndex]!;
    return buffer.view === "projection" ? [{ ...row, occurrence, ownerUnitId: buffer.ownerUnitId }] : [];
  });
  for (const unitId of readers) {
    const fail = (detail: string) => gaps.push({ unitId, detail: `receiver entry ${unitId}: ${detail}` });
    const fn = demands.owners.find((owner) => owner.unitId === unitId)!.projectedFunction;
    if (!fn.closureSubtype || fn.exported) {
      fail("requires a non-exported source closure body");
      continue;
    }
    const self = fn.params[0]!.value;
    for (const row of occurrences) {
      const instruction = row.instruction;
      if (
        directIrCallableReferences(instruction).some(
          (ref) => ref.binding.kind === "unit" && ref.binding.unitId === unitId,
        ) &&
        instruction.kind !== "closure.new"
      )
        fail("a direct callable reference bypasses the native invocation boundary");
      if (row.ownerUnitId === unitId && directUses(instruction).includes(self) && instruction.kind !== "closure.cap")
        fail("closure self escapes its capture reads");
    }
    const allocations = source.allocations.filter(
      (allocation) =>
        allocation.liftedUnitId === unitId && occurrences.some((row) => row.occurrence === allocation.occurrence),
    );
    if (!allocations.length) fail("has no closed source allocation route");
    for (const allocation of allocations) {
      const root = demands.occurrences[allocation.occurrence]!.instruction;
      if (root.kind !== "closure.new" || root.result === null) throw new Error("native receiver route lost allocation");
      const values = new Set<IrValueId>([root.result]);
      const rows = occurrences.filter((row) => row.ownerUnitId === allocation.ownerUnitId);
      // Only carrier erasure preserves this exact callable association. All other flows need a separate proof.
      let changed = true;
      while (changed) {
        changed = false;
        for (const { instruction } of rows)
          if (
            instruction.kind === "coerce.to_externref" &&
            values.has(instruction.value) &&
            !values.has(instruction.result!)
          ) {
            values.add(instruction.result!);
            changed = true;
          }
      }
      let calls = 0;
      for (const row of rows) {
        const instruction = row.instruction;
        const operands = directUses(instruction).filter((value) => values.has(value));
        if (!operands.length || instruction.kind === "coerce.to_externref") continue;
        const use = uses.find((use) => use.occurrence === row.occurrence && use.liftedUnitId === unitId);
        const callee =
          instruction.kind === "call" && use && (use.kind === "method" || use.kind === "apply-vector")
            ? instruction.args[use.kind === "method" ? 1 : 0]
            : undefined;
        if (callee === undefined || operands.length !== 1 || operands[0] !== callee)
          fail("allocation has an escaping or uninstalled call route");
        else calls++;
      }
      if (!calls) fail("allocation has no selected method/apply boundary");
      const owner = demands.owners.find((owner) => owner.unitId === allocation.ownerUnitId)!.projectedFunction;
      for (const block of owner.blocks) {
        const operands = collectTerminatorUses(block.terminator);
        if (operands.some((value) => values.has(value)))
          fail("allocation escapes through a return or control-flow join");
      }
    }
    for (const block of fn.blocks) {
      const escaped = collectTerminatorUses(block.terminator);
      if (escaped.includes(self)) fail("closure self escapes through a terminator");
    }
  }
  return gaps;
}
