// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "../context/types.js";
import { definedFuncAt, isImportFuncIdx } from "../func-space.js";

const NAME = "__v8x_deno_promise_reject_dispatch";

/** Authenticate the physical same-graph call target before baking its handle.
 * Missing is an opt-out. Present but uninspectable or incompatible is an error,
 * never an absent notification or an invalid-Wasm success.
 */
export function promiseRejectionDispatcher(ctx: CodegenContext): number | undefined {
  const index = ctx.funcMap.get(NAME);
  if (index === undefined) return undefined;
  const fn = isImportFuncIdx(ctx, index) ? undefined : definedFuncAt(ctx, index);
  const type = fn === undefined ? undefined : ctx.mod.types[fn.typeIdx];
  if (
    !fn ||
    ctx.asyncFunctions.has(NAME) ||
    type?.kind !== "func" ||
    type.params.length !== 3 ||
    type.params[0]?.kind !== "f64" ||
    type.params[1]?.kind !== "externref" ||
    type.params[2]?.kind !== "externref" ||
    type.results.length !== 0
  ) {
    throw new Error(
      "Deno Promise rejection dispatcher must be a synchronous defined (f64, externref, externref) -> void function",
    );
  }
  return index;
}
