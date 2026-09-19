// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrObjectStructLowering } from "./backend/handles.js";
import type { IrObjectShape, IrValueId } from "./nodes.js";

/** Logical shapes stay canonical; the resolved aggregate owns physical order. */
export function objectConstructionValues(
  shape: IrObjectShape,
  values: readonly IrValueId[],
  layout: IrObjectStructLowering,
): readonly IrValueId[] {
  const ordered: IrValueId[] = [];
  if (values.length !== shape.fields.length) throw new Error("ir/lower: object layout arity mismatch");
  shape.fields.forEach((field, logicalIndex) => {
    const physicalIndex = layout.fieldIdx(field.name);
    if (
      !Number.isInteger(physicalIndex) ||
      physicalIndex < 0 ||
      physicalIndex >= values.length ||
      ordered[physicalIndex] !== undefined
    ) {
      throw new Error("ir/lower: object layout field indexes must form a permutation");
    }
    ordered[physicalIndex] = values[logicalIndex]!;
  });
  return ordered;
}
