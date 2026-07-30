// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FieldDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

export const FNCTOR_CONSTRUCTOR_FIELD = "$constructor";

/**
 * Append compiler-owned fields after every source field. Presence bits remain
 * ahead of the constructor identity so existing source and presence indices
 * stay stable.
 */
export function appendFnctorInternalFields(
  ctx: CodegenContext,
  fields: FieldDef[],
  onlyConditional: ReadonlyMap<string, boolean>,
): void {
  for (const field of fields.filter((candidate) => onlyConditional.get(candidate.name) === true)) {
    field.presenceTracked = true;
    fields.push({ name: `$has_${field.name}`, type: { kind: "i32" }, mutable: true });
  }
  if (ctx.standalone) {
    fields.push({ name: FNCTOR_CONSTRUCTOR_FIELD, type: { kind: "externref" }, mutable: false });
  }
}

/**
 * Map a physical closed-struct field to its JavaScript getter name. Compiler
 * fields stay hidden except for the fnctor constructor back-pointer, which
 * models the inherited, non-enumerable `prototype.constructor` property.
 */
export function exposedClosedStructFieldName(fieldName: string | undefined): string | undefined {
  if (fieldName === FNCTOR_CONSTRUCTOR_FIELD) return "constructor";
  if (!fieldName || fieldName.startsWith("$") || fieldName.startsWith("__")) return undefined;
  return fieldName;
}
