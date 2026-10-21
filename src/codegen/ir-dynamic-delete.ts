// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 S2d) The host-free lane's `dyn.delete_property` support: two
 * wrappers, `__ir_delete_property` / `__ir_delete_property_strict`
 * `(receiver: externref, key: externref) -> i32`, whose bodies are EXACTLY
 * legacy's generic `delete <base>[<key>]` tail (`compileDeleteExpression`,
 * the non-struct `__delete_property` arm in `typeof-delete.ts`) for a
 * receiver that is neither `this` nor the `arguments` object:
 *
 *   1. RequireObjectCoercible(base) — `emitExternrefDestructureGuard` on the
 *      receiver (a null/undefined base throws TypeError, §13.5.1.2 step 5.b);
 *   2. `__delete_property(receiver, key)` → the OrdinaryDelete boolean;
 *   3. strict code only: a refused delete (`false`) throws TypeError
 *      (§13.5.1.2 step 6.b, legacy's `emitStrictDeleteCheck`).
 *
 * Measured 2026-10-21 on propertyHelper's `isConfigurable` (`delete
 * obj[name];`, both operands untyped parameters): legacy stashes both
 * operands, runs the guard, calls `__delete_property` and, in strict code,
 * the refusal throw — the sequence these wrappers hold verbatim.
 *
 * The wrappers exist so the IR's dynamic-lowering handle stays an opaque
 * `Instr[]` (the legacy guard and throw helpers write through a
 * FunctionContext). Built in `preregisterDynamicSupport`, before any Phase-3
 * body.
 */

import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { flushLateImportShifts } from "./shared.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { emitExternrefDestructureGuard } from "./destructuring-params.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";

export const IR_DELETE_PROPERTY_HELPER = "__ir_delete_property";
export const IR_DELETE_PROPERTY_STRICT_HELPER = "__ir_delete_property_strict";

/**
 * Reserve (once per strictness) the wrapper the IR `dyn.delete_property`
 * lowering calls. Returns the function index, or undefined off the host-free
 * lanes or when the delete runtime cannot be registered.
 */
export function ensureIrDynamicDeleteHelper(ctx: CodegenContext, strict: boolean): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const name = strict ? IR_DELETE_PROPERTY_STRICT_HELPER : IR_DELETE_PROPERTY_HELPER;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const helper: FunctionContext = {
    name,
    params: [
      { name: "receiver", type: externref },
      { name: "key", type: externref },
    ],
    locals: [],
    localMap: new Map(),
    returnType: i32,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  emitExternrefDestructureGuard(ctx, helper, 0);
  const deleteIdx = ensureLateImport(ctx, "__delete_property", [externref, externref], [i32]);
  flushLateImportShifts(ctx, helper);
  if (deleteIdx === undefined) return undefined;
  helper.body.push({ op: "local.get", index: 0 }, { op: "local.get", index: 1 });
  helper.body.push({ op: "call", funcIdx: ctx.funcMap.get("__delete_property") ?? deleteIdx });
  if (strict) {
    const result = allocLocal(helper, "__del_res", i32);
    helper.body.push(
      { op: "local.tee", index: result },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot delete non-configurable property in strict mode", {
          flush: helper,
        }),
        else: [],
      },
      { op: "local.get", index: result },
    );
  }
  // Late imports the throw helper registered mid-body shift every baked index.
  flushLateImportShifts(ctx, helper);

  const typeIdx = addFuncType(ctx, [externref, externref], [i32]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: helper.locals,
    body: helper.body,
    exported: false,
  });
  return funcIdx;
}
