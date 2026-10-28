// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type {
  NativeStringValueBuffer,
  NativeStringValueDemands,
  NativeStringValueView,
} from "./native-string-value-demands.js";

export interface NativeValueOccurrence {
  readonly instruction: IrInstr;
  readonly occurrence: number;
}

export type NativeValueRepresentation = "semantic" | "execution";

/** The runtime states implement the retained plan; they do not share its definition table. */
export function nativeValueBufferSelected(
  demands: NativeStringValueDemands,
  buffer: NativeStringValueBuffer,
  representation: NativeValueRepresentation = "execution",
): boolean {
  const owner = demands.owners.find((row) => row.unitId === buffer.ownerUnitId);
  if (!owner) throw Error("native value definitions: missing buffer owner");
  const fn = buffer.view === "program" ? owner.programFunction : owner.projectedFunction;
  if (fn.asyncRuntime && !fn.asyncPlan)
    throw Error("native value definitions: runtime states lack their semantic plan");
  const asyncRoot = representation === "execution" && fn.asyncRuntime ? "async-runtime" : "async-plan";
  return buffer.root.kind === "block" || buffer.root.kind === asyncRoot;
}

/** Index value-producing instructions in one owner's current representation. */
export function indexNativeValueDefinitions(
  demands: NativeStringValueDemands,
  unit: IrUnitId,
  view: NativeStringValueView,
  ambiguous: () => never,
  representation: NativeValueRepresentation = "execution",
) {
  const definitions = new Map<IrValueId, NativeValueOccurrence>();
  for (const [occurrence, row] of demands.occurrences.entries()) {
    const region = demands.buffers[row.bufferIndex]!;
    if (
      region.ownerUnitId !== unit ||
      region.view !== view ||
      !nativeValueBufferSelected(demands, region, representation)
    )
      continue;
    if (row.instruction.result === null) continue;
    const value = { instruction: row.instruction, occurrence };
    if (definitions.has(row.instruction.result)) ambiguous();
    definitions.set(row.instruction.result, value);
  }
  return { definitions };
}

/** Follow representation erasure only; a storage read or call needs a separate producer proof. */
export function nativeValueOriginal(
  value: IrValueId,
  definitions: ReadonlyMap<IrValueId, NativeValueOccurrence>,
  cyclic: () => never,
): NativeValueOccurrence | undefined {
  const seen = new Set<IrValueId>();
  for (;;) {
    if (seen.has(value)) cyclic();
    seen.add(value);
    const row = definitions.get(value);
    if (row?.instruction.kind !== "coerce.to_externref") return row;
    value = row.instruction.value;
  }
}
