// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../context/types.js";

type EmitErrorConstructor = (ctx: CodegenContext, errorName: string, argCount: number) => void;
let emitErrorConstructor: EmitErrorConstructor | undefined;

export function registerEmitWasiErrorConstructor(fn: EmitErrorConstructor): void {
  emitErrorConstructor = fn;
}

export function emitWasiErrorConstructor(ctx: CodegenContext, errorName: string, argCount: number): void {
  if (!emitErrorConstructor) throw new Error("WASI error constructor is not registered");
  emitErrorConstructor(ctx, errorName, argCount);
}
