// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7066) §7.1.17 ToString of a primitive whose family is proven, shared by the
// template literal and the string `+`: the one place the IR turns a number or
// a boolean into the string carrier.

import type { IrFunctionBuilder } from "./builder.js";
import { irTypeIsBoolean, lowerBooleanToString } from "./boolean-brand.js";
import { irIntrinsicFuncRef } from "./callable-bindings.js";
import type { IrPrimitiveExpressionFamily } from "./module-bindings.js";
import { irVal, type IrType, type IrValueId } from "./nodes.js";
import { IR_NUMBER_TO_STRING_FN } from "./string-runtime.js";

/**
 * The family a value's carrier shows: the string carrier, the boolean brand
 * (#4503), otherwise a number. Ask the brand before the carrier: a boolean and
 * a native-annotated number share the `i32` carrier.
 */
export function carrierStringFamily(type: IrType): IrPrimitiveExpressionFamily {
  if (type.kind === "string") return "string";
  return irTypeIsBoolean(type) ? "boolean" : "number";
}

/**
 * `value` as the string carrier, converted as `family`: a string as itself, a
 * boolean as `"true"` / `"false"`, a number through the lane's
 * `IR_NUMBER_TO_STRING_FN` provider (§6.1.6.1.20 Number::toString(x, 10)). An
 * integer carrier (`type i32 = number`, `type i64 = number`) widens to f64
 * first, signed, as the legacy native template arm does. `null` = the carrier
 * has no conversion as that family; the caller demotes with its own reason.
 */
export function lowerPrimitiveToString(
  builder: IrFunctionBuilder,
  value: IrValueId,
  family: IrPrimitiveExpressionFamily,
): IrValueId | null {
  const type = builder.typeOf(value);
  if (family === "string") return type.kind === "string" ? value : null;
  const scalar = type.kind === "val" ? type.val.kind : undefined;
  if (family === "boolean") return scalar === "i32" ? lowerBooleanToString(builder, value) : null;
  const f64 = irVal({ kind: "f64" });
  const asF64 =
    scalar === "f64"
      ? value
      : scalar === "i32"
        ? builder.emitUnary("f64.convert_i32_s", value, f64)
        : scalar === "i64"
          ? builder.emitUnary("f64.convert_i64_s", value, f64)
          : null;
  if (asF64 === null) return null;
  const result = builder.emitCall(irIntrinsicFuncRef(IR_NUMBER_TO_STRING_FN), [asF64], { kind: "string" });
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (result === null) throw new Error(`ir: ${IR_NUMBER_TO_STRING_FN} produced no result`);
  return result;
}
