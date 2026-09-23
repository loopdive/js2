// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { FieldDef, StructTypeDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { recordClassFieldProvenance } from "./class-field-provenance.js";

/**
 * Install one completed class struct and expose that exact allocator object to
 * the structural ABI sidecar at the same ownership boundary.
 */
export function commitClassStructLayout(
  ctx: CodegenContext,
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  displayName: string,
  typeIndex: number,
  type: StructTypeDef,
  fields: FieldDef[],
  fieldCollection?: Parameters<typeof recordClassFieldProvenance>[2],
): void {
  ctx.mod.types[typeIndex] = type;
  ctx.structFields.set(displayName, fields);
  if (ctx.programAbiSession && !ctx.programAbiTypes) {
    throw new TypeError(`program ABI class layout ${displayName} has no planning identity context`);
  }
  ctx.programAbiTypes?.observeClass(declaration, displayName, type);
  if (fieldCollection) recordClassFieldProvenance(ctx, type, fieldCollection);
}
