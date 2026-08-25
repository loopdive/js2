// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrType } from "./nodes.js";

/** Canonical recursive key for an IR type. */
export function irTypeKey(type: IrType): string {
  if (type.kind === "val") {
    if (type.val.kind === "ref" || type.val.kind === "ref_null") {
      return `${type.val.kind}:${type.val.typeIdx}`;
    }
    return type.val.kind;
  }
  if (type.kind === "string") return "string";
  if (type.kind === "vec") return `vec<${irTypeKey(type.elementType)}>${type.nullable ? "?" : ""}`;
  if (type.kind === "object") {
    return `object{${type.shape.fields.map((field) => `${field.name}:${irTypeKey(field.type)}`).join(",")}}`;
  }
  if (type.kind === "closure") {
    const params = type.signature.params.map(irTypeKey).join(",");
    return `closure(${params})->${type.signature.returnType === null ? "void" : irTypeKey(type.signature.returnType)}`;
  }
  if (type.kind === "callable") {
    const params = type.signature.params.map(irTypeKey).join(",");
    return `callable(${params})->${type.signature.returnType === null ? "void" : irTypeKey(type.signature.returnType)}`;
  }
  if (type.kind === "class") return `class:${type.shape.classId}`;
  if (type.kind === "extern") return `extern:${type.className}`;
  if (type.kind === "fnctor") {
    return `fnctor:${JSON.stringify({
      sourceId: type.shape.sourceId,
      constructorUnitId: type.shape.constructorUnitId,
      constructorName: type.shape.constructorName,
      constructorTarget: type.shape.constructorTarget,
      reservedLayout: type.shape.reservedLayout,
      fields: type.shape.fields.map((field) => ({
        name: field.name,
        ordinal: field.ordinal,
        type: irTypeKey(field.type),
      })),
      captures: type.shape.captures.map((capture) => ({
        name: capture.name,
        ordinal: capture.ordinal,
        hasTdzFlag: capture.hasTdzFlag,
        type: irTypeKey(capture.type),
      })),
      userParamTypes: type.shape.userParamTypes.map(irTypeKey),
      constructorIdentity: type.shape.constructorIdentity,
    })}`;
  }
  if (type.kind === "union") return `union<${type.members.map(irTypeKey).join(",")}>`;
  if (type.kind === "dynamic") return type.tag === undefined ? "dynamic" : `dynamic:${type.tag}`;
  return `boxed<${irTypeKey(type.inner)}>`;
}
