// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrVecBackendLowering } from "./backend/handles.js";
import { irVecGcLowering } from "./backend/vector-representation.js";
import type { IrType } from "./core/types.js";
import { IrUnsupportedError } from "./outcomes.js";
import { irVecElemSetSymbol, irVecNewSizedSymbol } from "./vector-runtime.js";

// Frontend provider symbols for actual handles, never fabricated GC coordinates.
// A struct-suffixed name requires an authenticated WasmGC handle (#6920
// `irVecGcLowering`); any other physical handle without a logical element type
// is refused rather than given a substitute name.
function gcProviderStructIndex(vec: IrVecBackendLowering): number {
  const gc = irVecGcLowering(vec);
  if (!gc)
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "build",
      "Linear vector provider requires a logical element type",
    );
  return gc.vecStructTypeIdx;
}

export function vecElemSetProviderSymbol(type: IrType, vec: IrVecBackendLowering): string {
  if (type.kind === "vec") return irVecElemSetSymbol(type.elementType);
  return `__vec_elem_set_${gcProviderStructIndex(vec)}`;
}

export function vecNewSizedProviderSymbol(type: IrType, vec: IrVecBackendLowering): string {
  if (type.kind === "vec") return irVecNewSizedSymbol(type.elementType);
  return `__vec_new_sized_${gcProviderStructIndex(vec)}`;
}
