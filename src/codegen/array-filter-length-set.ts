// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Standalone ArraySetLength routing for typed `Array.prototype.filter` inputs.
 *
 * A descriptor-aware array keeps its indexed attributes in the vec overlay.
 * Static `.length` assignment must therefore use the same native
 * `__vec_dp_value` path as `Object.defineProperty`, including its
 * non-configurable-index stop and strict/sloppy TypeError behavior.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { BUILTIN_TYPE_TAGS } from "./builtin-tags.js";
import { ensureExnTag } from "./registry/imports.js";
import { getOrRegisterErrorStructType } from "./registry/error-types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import { allocLocal } from "./context/locals.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import type { ts } from "../ts-api.js";

/**
 * Build the descriptor-overlay `.length` store, or return `null` when the
 * module cannot use the overlay route. The caller owns the receiver null guard
 * because prototype-shaped receivers must retain their existing no-op path.
 */
export function buildOverlayArrayLengthSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecTmp: number,
  newLenTmp: number,
  strictTarget: ts.Node,
): Instr[] | null {
  if (!ctx.standalone || !ctx.vecAccessorDescriptorDirty) return null;
  const dpValueIdx = ctx.funcMap.get("__vec_dp_value");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  if (dpValueIdx === undefined || boxNumberIdx === undefined) return null;

  const call: Instr[] = [
    { op: "local.get", index: vecTmp },
    { op: "extern.convert_any" },
    ...stringConstantExternrefInstrs(ctx, "length"),
    { op: "local.get", index: newLenTmp },
    { op: "f64.convert_i32_u" },
    { op: "call", funcIdx: boxNumberIdx },
    { op: "f64.const", value: 1 << 7 }, // HOST_HAS_VALUE
    { op: "call", funcIdx: dpValueIdx },
    { op: "drop" },
  ];

  const errorLocal = allocLocal(fctx, `__arr_len_set_err_${fctx.locals.length}`, { kind: "externref" });
  const exnTag = ensureExnTag(ctx);
  const rethrow: Instr[] = [
    { op: "local.get", index: errorLocal },
    { op: "throw", tagIdx: exnTag },
  ];
  const handler: Instr[] = [{ op: "local.set", index: errorLocal }];
  const strict = isStrictContext(strictTarget, ctx.inferModuleStrictArguments);
  if (strict) {
    handler.push(...rethrow);
  } else {
    const errorTypeIdx = getOrRegisterErrorStructType(ctx);
    handler.push(
      { op: "local.get", index: errorLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: errorTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: errorLocal },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: errorTypeIdx },
          { op: "struct.get", typeIdx: errorTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: BUILTIN_TYPE_TAGS.TypeError },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: [], else: rethrow },
        ],
        else: rethrow,
      },
    );
  }
  return [buildTargetTaggedTry(ctx, { kind: "empty" }, call, [{ tagIdx: exnTag, body: handler }])];
}
