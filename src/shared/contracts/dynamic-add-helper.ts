// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 Str2-c) The front end's dynamic `+` over two carrier operands, shared below codegen, which fills its
 * ordinary-pipeline body (`dyn-ops.ts`), and the IR, which emits it (`from-ast.ts`) and on the Prepared path
 * expands it (`dynamic-value-legalization.ts`).
 */
export const IR_DYN_ADD_FN = "__ir_dyn_add";
