// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { irVal } from "./nodes.js";

/** Throw the shared native TypeError instance, preserving Wasm catch identity. */
export function emitNativeTypeError(builder: IrFunctionBuilder, message: string): void {
  const text = builder.emitCoerceToExternref(builder.emitStringConst(message));
  const error = builder.emitCall(irRuntimeFuncRef("__new_TypeError"), [text], irVal({ kind: "externref" }));
  if (error === null) throw new Error("native TypeError constructor returned void");
  builder.emitThrow(error);
}
