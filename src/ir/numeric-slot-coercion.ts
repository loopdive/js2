// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { irTypeIsBoolean } from "./boolean-brand.js";
import { irVal, type IrType, type IrValueId } from "./nodes.js";

const F64 = irVal({ kind: "f64" });
const i32Zero = (builder: IrFunctionBuilder): IrValueId =>
  builder.emitConst({ kind: "i32", value: 0 }, irVal({ kind: "i32" }));

/** Native numeric slots exclude Boolean and Symbol handles despite their i32 storage. */
export function isNumericIrSlot(type: IrType): boolean {
  return (
    type.kind === "val" &&
    (type.val.kind === "f64" || (type.val.kind === "i32" && !type.val.boolean && !type.val.symbol))
  );
}

/**
 * Convert a numeric slot's value into another numeric slot. A boolean is not a
 * number here: a plain write stores the value itself (`o.n = true` keeps
 * `true`), so it stays with the caller's own representation check.
 */
export function coerceIrNumeric(
  builder: IrFunctionBuilder,
  value: IrValueId,
  target: IrType,
  nativeDomains: boolean,
): IrValueId | null {
  return isNumericIrSlot(builder.typeOf(value)) ? convertIrNumeric(builder, value, target, nativeDomains) : null;
}

/**
 * ToNumber into a numeric slot, for the consumers that apply it: a compound
 * update's operands and a declared number result. A boolean converts to its
 * 0 or 1.
 */
export function coerceIrToNumber(
  builder: IrFunctionBuilder,
  value: IrValueId,
  target: IrType,
  nativeDomains: boolean,
): IrValueId | null {
  const from = builder.typeOf(value);
  return isNumericIrSlot(from) || irTypeIsBoolean(from)
    ? convertIrNumeric(builder, value, target, nativeDomains)
    : null;
}

/**
 * Use the existing canonical bitwise IR for native integer domain conversions.
 * Without `nativeDomains` (the gc lane) int32/uint32 domains are not recovered:
 * narrowing saturates and a uint32 value does not widen, as before #7137.
 */
function convertIrNumeric(
  builder: IrFunctionBuilder,
  value: IrValueId,
  target: IrType,
  nativeDomains: boolean,
): IrValueId | null {
  const from = builder.typeOf(value);
  if (!isNumericIrSlot(target) || from.kind !== "val" || target.kind !== "val") return null;
  if (nativeDomains && target.val.kind === "i32" && (target.signed === false || target.val.int32)) {
    return builder.emitBinary(target.signed === false ? "js.shr_u" : "js.bitor", value, i32Zero(builder), target);
  }
  if (from.val.kind === "f64" && target.val.kind === "i32") {
    return builder.emitUnary("i32.trunc_sat_f64_s", value, target);
  }
  if (from.val.kind === "i32" && target.val.kind === "f64") {
    if (from.signed === false)
      return nativeDomains ? builder.emitBinary("js.shr_u", value, i32Zero(builder), target) : null;
    return builder.emitUnary("f64.convert_i32_s", value, target);
  }
  return null;
}

/** A uint32 field's source value is nonnegative, regardless of its i32 storage bits. */
export function numericFieldSourceValue(builder: IrFunctionBuilder, value: IrValueId): IrValueId {
  const type = builder.typeOf(value);
  return type.kind === "val" && type.val.kind === "i32" && type.signed === false
    ? (coerceIrNumeric(builder, value, F64, true) ?? value)
    : value;
}

/** Compute in source Number space, then convert once into the physical field slot. */
export function numericFieldUpdate(
  builder: IrFunctionBuilder,
  previous: IrValueId,
  rhs: IrValueId,
  target: IrType,
  emitNumber: (lhs: IrValueId, rhs: IrValueId) => IrValueId,
): IrValueId | null {
  if (!isNumericIrSlot(target)) return null;
  const lhsType = builder.typeOf(previous);
  const lhsNumber =
    lhsType.kind === "val" && lhsType.val.kind === "f64" ? previous : coerceIrToNumber(builder, previous, F64, true);
  const rhsType = builder.typeOf(rhs);
  const rhsNumber =
    rhsType.kind === "val" && rhsType.val.kind === "f64" ? rhs : coerceIrToNumber(builder, rhs, F64, true);
  if (lhsNumber === null || rhsNumber === null) return null;
  const value = emitNumber(lhsNumber, rhsNumber);
  return target.kind === "val" && target.val.kind === "f64" ? value : coerceIrNumeric(builder, value, target, true);
}
