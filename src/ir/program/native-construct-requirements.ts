// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { IR_CONSTRUCT } from "../core/closure-invocation-callables.js";
import { preparedIrDataMismatch } from "./data.js";
import { constructEntryEffectGap } from "./construct-entry-effects.js";
import type { IrInstrCall } from "../core/nodes.js";
import { closureSignatureEquals } from "../core/types.js";
import { CLASS_CONSTRUCT_SIGNATURE } from "../runtime/closure-invocation-callables.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import type { NativeInvocationUse } from "./native-invocation-requirements.js";
import { createNativeConstructorFlow, type NativeConstructorFlow } from "./native-constructor-flow.js";

function projectionGap(
  source: NativeSourceClosureRequirements,
  use: Pick<NativeInvocationUse, "occurrence" | "ownerUnitId">,
  call: IrInstrCall,
  classes: readonly NativeConstructorFlow[],
  flow: ReturnType<typeof createNativeConstructorFlow>,
): string | undefined {
  const rows = (view: "program" | "projection") =>
    source.demands.occurrences.flatMap((row, occurrence) => {
      const region = source.demands.buffers[row.bufferIndex]!,
        instruction = row.instruction;
      return region.view === view &&
        region.ownerUnitId === use.ownerUnitId &&
        instruction.kind === "call" &&
        instruction.target.binding.kind === "intrinsic" &&
        instruction.target.binding.symbol === IR_CONSTRUCT
        ? [{ call: instruction, occurrence }]
        : [];
    });
  const semantic = rows("program"),
    projected = rows("projection");
  const index = projected.findIndex((row) => row.occurrence === use.occurrence),
    original = semantic[index]?.call;
  if (
    semantic.length !== projected.length ||
    !original ||
    preparedIrDataMismatch(original.site, call.site) !== undefined
  )
    return "Construct semantic/projection occurrence population differs";
  const originals = original.args.slice(0, 2).map((value) => flow.resolve(use.ownerUnitId, "program", value));
  if (
    classes.some((proof, index) => {
      const semantic = originals[index];
      return (
        !semantic ||
        semantic.allocation.allocationId !== proof.allocation.allocationId ||
        semantic.allocation.ownerUnitId !== proof.allocation.ownerUnitId
      );
    }) ||
    original.args[2] !== call.args[2]
  )
    return "Construct operands across representations need their authenticated transformation mapping";
  // Family equality is insufficient: changing factory arguments or swapping two
  // calls from one family changes evaluation identity/captures. Until a richer
  // transformation map exists, require exact code for every returned-value owner.
  if (classes.some((proof) => proof.calls.length)) {
    const units = new Set([...classes, ...originals.map((proof) => proof!)].flatMap((proof) => proof.owners));
    for (const unit of units) {
      if (!flow.projectionMatches(unit))
        return "returned Construct value needs its exact call/argument/capture transformation mapping";
    }
  }
  return undefined;
}

/** Actual private storage and original lifted code, not public Call signature or class spelling. */
function nativeConstructUse(
  source: NativeSourceClosureRequirements,
  use: Pick<NativeInvocationUse, "occurrence" | "ownerUnitId">,
  call: IrInstrCall,
  flow: ReturnType<typeof createNativeConstructorFlow>,
): { readonly use: NativeInvocationUse; readonly gap?: string } {
  const result = { ...use, kind: "construct" as const };
  const classes = call.args.slice(0, 2).map((value) => flow.resolve(use.ownerUnitId, "projection", value));
  if (!classes[0] || !classes[1])
    return { use: result, gap: "Construct callee/newTarget needs its actual class allocation family proof" };
  const projected = projectionGap(source, use, call, [classes[0], classes[1]], flow);
  if (projected) return { use: result, gap: projected };
  const callee = classes[0].instruction;
  const allocationOwner = classes[0].allocation.ownerUnitId;
  const closure = flow.definition(allocationOwner, "projection", callee.construct);
  if (closure?.kind !== "closure.new" || closure.liftedFunc.binding.kind !== "unit")
    return { use: result, gap: "Construct storage needs its actual source closure allocation" };
  const allocation = source.allocations.find((allocation) => {
    const occurrence = source.demands.occurrences[allocation.occurrence]!;
    const region = source.demands.buffers[occurrence.bufferIndex]!;
    return region.view === "projection" && region.ownerUnitId === allocationOwner && occurrence.instruction === closure;
  });
  if (!allocation || !closureSignatureEquals(closure.signature, CLASS_CONSTRUCT_SIGNATURE))
    return { use: result, gap: "Construct closure lacks the exact internal newTarget/argument-vector protocol" };
  const fn = source.demands.owners.find((owner) => owner.unitId === allocation.liftedUnitId)!.projectedFunction;
  const parameters = fn.closureSubtype!.parameters;
  if (parameters?.kind !== "fixed" || parameters.count !== 2 || parameters.publicLength !== 2)
    return { use: result, gap: "Construct closure lacks its fixed internal protocol parameters" };
  const effects = constructEntryEffectGap(source, allocation.liftedUnitId);
  if (effects) return { use: result, gap: `Construct internal entry: ${effects}` };
  return {
    use: {
      ...result,
      liftedUnitId: allocation.liftedUnitId,
      construct: {
        calleeOccurrence: classes[0].allocation.occurrence,
        newTargetOccurrence: classes[1].allocation.occurrence,
        closureOccurrence: allocation.occurrence,
        calleeCalls: classes[0].calls,
        newTargetCalls: classes[1].calls,
        argv: call.args[2]!,
      },
    },
  };
}

/** One current source census shares indexes and completed return proofs across its Construct uses. */
export function createNativeConstructUse(source: NativeSourceClosureRequirements) {
  const flow = createNativeConstructorFlow(source);
  return (use: Pick<NativeInvocationUse, "occurrence" | "ownerUnitId">, call: IrInstrCall) =>
    nativeConstructUse(source, use, call, flow);
}
