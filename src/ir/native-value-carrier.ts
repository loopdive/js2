// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { irTypeIsBoolean } from "./boolean-brand.js";
import { asVal, irVal, irDynamic, type IrValueId } from "./nodes.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { coerceIrNumeric } from "./numeric-slot-coercion.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { IrPrimitiveExpressionFamily } from "./module-bindings.js";

/** Preserve the source brand at the native value boundary. */
export function boxNativeValue(
  builder: IrFunctionBuilder,
  value: IrValueId,
  family: IrPrimitiveExpressionFamily | undefined,
  carrier: "dynamic" | "externref" = "dynamic",
): IrValueId {
  const type = builder.typeOf(value);
  if (type.kind === "dynamic" || type.kind === "extern" || type.kind === "callable") return value;
  if (type.kind === "string")
    return carrier === "externref"
      ? builder.emitCoerceToExternref(value)
      : builder.emitBox(value, irDynamic(JS_TAG_IDS.String));
  if (type.kind === "closure") return builder.emitCallablePack(value, type.signature);
  const val = asVal(type);
  if (irTypeIsBoolean(type) || (val?.kind === "i32" && family === "boolean")) {
    return carrier === "externref"
      ? builder.emitIntrinsic("js.boolean.box", [value])
      : builder.emitBox(value, irDynamic(JS_TAG_IDS.Boolean));
  }
  if (val?.kind === "f64" || (val?.kind === "i32" && family === "number")) {
    const number = val.kind === "i32" ? coerceIrNumeric(builder, value, irVal({ kind: "f64" })) : value;
    if (number !== null)
      return carrier === "externref"
        ? builder.emitIntrinsic("js.number.box", [number])
        : builder.emitBox(number, irDynamic(JS_TAG_IDS.NumberF64));
  }
  if (
    type.kind === "object" ||
    type.kind === "class" ||
    type.kind === "vec" ||
    val?.kind === "externref" ||
    val?.kind === "ref" ||
    val?.kind === "ref_null" ||
    val?.kind === "eqref" ||
    val?.kind === "anyref"
  )
    return builder.emitCoerceToExternref(value);
  throw new IrUnsupportedError("operand-coercion-unsupported", "build", "native value has no certified boxing carrier");
}
