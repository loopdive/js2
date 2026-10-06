// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../../ir/types.js";
import type { FunctionContext } from "../context/types.js";

/** Keep finally bookkeeping out of source-name lookup and temporary reuse. */
export function allocFinallyPrivateLocal(fctx: FunctionContext, _name: string, type: ValType): number {
  const index = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name: `finally@private$${index}`, type });
  return index;
}
