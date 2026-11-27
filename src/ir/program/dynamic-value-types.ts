// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 W2) The IR types the dynamic-value legalization writes, and its one carrier coercion: a leaf every builder
 * module imports, so none of them imports another for a constant.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";

/** The dynamic value's carrier, the native externref. */
export const CARRIER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
export const STRING: IrType = Object.freeze({ kind: "string" });
export const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
export const I32: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32" }) });
/** The Boolean the realm's tests answer. */
export const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** The carrier value `value` (a native string or a carrier value) into `result`, unchanged. */
export const carried = (value: IrValueId, result: IrValueId): IrInstr => ({
  kind: "coerce.to_externref",
  value,
  result,
  resultType: CARRIER,
});
