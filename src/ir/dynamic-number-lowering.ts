// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { emitToNumber } from "../codegen/coercion-engine.js";
import type { CodegenContext, FunctionContext } from "../codegen/context/types.js";
import { tryEmitFastToNumber } from "../codegen/tonumber-fast-paths.js";
import type { Instr } from "./types.js";

/** Emit canonical externref ToNumber into a detached IR lowering buffer. */
export function emitExternrefDynamicToNumber(ctx: CodegenContext, scratch?: () => number): readonly Instr[] {
  const shim = { body: [], savedBodies: [] } as unknown as FunctionContext;
  if (scratch && tryEmitFastToNumber(ctx, shim, "number", scratch)) return shim.body;
  emitToNumber(ctx, shim, { kind: "externref" });
  return shim.body;
}
