// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrType } from "./nodes.js";

/** Canonical recursive key for an IR type. */
export function irTypeKey(type: IrType): string {
  const active = new Set<object>();
  const key = (current: IrType): string => {
    if (current.kind === "val") {
      if (current.val.kind === "ref" || current.val.kind === "ref_null")
        return `${current.val.kind}:${current.val.typeIdx}`;
      return current.val.kind;
    }
    if (current.kind === "string") return "string";
    if (active.has(current)) throw new Error("IR type key cannot encode a recursive anonymous layout");
    active.add(current);
    try {
      if (current.kind === "vec") return `vec<${key(current.elementType)}>${current.nullable ? "?" : ""}`;
      if (current.kind === "object") {
        return `object{${current.shape.fields.map((field) => `${field.name}:${key(field.type)}`).join(",")}}`;
      }
      if (current.kind === "closure" || current.kind === "callable") {
        const params = current.signature.params.map(key).join(",");
        return `${current.kind}(${params})->${current.signature.returnType === null ? "void" : key(current.signature.returnType)}`;
      }
      if (current.kind === "class") return `class:${current.shape.classId}`;
      if (current.kind === "extern") return `extern:${current.className}`;
      if (current.kind === "fnctor") {
        const refKey = (ref: { readonly kind: string; readonly binding: unknown }): string =>
          `${ref.kind}:${canonicalJson(ref.binding)}`;
        return `fnctor:${JSON.stringify({
          sourceId: current.shape.sourceId,
          constructorUnitId: current.shape.constructorUnitId,
          constructorTarget: refKey(current.shape.constructorTarget),
          reservedLayout: refKey(current.shape.reservedLayout),
          fields: current.shape.fields.map((field) => ({
            name: field.name,
            ordinal: field.ordinal,
            type: key(field.type),
          })),
          captures: current.shape.captures.map((capture) => ({
            name: capture.name,
            ordinal: capture.ordinal,
            hasTdzFlag: capture.hasTdzFlag,
            type: key(capture.type),
          })),
          userParamTypes: current.shape.userParamTypes.map(key),
          constructorIdentity: current.shape.constructorIdentity,
        })}`;
      }
      if (current.kind === "union") return `union<${current.members.map(key).join(",")}>`;
      if (current.kind === "dynamic") return current.tag === undefined ? "dynamic" : `dynamic:${current.tag}`;
      return `boxed<${key(current.inner)}>`;
    } finally {
      active.delete(current);
    }
  };
  return key(type);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
