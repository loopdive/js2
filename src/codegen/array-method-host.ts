// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/** Invoke an Array method on a real host-owned Array carried as externref. */
export function compileArrayMethodExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  methodName: string,
): ValType | null {
  const externref: ValType = { kind: "externref" };
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externref]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [externref, externref], []);
  const methodCallIdx = ensureLateImport(ctx, "__extern_method_call", [externref, externref, externref], [externref]);
  addStringConstantGlobal(ctx, methodName);
  flushLateImportShifts(ctx, fctx);
  if (arrNewIdx === undefined || arrPushIdx === undefined || methodCallIdx === undefined) return null;

  const recvLocal = allocLocal(fctx, `__array_ext_recv_${fctx.locals.length}`, externref);
  const recvType = compileExpression(ctx, fctx, propAccess.expression, externref);
  if (recvType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, externref);
  fctx.body.push({ op: "local.set", index: recvLocal }, { op: "call", funcIdx: arrNewIdx });

  const argsLocal = allocLocal(fctx, `__array_ext_args_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of callExpr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, externref);
    if (argType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, externref);
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  }

  fctx.body.push(
    { op: "local.get", index: recvLocal },
    ...stringConstantExternrefInstrs(ctx, methodName),
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: methodCallIdx },
  );
  return externref;
}

/**
 * The JS-host `arr.concat(arg…)` bridge for operands that are not statically
 * known WasmGC arrays. Uses `__array_concat_any(receiver_ext, args_js_array)`,
 * which:
 * 1. Converts the WasmGC receiver to a real JS array via `__vec_len`/`__vec_get`
 *    exports;
 * 2. Calls `Array.prototype.concat` with all arguments (so the host owns
 *    `Symbol.isConcatSpreadable`, species and hole semantics);
 * 3. Returns the result as externref (a new JS Array).
 *
 * (#4446) Moved here from `array-methods.ts` UNCHANGED when the dynamic concat
 * fallback became a per-target switch — this is the JS-host half; the host-free
 * half is `array-concat-spec.ts` and `array-methods.ts` keeps only the dispatch.
 * That the move is behaviour-neutral was measured, not assumed: compiling all
 * 69 `built-ins/Array/prototype/concat` test262 files for the gc lane before
 * and after yields byte-identical binaries (sha256 of `result.binary`, 69/69).
 */
export function compileArrayConcatExternHost(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  // __array_concat_any(receiver: externref, args: externref) -> externref
  // Converts WasmGC receiver to JS array, then calls .concat(...args)
  const concatAnyIdx = ensureLateImport(
    ctx,
    "__array_concat_any",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);

  if (arrNewIdx === undefined || arrPushIdx === undefined || concatAnyIdx === undefined) {
    return null;
  }

  // Compile receiver as externref (WasmGC vec struct → extern ref), save to local
  const recvLocal = allocLocal(fctx, `__cat_ext_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Build JS args array from all concat arguments
  fctx.body.push({ op: "call", funcIdx: arrNewIdx });
  const argsLocal = allocLocal(fctx, `__cat_ext_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argsLocal });

  for (const arg of callExpr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  }

  // Call __array_concat_any(receiver_ext, args_array) -> externref JS array
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: concatAnyIdx });
  return { kind: "externref" };
}
