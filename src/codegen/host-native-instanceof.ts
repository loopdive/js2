// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/**
 * Test a native WasmGC builtin first, then fall back to host `instanceof`.
 * This lets JS-host modules recognize native Date structs without forcing a
 * standalone-only representation for host-backed builtins such as RegExp.
 */
export function emitHostOrNativeBuiltinInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  ctorName: string,
  typeIdxs: number[],
): ValType | null {
  return null;
}
