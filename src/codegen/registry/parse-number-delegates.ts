// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../context/types.js";

type EmitNativeParseNumber = (ctx: CodegenContext, which: Set<string>) => void;
let emitNativeParseNumberImpl: EmitNativeParseNumber | undefined;

export function registerEmitNativeParseNumber(fn: EmitNativeParseNumber): void {
  emitNativeParseNumberImpl = fn;
}

export function emitNativeParseNumber(ctx: CodegenContext, which: Set<string>): void {
  if (!emitNativeParseNumberImpl) throw new Error("native parse-number emitter is not registered");
  emitNativeParseNumberImpl(ctx, which);
}
