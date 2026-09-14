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
  const handled = tryEmitSpreadHostArgs(ctx, fctx, expr.arguments, argsLocal, arrPushName, arrPushIdx, {
    afterValue: (arg) => {
      maybeStampCompiledFunctionArgName(ctx, fctx, arg);
    },
  });
  if (handled) return;
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

/**
 * Fill an already-created host array with a SPREAD-containing argument list,
 * expanding each spread source at its runtime length.
 *
 * Returns `false` when there is no spread (the caller keeps its own unrolled
 * per-node loop, which is exact and stays byte-identical) or when the target
 * has no substrate to expand one. Nothing is emitted in either case.
 *
 * Every host-array argument builder in the compiler is the same `__js_array_new`
 * + one `__js_array_push` per AST node shape, and every one of them sizes the
 * array from `arguments.length` — which is the right number only while each
 * argument is ONE value. This is the single place that difference is repaired,
 * so a new bridge gets the runtime count by calling here rather than by growing
 * a sixth copy of the loop.
 */
export function tryEmitSpreadHostArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  argsLocal: number,
  arrPushName: string,
  arrPushIdx: number,
  opts?: { afterValue?: (arg: ts.Expression) => void },
): boolean {
  if (!hasSpreadArgument(args)) return false;
  const built = buildSpreadArgList(ctx, fctx, args, 0, { kind: "externref" }, "hostargs", opts);
  if (!built) return false;
  // The push helper's funcidx is re-resolved by NAME: expanding a spread can
  // register late imports, which shifts every defined-function index that was
  // captured before them.
  built.emitStores({
    pre: [{ op: "local.get", index: argsLocal }],
    post: [{ op: "call", funcIdx: ctx.funcMap.get(arrPushName) ?? arrPushIdx }],
  });
  return true;
}
