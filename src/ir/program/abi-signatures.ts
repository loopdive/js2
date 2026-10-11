// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrClassShape, IrType } from "../core/types.js";
import { irTypeKey } from "../core/type-key.js";
import type { ProgramAbiCallableSignature } from "./abi.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

/** Semantic signature key; backend layout indices are deliberately not encoded here. */
export function preparedIrTypeKey(type: IrType): string {
  if (type.kind === "support-ref") return irTypeKey(type);
  return `${irTypeKey(type)}:${preparedIrDataKey(type)}`;
}

/** Class references use the existing nominal identity; layouts are checked separately. */
export function preparedIrDataKey(data: unknown): string {
  const active = new Set<object>();
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const typed = value as Partial<IrType>;
    if (typed.kind === "support-ref") {
      if (!typed.ref || typeof typed.nullable !== "boolean" || typed.ref.binding.kind !== "support")
        throw new PreparedIrProgramInvariantError("invalid-prepared-data", "support type lacks its declared identity");
      return { kind: "support-ref", key: preparedIrTypeKey(typed as IrType) };
    }
    if (typed.kind === "class") {
      if (!typed.shape || typeof typed.shape.classId !== "string")
        throw new PreparedIrProgramInvariantError("invalid-prepared-data", "class type lacks its declared identity");
      return { kind: "class", classId: typed.shape.classId };
    }
    if (active.has(value))
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "recursive anonymous data has no declared class identity",
      );
    active.add(value);
    try {
      if (Array.isArray(value)) return value.map(canonical);
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)]),
      );
    } finally {
      active.delete(value);
    }
  };
  return JSON.stringify(canonical(data));
}

export function preparedIrClassLayoutKey(shape: IrClassShape): string {
  return preparedIrDataKey(shape);
}

export function preparedIrCallableSignature(
  params: readonly IrType[],
  results: readonly IrType[],
): ProgramAbiCallableSignature {
  return { params: params.map(preparedIrTypeKey), results: results.map(preparedIrTypeKey) };
}
