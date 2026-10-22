// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { irVal, type IrValueId } from "./nodes.js";

function emitNativeError(builder: IrFunctionBuilder, kind: "TypeError" | "ReferenceError", message: IrValueId): void {
  const error = builder.emitCall(irRuntimeFuncRef("__new_" + kind), [message], irVal({ kind: "externref" }));
  if (error === null) throw new Error(`native ${kind} constructor returned void`);
  builder.emitThrow(error);
}

/** Throw through the canonical native TypeError constructor, preserving Wasm catch identity. */
export function emitNativeTypeError(builder: IrFunctionBuilder, message: string): void {
  const text = builder.emitCoerceToExternref(builder.emitStringConst(message));
  emitNativeError(builder, "TypeError", text);
}

/** TDZ has no supplied message; retain the existing null/absent message contract. */
export function emitNativeReferenceError(builder: IrFunctionBuilder): void {
  const type = irVal({ kind: "externref" });
  emitNativeError(builder, "ReferenceError", builder.emitConst({ kind: "null", ty: type }, type));
}
