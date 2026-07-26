// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FieldDef } from "../ir/types.js";

/**
 * Descriptor contracts without a concrete value carrier belong to the open
 * `$Object` runtime. Treating their anonymous structs as closed getter arms can
 * intercept a structurally equivalent descriptor returned by the vec overlay.
 */
export function isOpenDescriptorShape(structName: string, fields: FieldDef[]): boolean {
  const valueField = fields.find((field) => field.name === "value");
  return (
    structName.startsWith("__anon_") &&
    fields.some((field) => field.name === "enumerable") &&
    (valueField === undefined || valueField.type.kind === "externref" || valueField.type.kind === "ref_extern") &&
    fields.every(
      (field) =>
        field.name.startsWith("$") ||
        field.name.startsWith("__") ||
        ["value", "writable", "enumerable", "configurable", "get", "set"].includes(field.name),
    )
  );
}
