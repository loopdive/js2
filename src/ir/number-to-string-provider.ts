// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4467) The per-lane provider behind `IR_NUMBER_TO_STRING_FN` — §7.1.17
// `Number::toString(value, 10)` as one callable whose result is the LANE's
// string carrier.

import { ensureLateImport } from "../codegen/shared.js";
import { ensureNativeStringHelpers } from "../codegen/native-strings.js";
import { emitNativeNumberFormat, irNativeNumberToFixedAvailable } from "../codegen/number-format-native.js";
import { mintDefinedFunc, pushDefinedFunc } from "../codegen/func-space.js";
import { addFuncType } from "../codegen/registry/types.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { IR_NUMBER_TO_FIXED_FN, IR_NUMBER_TO_STRING_FN } from "./string-runtime.js";

export { IR_NUMBER_TO_FIXED_FN, IR_NUMBER_TO_STRING_FN };

/**
 * Resolve `IR_NUMBER_TO_STRING_FN` to a function index for this compile.
 *
 * Host lane: `env.number_toString` `(f64) -> externref` already hands back a
 * real JS string, which IS the host carrier, so the import is the provider.
 *
 * Native lane: since #3912 the formatter is the NATIVE one emitted by
 * `emitNativeNumberFormat`, and its `externref` result is an `$AnyString`
 * merely widened by `extern.convert_any` — NOT a host string. Recovering the
 * carrier is `any.convert_extern` + `ref.cast $AnyString`; the legacy template
 * arm does exactly this inline (`emitNativeStringRefFromExternref`,
 * codegen/string-ops.ts). Running the `__str_from_extern` HOST bridge over that
 * box instead reads it as a JS string and silently yields the empty string —
 * that confusion is what made `` `v${3}` `` evaluate to `"v"` before #3912.
 *
 * With adapter inlining disabled (including report/count/poison controls), the
 * unbox lives in a minted `(f64) -> (ref $AnyString)` thunk so the intrinsic's
 * IR-visible signature remains carrier-correct without a lowering-mode check.
 * The shipped tuned path binds the semantic provider directly to the raw
 * formatter and asks the IR emitter to append the same two carrier operations
 * at the call site, avoiding a retained representation-only thunk.
 *
 * Returns `null`/`undefined` when the lane cannot bind a provider; the caller
 * turns that into the usual `unknown-function-ref` invariant.
 */
export function ensureIrNumberToStringProvider(ctx: CodegenContext, fuseCarrier = false): number | null | undefined {
  if (!ctx.nativeStrings) {
    return ensureLateImport(ctx, "number_toString", [{ kind: "f64" }], [{ kind: "externref" }]);
  }
  ensureNativeStringHelpers(ctx);
  emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  const formatter = ctx.funcMap.get("number_toString");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (formatter === undefined || anyStrTypeIdx < 0) return null;
  if (fuseCarrier) return formatter;
  const existing = ctx.funcMap.get(IR_NUMBER_TO_STRING_FN);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "ref", typeIdx: anyStrTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: IR_NUMBER_TO_STRING_FN,
    typeIdx: sigIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: formatter },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
    ],
    exported: false,
  });
  ctx.funcMap.set(IR_NUMBER_TO_STRING_FN, funcIdx);
  return funcIdx;
}

/**
 * Resolve `IR_NUMBER_TO_FIXED_FN` to the native `(f64, f64) -> string`
 * provider for this compile.
 *
 * The native formatter deliberately retains the legacy host-compatible
 * `(f64, f64) -> externref` ABI, but that externref wraps an `$AnyString`
 * rather than a JavaScript string. Control modes retain a stable thunk after
 * all formatter dependencies have been emitted; the tuned path instead
 * returns the raw provider and lets lowering fuse the exact carrier recovery.
 * Dependency-first materialization is load-bearing in either case: no baked
 * formatter handle may be invalidated by helper registration or import shifts.
 */
export function ensureIrNumberToFixedProvider(ctx: CodegenContext, fuseCarrier = false): number | null {
  if (!irNativeNumberToFixedAvailable(ctx)) return null;

  ensureNativeStringHelpers(ctx);
  emitNativeNumberFormat(ctx, new Set(["number_toFixed"]));
  const formatter = ctx.funcMap.get("number_toFixed");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (formatter === undefined || anyStrTypeIdx < 0) return null;
  if (fuseCarrier) return formatter;

  const existing = ctx.funcMap.get(IR_NUMBER_TO_FIXED_FN);
  if (existing !== undefined) return existing;

  const sigIdx = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "ref", typeIdx: anyStrTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: IR_NUMBER_TO_FIXED_FN,
    typeIdx: sigIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: formatter },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
    ],
    exported: false,
  });
  ctx.funcMap.set(IR_NUMBER_TO_FIXED_FN, funcIdx);
  return funcIdx;
}
