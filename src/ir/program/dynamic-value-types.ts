// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7561) The dynamic value's carrier, its one coercion and the realm's Boolean: a leaf every legalization builder
 * module can import, so none imports another for them (`dynamic-value-chains.ts` re-exports them).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";

/** The dynamic value's carrier, the native externref. */
export const CARRIER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });

/** The Boolean the realm's tests and `delete` answer (the chains' `TEST_RESULT` is unbranded). */
export const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** The carrier value `value` (a native string or a carrier value) into `result`, unchanged. */
export const carried = (value: IrValueId, result: IrValueId): IrInstr => ({
  kind: "coerce.to_externref",
  value,
  result,
  resultType: CARRIER,
});
