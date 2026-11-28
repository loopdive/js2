// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irBool } from "./boolean-brand.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irVal, type IrType, type IrValueId } from "./nodes.js";

/**
 * Legacy's f64 stand-ins for `undefined` (`codegen/value-tags.ts`): an f64
 * slot that holds `undefined` carries `UNDEF_F64_BITS`, an absent array
 * element `HOLE_F64_BITS` (#4491 T11). Both are signaling NaNs, so arithmetic
 * reads them as ToNumber(undefined). A reader that tells them from a NaN tests
 * the bits (an array search's holes, a default parameter's sentinel). The
 * boolean statics do not: IR f64 ops carry a NaN's payload through, so the
 * bits do not prove `undefined` there (#7106 plan, follow-up 7). A value read
 * from a slot that can hold `undefined` is the exception: its type carries
 * legacy's `undefSentinel` brand, which no IR op result has (#7464).
 */
export const F64_UNDEFINED_BITS = 0x7ff00000deadc0den;
const F64_HOLE_BITS = 0x7ff00000deadc01en;

const I32: IrType = irVal({ kind: "i32" });
const I64: IrType = irVal({ kind: "i64" });

/** Does the f64 `value` hold either marker — a JS `undefined` in an f64? A JS boolean. */
export function emitF64IsUndefined(value: IrValueId, b: IrFunctionBuilder): IrValueId {
  const bits = b.emitUnary("i64.reinterpret_f64", value, I64);
  const isUndefined = b.emitBinary("i64.eq", bits, b.emitConst({ kind: "i64", value: F64_UNDEFINED_BITS }, I64), I32);
  const isAbsent = b.emitBinary("i64.eq", bits, b.emitConst({ kind: "i64", value: F64_HOLE_BITS }, I64), I32);
  return b.emitBinary("i32.or", isUndefined, isAbsent, irBool());
}

/** (#7464) Is `value` a branded f64, read from a slot that can hold `undefined`? */
function isUndefinedCapableF64(b: IrFunctionBuilder, value: IrValueId): boolean {
  const type = b.typeOf(value);
  return type.kind === "val" && type.val.kind === "f64" && type.val.undefSentinel === true;
}

/**
 * (#7464) The string a `typeof` or a ToString of `value` gives: "undefined" when `value` is a branded f64 holding a
 * marker, else `otherwise()`.
 */
export function emitUndefinedStringOr(b: IrFunctionBuilder, value: IrValueId, otherwise: () => IrValueId): IrValueId {
  if (!isUndefinedCapableF64(b, value)) return otherwise();
  const undefinedString = (): IrValueId => b.emitStringConst("undefined");
  return b.emitIfElseValue(emitF64IsUndefined(value, b), undefinedString, otherwise, { kind: "string" });
}

/**
 * (#7464) ToNumber of the f64 `value` (unary `+`): a branded f64's marker is ToNumber(undefined), a plain NaN, so the
 * result carries no brand for a later reader to take for `undefined`.
 */
export function emitF64ToNumber(b: IrFunctionBuilder, value: IrValueId): IrValueId {
  if (!isUndefinedCapableF64(b, value)) return value;
  const f64 = irVal({ kind: "f64" });
  return b.emitSelect(emitF64IsUndefined(value, b), b.emitConst({ kind: "f64", value: NaN }, f64), value, f64);
}
