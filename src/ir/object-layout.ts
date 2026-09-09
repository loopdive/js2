// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrObjectShape } from "./nodes.js";

/** Resolve the declared data-layout order without changing canonical logical fields. */
export function orderedObjectFields(shape: IrObjectShape): IrObjectShape["fields"] {
  if (!shape.fieldOrder) return shape.fields;
  const byName = new Map(shape.fields.map((field) => [field.name, field]));
  if (shape.fieldOrder.length !== shape.fields.length || byName.size !== shape.fields.length) {
    throw new Error("IR object field order must name every field exactly once");
  }
  return shape.fieldOrder.map((name) => {
    const field = byName.get(name);
    if (!field) throw new Error("IR object field order must name every field exactly once");
    byName.delete(name);
    return field;
  });
}
