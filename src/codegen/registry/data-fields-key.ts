// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FieldDef } from "../../ir/types.js";

/**
 * Shared source/IR data-layout key, before nullable storage widening.
 * Boolean/symbol i32 fields must stay distinct from numeric i32: their
 * dynamic getters box differently (#1788).
 */
export function dataFieldsHashKey(fields: readonly FieldDef[]): string {
  return fields
    .map(({ name, type }) => {
      if (type.kind === "ref" || type.kind === "ref_null") return `${name}:${type.kind}:${type.typeIdx}`;
      if (type.kind === "i32" && (type.boolean || type.symbol)) return `${name}:i32:${type.symbol ? "sym" : "bool"}`;
      return `${name}:${type.kind}`;
    })
    .join("|");
}
