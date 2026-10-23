// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../identity.js";
import type { NativeStringValueDemands, NativeStringValueView } from "./native-string-value-demands.js";

export interface NativeValueOccurrence {
  readonly instruction: IrInstr;
  readonly occurrence: number;
}

/** One owner's current view; void occurrences remain available for effects and early returns. */
export function indexNativeValueDefinitions(
  demands: NativeStringValueDemands,
  unit: IrUnitId,
  view: NativeStringValueView,
  ambiguous: () => never,
) {
  const rows: NativeValueOccurrence[] = [],
    definitions = new Map<IrValueId, NativeValueOccurrence>();
  for (const [occurrence, row] of demands.occurrences.entries()) {
    const region = demands.buffers[row.bufferIndex]!;
    if (region.ownerUnitId !== unit || region.view !== view) continue;
    const value = { instruction: row.instruction, occurrence };
    rows.push(value);
    if (row.instruction.result === null) continue;
    if (definitions.has(row.instruction.result)) ambiguous();
    definitions.set(row.instruction.result, value);
  }
  return { rows, definitions };
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
