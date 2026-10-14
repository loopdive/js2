// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrVectorLowering } from "./backend/handles.js";
import type { IrType } from "./core/types.js";
import type { ValType } from "./types.js";
import { IrUnsupportedError } from "./outcomes.js";
import { irVecElemSetSymbol, irVecNewSizedSymbol } from "./vector-runtime.js";

/** Compatibility carriers for actual handles, never fabricated GC coordinates. */
export function sourceVectorValueType(vec: IrVectorLowering, nullable: boolean): ValType {
  return "linearMemory" in vec
    ? { kind: "i32" }
    : (vec.valueType ?? { kind: nullable ? "ref_null" : "ref", typeIdx: vec.vecStructTypeIdx });
}

export function sourceVectorDataType(vec: IrVectorLowering): ValType {
  return "linearMemory" in vec ? { kind: "i32" } : { kind: "ref", typeIdx: vec.arrayTypeIdx };
}

export function vecElemSetProviderSymbol(type: IrType, vec: IrVectorLowering): string {
  if (type.kind === "vec") return irVecElemSetSymbol(type.elementType);
  if ("linearMemory" in vec)
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "build",
      "Linear vector provider requires a logical element type",
    );
  return `__vec_elem_set_${vec.vecStructTypeIdx}`;
}

export function vecNewSizedProviderSymbol(type: IrType, vec: IrVectorLowering): string {
  if (type.kind === "vec") return irVecNewSizedSymbol(type.elementType);
  if ("linearMemory" in vec)
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "build",
      "Linear vector provider requires a logical element type",
    );
  return `__vec_new_sized_${vec.vecStructTypeIdx}`;
}
