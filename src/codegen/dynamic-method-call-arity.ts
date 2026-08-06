// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Host dynamic-call arity accounting for `arguments`-consuming closures. */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

export function observeHostDynamicMethodCallArity(ctx: CodegenContext, args: readonly ts.Expression[]): void {
  if (ctx.standalone || ctx.wasi || args.some(ts.isSpreadElement)) return;
  ctx.maxHostDynamicMethodCallArity = Math.max(ctx.maxHostDynamicMethodCallArity ?? 0, args.length);
}
