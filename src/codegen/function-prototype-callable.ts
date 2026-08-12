// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Native callable entry point for the ES5 `%Function.prototype%` object. */

import type { Instr, WasmFunction } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/**
 * `%Function.prototype%.[[Call]]` ignores every argument and returns
 * `undefined` (ES5 §15.3.4). Calls use a zero-parameter helper because both
 * front-ends evaluate and discard source arguments before invoking it.
 */
export const FUNCTION_PROTOTYPE_CALL_HELPER = "__function_prototype_call";

export function ensureFunctionPrototypeCallHelper(ctx: CodegenContext): number | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  const existing = ctx.funcMap.get(FUNCTION_PROTOTYPE_CALL_HELPER);
  if (existing !== undefined) return existing;

  const body: Instr[] = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }], `$${FUNCTION_PROTOTYPE_CALL_HELPER}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: FUNCTION_PROTOTYPE_CALL_HELPER,
    typeIdx,
    locals: [],
    body,
    exported: false,
  } satisfies WasmFunction);
  ctx.funcMap.set(FUNCTION_PROTOTYPE_CALL_HELPER, funcIdx);
  return funcIdx;
}
