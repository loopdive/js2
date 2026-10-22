// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 propertyHelper) The IR's dynamic `delete` support: one wrapper per
 * code strictness, `__ir_dyn_delete_{strict,sloppy}(externref receiver,
 * externref key) -> i32`, whose body is EXACTLY legacy's generic
 * `delete <receiver>[<key>]` arm for an externref receiver
 * (`compileDeleteExpression`, `typeof-delete.ts`):
 *
 *   1. RequireObjectCoercible(base): `emitExternrefDestructureGuard` throws the
 *      TypeError for a null / undefined receiver (§13.5.1.2 step 5.b);
 *   2. `__delete_property(receiver, key)`: the lane's OrdinaryDelete, which
 *      reports `false` for a non-configurable own property;
 *   3. strict code only: a `false` result is a TypeError (§13.5.1.2 step 6.b).
 *
 * The result is the delete's boolean. propertyHelper's `isConfigurable` and
 * `isWritable` delete through their dynamic `obj` parameter. Built in
 * `preregisterDynamicSupport`, before any Phase-3 body.
 */

import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitExternrefDestructureGuard } from "./destructuring-params.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import { publishReceiverHelper, receiverHelperContext } from "./ir-dynamic-construct.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

export const IR_DYN_DELETE_STRICT_HELPER = "__ir_dyn_delete_strict";
export const IR_DYN_DELETE_SLOPPY_HELPER = "__ir_dyn_delete_sloppy";

/** The wrapper a delete in code of this strictness calls. */
export function irDynamicDeleteHelperName(strict: boolean): string {
  return strict ? IR_DYN_DELETE_STRICT_HELPER : IR_DYN_DELETE_SLOPPY_HELPER;
}

/** Is `node` strict code, decided exactly as legacy's `compileDeleteExpression` decides it? */
export function irDeleteSiteIsStrict(node: ts.Node): boolean {
  return isStrictContext(node);
}

/**
 * Reserve (once per strictness) the wrapper the IR's dynamic delete calls.
 * Returns the function index, or undefined on the fast `$AnyValue` carrier
 * (where a dynamic value is not an externref).
 */
export function ensureIrDynamicDeleteHelper(ctx: CodegenContext, strict: boolean): number | undefined {
  if (ctx.fast) return undefined;
  const name = irDynamicDeleteHelperName(strict);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const helper = receiverHelperContext(
    name,
    [
      { name: "receiver", type: externref },
      { name: "key", type: externref },
    ],
    i32,
  );
  // 1. RequireObjectCoercible(base), exactly legacy's guard on the receiver.
  emitExternrefDestructureGuard(ctx, helper, 0);
  // 2. OrdinaryDelete through the lane's provider.
  ensureLateImport(ctx, "__delete_property", [externref, externref], [i32]);
  flushLateImportShifts(ctx, helper);
  const deleteIdx = ctx.funcMap.get("__delete_property");
  if (deleteIdx === undefined) return undefined;
  helper.body.push({ op: "local.get", index: 0 }, { op: "local.get", index: 1 }, { op: "call", funcIdx: deleteIdx });
  // 3. Strict code: a refused delete is a TypeError.
  if (strict) {
    const result = allocLocal(helper, "__del_res", i32);
    const refused: Instr[] = buildThrowJsErrorInstrs(
      ctx,
      "TypeError",
      "Cannot delete non-configurable property in strict mode",
      { flush: helper },
    );
    helper.body.push(
      { op: "local.tee", index: result },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: refused, else: [] },
      { op: "local.get", index: result },
    );
  }
  // Late imports the guard or the throw registered mid-body shift every baked index.
  flushLateImportShifts(ctx, helper);
  return publishReceiverHelper(ctx, helper, [i32]);
}
