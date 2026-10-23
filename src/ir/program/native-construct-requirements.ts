// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { IR_CONSTRUCT } from "../core/closure-invocation-callables.js";
import { preparedIrDataMismatch } from "./data.js";
import { constructEntryEffectGap } from "./construct-entry-effects.js";
import type { IrInstr, IrInstrCall, IrValueId } from "../core/nodes.js";
import { closureSignatureEquals } from "../core/types.js";
import { CLASS_CONSTRUCT_SIGNATURE } from "../runtime/closure-invocation-callables.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import type { NativeInvocationUse } from "./native-invocation-requirements.js";

/** Trace only exact carrier erasure; unknown value flow needs a separate constructor-family proof. */
function definition(value: IrValueId, definitions: ReadonlyMap<IrValueId, IrInstr>): IrInstr | undefined {
  const seen = new Set<IrValueId>();
  while (!seen.has(value)) {
    seen.add(value);
    const row = definitions.get(value);
    if (row?.kind !== "coerce.to_externref") return row;
    value = row.value;
  }
  return undefined;
}

function classAssociation(
  source: NativeSourceClosureRequirements,
  owner: NativeInvocationUse["ownerUnitId"],
  view: "program" | "projection",
  value: IrInstr | undefined,
) {
  return value?.kind === "class.value.new"
    ? source.classValues?.find((allocation) => {
        const occurrence = source.demands.occurrences[allocation.occurrence]!;
        const region = source.demands.buffers[occurrence.bufferIndex]!;
        return region.view === view && region.ownerUnitId === owner && occurrence.instruction === value;
      })
    : undefined;
}

function projectionGap(
  source: NativeSourceClosureRequirements,
  use: Pick<NativeInvocationUse, "occurrence" | "ownerUnitId">,
  call: IrInstrCall,
  classes: readonly NonNullable<ReturnType<typeof classAssociation>>[],
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
  const definitions = new Map<IrValueId, IrInstr>();
  for (const row of source.demands.occurrences) {
    const region = source.demands.buffers[row.bufferIndex]!;
    if (region.ownerUnitId === use.ownerUnitId && region.view === "program" && row.instruction.result !== null)
      definitions.set(row.instruction.result, row.instruction);
  }
  if (
    classes.some(
      (allocation, index) =>
        classAssociation(source, use.ownerUnitId, "program", definition(original.args[index]!, definitions))
          ?.allocationId !== allocation.allocationId,
    ) ||
    original.args[2] !== call.args[2]
  )
    return "Construct operands across representations need their authenticated transformation mapping";
  return undefined;
}

/** Actual private storage and original lifted code, not public Call signature or class spelling. */
export function nativeConstructUse(
  source: NativeSourceClosureRequirements,
  use: Pick<NativeInvocationUse, "occurrence" | "ownerUnitId">,
  call: IrInstrCall,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): { readonly use: NativeInvocationUse; readonly gap?: string } {
  const result = { ...use, kind: "construct" as const };
  const values = call.args.slice(0, 2).map((value) => definition(value, definitions));
  const classes = values.map((value) => classAssociation(source, use.ownerUnitId, "projection", value));
  if (!classes[0] || !classes[1])
    return { use: result, gap: "Construct callee/newTarget needs its actual class allocation family proof" };
  const projected = projectionGap(source, use, call, [classes[0], classes[1]]);
  if (projected) return { use: result, gap: projected };
  const callee = values[0] as Extract<IrInstr, { kind: "class.value.new" }>;
  const closure = definition(callee.construct, definitions);
  if (closure?.kind !== "closure.new" || closure.liftedFunc.binding.kind !== "unit")
    return { use: result, gap: "Construct storage needs its actual source closure allocation" };
  const allocation = source.allocations.find((allocation) => {
    const occurrence = source.demands.occurrences[allocation.occurrence]!;
    const region = source.demands.buffers[occurrence.bufferIndex]!;
    return region.view === "projection" && region.ownerUnitId === use.ownerUnitId && occurrence.instruction === closure;
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
        calleeOccurrence: classes[0]!.occurrence,
        newTargetOccurrence: classes[1]!.occurrence,
        closureOccurrence: allocation.occurrence,
        argv: call.args[2]!,
      },
    },
  };
}
