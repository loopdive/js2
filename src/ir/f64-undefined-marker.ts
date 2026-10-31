// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irBool } from "./boolean-brand.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irVal, type IrType, type IrValueId } from "./nodes.js";

/**
 * Legacy's f64 stand-ins for `undefined` (`codegen/value-tags.ts`): an f64
 * slot that holds `undefined` carries `UNDEF_F64_BITS`, an absent array
 * element `HOLE_F64_BITS` (#4491 T11). Both are signaling NaNs, so arithmetic
 * reads them as ToNumber(undefined); a reader that observes the VALUE — a
 * NaN test, SameValue, a rendering — must test the bits.
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
