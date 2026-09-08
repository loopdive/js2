// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { dataFieldsHashKey } from "../codegen/registry/data-fields-key.js";
import type { FieldDef } from "./types.js";
import type { IrClosureSignature, IrObjectShape, IrType } from "./nodes.js";
import { orderedObjectFields } from "./object-layout.js";

function primitiveTypeName(type: IrType): string | undefined {
  if (type.kind === "string") return "string";
  if (type.kind === "val" && type.val.kind === "f64") return "number";
  if (type.kind === "val" && type.val.kind === "i32") return "boolean";
  return undefined;
}

/** Source hash suffix for a proven explicit primitive function/method signature. */
export function primitiveSourceMethodSignature(signature: IrClosureSignature): string | undefined {
  if (signature.defaultParamStart !== undefined || signature.params.some((type) => !primitiveTypeName(type)))
    return undefined;
  const result = signature.returnType === null ? "void" : primitiveTypeName(signature.returnType);
  return result === undefined ? undefined : `${signature.params.length}->${result}`;
}

/** Preserve the source allocator's callable-field suffix, never infer it from erased storage. */
export function objectFieldsHashKey(shape: IrObjectShape, fields: readonly FieldDef[]): string {
  const methods: string[] = [];
  for (const field of orderedObjectFields(shape)) {
    if (field.sourceMethodSignature === undefined) continue;
    if (
      field.type.kind !== "callable" ||
      primitiveSourceMethodSignature(field.type.signature) !== field.sourceMethodSignature
    ) {
      throw new Error("IR object source method signature does not match its callable field");
    }
    methods.push(`${field.name}#${field.sourceMethodSignature}`);
  }
  return (
    dataFieldsHashKey(fields) + (methods.length && shape.allocationKind !== "declared" ? `||${methods.join(",")}` : "")
  );
}
