// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrType } from "./nodes.js";

/** Short debug string for an IrType, used in error messages (from-ast and the function-object lowering). */
export function describeIrType(t: IrType): string {
  if (t.kind === "support-ref") return `support-ref<${t.ref.binding.bindingId}>${t.nullable ? "?" : ""}`;
  if (t.kind === "val") return t.val.kind;
  if (t.kind === "string") return "string";
  if (t.kind === "vec") return `vec<${describeIrType(t.elementType)}>${t.nullable ? "?" : ""}`;
  if (t.kind === "object") {
    return `object{${t.shape.fields.map((f) => `${f.name}:${describeIrType(f.type)}`).join(",")}}`;
  }
  if (t.kind === "closure" || t.kind === "callable") {
    const ps = t.signature.params.map(describeIrType).join(",");
    return `${t.kind}(${ps})->${t.signature.returnType === null ? "void" : describeIrType(t.signature.returnType)}`;
  }
  if (t.kind === "class") return `class<${t.shape.className}>`;
  if (t.kind === "extern") return `extern<${t.className}>`;
  if (t.kind === "fnctor") return `fnctor<${t.shape.constructorName}>`;
  // #1926 — union members / boxed inner are IrTypes; recurse.
  if (t.kind === "union") return `union<${t.members.map(describeIrType).join(",")}>`;
  // #2949 — dynamic leaf; render the optional tag refinement when present.
  if (t.kind === "dynamic") return t.tag === undefined ? "dynamic" : `dynamic<tag:${t.tag}>`;
  return `boxed<${describeIrType(t.inner)}>`;
}
