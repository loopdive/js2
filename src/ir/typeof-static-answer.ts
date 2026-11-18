// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7361) The static answer of `typeof <operand>`.
 *
 * from-ast lowers a `typeof` operand under an f64 hint, so the operand's IR type says what the lowering made of
 * the value, not what the value is: `void 0` (undefined) lowers to an f64 and would read as "number". The IR
 * type alone therefore cannot answer. The answer is static only when the operand's SOURCE type agrees with it,
 * or when the source type is `undefined`/`void`, which every lowering of it holds (the operand is still lowered
 * for its effects). Any other disagreement is not provable here.
 */
import type { JsTag } from "../checker/oracle.js";
import type { IrType } from "./core/types.js";

export type StaticTypeof =
  /** Every value of the operand has this tag. */
  | { readonly kind: "static"; readonly tag: string }
  /** The IR type holds values of several tags: a runtime dispatch decides. */
  | { readonly kind: "varies" }
  /** The IR type has one tag but the source type does not prove it (a hint or a coercion made it). */
  | { readonly kind: "unproven"; readonly irTag: string; readonly sourceTag: string };

/** The tag every value of an IR type has, or `null` when it varies (unions, boxed values, references). */
function irTypeofTag(type: IrType): string | null {
  if (type.kind === "string") return "string";
  if (type.kind === "vec") return "object";
  if (type.kind === "val") {
    if (type.val.kind === "f64" || type.val.kind === "f32" || type.val.kind === "i64") return "number";
    if (type.val.kind === "i32") return "boolean"; // i32 represents bool in slice 1
  }
  return null;
}

/** `sourceTag` is the oracle's `uniformJsTagOfFact` of the operand's type ("mixed" without an oracle). */
export function staticTypeofOf(irType: IrType, sourceTag: JsTag | "mixed"): StaticTypeof {
  const irTag = irTypeofTag(irType);
  if (irTag === null) return { kind: "varies" };
  if (sourceTag === irTag || sourceTag === "undefined") return { kind: "static", tag: sourceTag };
  return { kind: "unproven", irTag, sourceTag };
}
