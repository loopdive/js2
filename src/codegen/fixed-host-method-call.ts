// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "./context/types.js";

/** Whether body compilation retained any fixed-arity dynamic method bridge. */
export function hasFixedHostMethodCallImport(ctx: CodegenContext): boolean {
  return [0, 1, 2, 3, 4].some((arity) => ctx.funcMap.has(`__extern_method_call_${arity}`));
}
