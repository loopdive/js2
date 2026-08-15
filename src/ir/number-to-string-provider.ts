// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4467) The per-lane provider behind `IR_NUMBER_TO_STRING_FN` — §7.1.17
// `Number::toString(value, 10)` as one callable whose result is the LANE's
// string carrier.

import { ensureLateImport } from "../codegen/shared.js";
import { ensureNativeStringHelpers } from "../codegen/native-strings.js";
import { emitNativeNumberFormat } from "../codegen/number-format-native.js";
import { mintDefinedFunc, pushDefinedFunc } from "../codegen/func-space.js";
import { addFuncType } from "../codegen/registry/types.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { IR_NUMBER_TO_STRING_FN } from "./string-runtime.js";

export { IR_NUMBER_TO_STRING_FN };

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
 * The unbox lives in a minted `(f64) -> (ref $AnyString)` thunk rather than
 * inline at each call site so the intrinsic's IR-visible signature is
 * carrier-correct in BOTH lanes. That is what lets from-ast emit one call and
 * ask no mode question at all.
 *
 * Returns `null`/`undefined` when the lane cannot bind a provider; the caller
 * turns that into the usual `unknown-function-ref` invariant.
 */
export function ensureIrNumberToStringProvider(ctx: CodegenContext): number | null | undefined {
  if (!ctx.nativeStrings) {
    return ensureLateImport(ctx, "number_toString", [{ kind: "f64" }], [{ kind: "externref" }]);
  }
  const existing = ctx.funcMap.get(IR_NUMBER_TO_STRING_FN);
  if (existing !== undefined) return existing;
  ensureNativeStringHelpers(ctx);
  emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  const formatter = ctx.funcMap.get("number_toString");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (formatter === undefined || anyStrTypeIdx < 0) return null;
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
