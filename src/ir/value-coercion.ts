// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFunctionBuilder } from "./builder.js";
import type { IrValueId } from "./nodes.js";

/** Preserve an existing externref or cross the abstract anyref boundary once. */
export function coerceIrValueToExternref(builder: IrFunctionBuilder, value: IrValueId): IrValueId {
  const type = builder.typeOf(value);
  return type.kind === "val" && type.val.kind === "externref" ? value : builder.emitCoerceToExternref(value);
}
