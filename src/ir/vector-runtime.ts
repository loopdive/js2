// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { asVal, type IrType } from "./nodes.js";
import type { ValType } from "./types.js";

export const IR_VEC_ELEM_SET_PREFIX = "__ir_vec_elem_set_";
export const IR_VEC_NEW_SIZED_PREFIX = "__ir_vec_new_sized_";
/** Dedicated sparse `new Array(n)` allocator; never aliases generic vec allocation. */
export const IR_HOLEY_ARRAY_NEW = "__ir_holey_array_new";
/** Dedicated grow-and-store provider for the branded sparse carrier. */
export const IR_HOLEY_ARRAY_ELEM_SET = "__ir_holey_array_elem_set";

export type IrVectorRuntimeElementKind = "f64" | "i32" | "externref";

/** Return the runtime-specializable scalar carried by a logical IR vector. */
export function irVectorRuntimeElementKind(type: IrType): IrVectorRuntimeElementKind | null {
  const value = asVal(type);
  return value?.kind === "f64" || value?.kind === "i32" || value?.kind === "externref" ? value.kind : null;
}

function requireRuntimeElementKind(type: IrType, operation: string): IrVectorRuntimeElementKind {
  const kind = irVectorRuntimeElementKind(type);
  if (!kind) throw new Error(`${operation} does not support IR vector element type '${type.kind}'`);
  return kind;
}

/** Backend-neutral grow-and-store provider identity. */
export function irVecElemSetSymbol(elementType: IrType): string {
  return `${IR_VEC_ELEM_SET_PREFIX}${requireRuntimeElementKind(elementType, "vector element store")}`;
}

/** Backend-neutral sized-vector provider identity. */
export function irVecNewSizedSymbol(elementType: IrType): string {
  return `${IR_VEC_NEW_SIZED_PREFIX}${requireRuntimeElementKind(elementType, "sized vector allocation")}`;
}

/** Decode a backend-neutral vector provider into its final scalar ABI type. */
export function parseIrVectorRuntimeElement(
  symbol: string,
  prefix: typeof IR_VEC_ELEM_SET_PREFIX | typeof IR_VEC_NEW_SIZED_PREFIX,
): ValType | null {
  const suffix = symbol.startsWith(prefix) ? symbol.slice(prefix.length) : "";
  return suffix === "f64" || suffix === "i32" || suffix === "externref" ? { kind: suffix } : null;
}
