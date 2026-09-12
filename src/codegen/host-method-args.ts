// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The argument array of the generic `__extern_method_call(recv, name, args)`
 * host bridge (#5361).
 *
 * Extracted from `compileReceiverMethodCall`, which is one of the compiler's
 * largest functions and is under a per-function LOC ceiling (#3400). The
 * bridge's array is built by `__js_array_new` + one `__js_array_push` per
 * argument, which is exact only while every argument is a single value: a
 * SPREAD contributes its runtime element count, so `hostArr.splice(-1, 1,
 * ...src)` handed the host the source ARRAY as one inserted item — hono's
 * `expandIPv6` then read `sections[i].padStart` off an array.
 */
import type { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { maybeStampCompiledFunctionArgName } from "./expressions/helpers.js";
import { compileExpression } from "./shared.js";
import { buildSpreadArgList, hasSpreadArgument } from "./spread-arg-list.js";

/**
 * Fill `argsLocal` (an already-created host array) with the call's arguments.
 *
 * With a spread present the whole list goes through the shared
 * spread-expanding builder; without one the unrolled per-node loop is exact
 * and is kept verbatim, so a call site with no spread emits byte-identical
 * code to before.
 */
export function emitHostMethodCallArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  argsLocal: number,
  arrPushName: string,
  arrPushIdx: number,
): void {
  const spreadArgs = hasSpreadArgument(expr.arguments)
    ? buildSpreadArgList(ctx, fctx, expr.arguments, 0, { kind: "externref" }, "emc_spread", {
        afterValue: (arg) => {
          maybeStampCompiledFunctionArgName(ctx, fctx, arg);
        },
      })
    : undefined;
  if (spreadArgs) {
    // The push helper's funcidx is re-resolved by NAME: expanding a spread can
    // register late imports, which shifts every defined-function index that
    // was captured before them.
    spreadArgs.emitStores({
      pre: [{ op: "local.get", index: argsLocal }],
      post: [{ op: "call", funcIdx: ctx.funcMap.get(arrPushName) ?? arrPushIdx }],
    });
    return;
  }
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argType && argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // (#3429) A statically-name-resolvable compiled function/class argument
    // (e.g. `assert.throws(MyError, fn)`) gets its real `.name` stamped before
    // crossing — see maybeStampCompiledFunctionArgName.
    maybeStampCompiledFunctionArgName(ctx, fctx, arg);
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  }
}
