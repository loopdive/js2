// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7561) The dynamic value's carrier and its one coercion: a leaf every legalization builder module can import, so
 * none imports another for them (`dynamic-value-chains.ts` re-exports both).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";

/** The dynamic value's carrier, the native externref. */
export const CARRIER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
/** A number, and the Boolean the realm's tests answer. */
export const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
export const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** The carrier value `value` (a native string or a carrier value) into `result`, unchanged. */
export const carried = (value: IrValueId, result: IrValueId): IrInstr => ({
  kind: "coerce.to_externref",
  value,
  result,
  resultType: CARRIER,
});
