// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 S1c) The host-free lane's `dyn.string_carrier` support: one wrapper,
 * `__ir_string_carrier(externref) -> (ref null $AnyString)`, whose body is
 * EXACTLY legacy's `coerceType(externref → $AnyString)` ladder — the checked
 * recovery of the native string carrier from a dynamic value that legacy emits
 * for `return <externref>` into a string-registered result (`ref.test
 * $AnyString` → cast; a boxed `new String(…)` wrapper's [[StringData]] via
 * `__wrapper_string_value`; the `$AnyValue` tag-5 payload; null otherwise).
 * It is NOT ToString: no user `toString`/`valueOf` runs.
 *
 * Measured 2026-10-21 on assert.js's `formatSimpleValue`: legacy registers it
 * `(param externref) (result (ref null $AnyString))` and coerces the dynamic
 * `basic` local exactly this way at `return basic`.
 *
 * The wrapper exists so the IR's dynamic-lowering handle stays an opaque
 * `Instr[]` (the legacy ladder writes through a FunctionContext). Built in
 * `preregisterDynamicSupport`, before any Phase-3 body.
 */

import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";
import { ensureWrapperStringValueHelper } from "./object-runtime.js";
import { noJsHost } from "./js-errors.js";

export const IR_STRING_CARRIER_HELPER = "__ir_string_carrier";

/**
 * Reserve (once) the wrapper the IR `dyn.string_carrier` lowering calls.
 * Returns the function index, or undefined off the native-string host-free lanes.
 */
export function ensureIrStringCarrierHelper(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx) || !ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return undefined;
  const existing = ctx.funcMap.get(IR_STRING_CARRIER_HELPER);
  if (existing !== undefined) return existing;

  const externref: ValType = { kind: "externref" };
  const anyStr: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  const helper: FunctionContext = {
    name: IR_STRING_CARRIER_HELPER,
    params: [{ name: "value", type: externref }],
    locals: [],
    localMap: new Map(),
    returnType: anyStr,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // The wrapper-string arm of the ladder is taken only when the object runtime
  // already owns `__wrapper_string_value`; ask once so the body sees the same
  // module state a legacy return site compiled at this point would see.
  ensureWrapperStringValueHelper(ctx);
  helper.body.push({ op: "local.get", index: 0 });
  coerceType(ctx, helper, externref, anyStr);
  // Late imports the ladder registered mid-body shift every baked call index.
  flushLateImportShifts(ctx, helper);

  const typeIdx = addFuncType(ctx, [externref], [anyStr]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(IR_STRING_CARRIER_HELPER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: IR_STRING_CARRIER_HELPER,
    typeIdx,
    locals: helper.locals,
    body: helper.body,
    exported: false,
  });
  return funcIdx;
}
