// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4082) The one place that lowers a closure `call_ref` result to the
 * externref the `__call_fn_*` / `__call_fn_method_*` ABI returns.
 *
 * Every dispatch arm in that ABI has to do exactly this, and each arm used to
 * carry its own copy of the decision — two byte-identical 30-line if-chains in
 * `closure-exports.ts`, and, in the #3992 transferred-native-proto arm, no copy
 * at all. That arm copied the `call_ref` and asserted the missing half in a
 * comment instead: *"each arm pushes exactly one externref (the `call_ref`
 * result)"*. False for any closure returning a non-reference —
 * `RegExp.prototype.test` returns **i32**, so the arm pushed an i32 into an
 * externref local and the module stopped validating:
 *
 *     __call_fn_method_0 failed:
 *       local.set[0] expected type externref, found call_ref of type i32
 *
 * An invariant that exists only as prose is not an invariant. This module owns
 * the decision so a new arm gets it by construction rather than by remembering,
 * and it lives under `closures/` rather than in the `closure-exports` driver so
 * both callers can import it directly (no callback plumbing, no import cycle).
 */

import { buildClosureResultBody } from "../../runtime/wasmgc/values/closure-result-bodies.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { ensureAnyToExternHelper, isAnyValue, undefinedExternInstrs } from "../any-helpers.js";

/** Context acquisition remains conditional and at the legacy call site. */
export function buildClosureResultBoxing(
  ctx: CodegenContext,
  returnType: ValType | null,
  boxNumberIdx: number | undefined,
): Instr[] {
  if (!returnType) return buildClosureResultBody({ kind: "void", undefinedValue: undefinedExternInstrs(ctx) });
  if ((ctx.standalone || ctx.wasi) && isAnyValue(returnType, ctx))
    return buildClosureResultBody({ kind: "native-any", anyToExtern: ensureAnyToExternHelper(ctx) });
  if (returnType.kind === "i32") {
    const boxSymbol = ctx.funcMap.get("__box_symbol");
    if (returnType.symbol === true && boxSymbol !== undefined)
      return buildClosureResultBody({ kind: "value", returnType, boxNumber: boxNumberIdx, boxSymbol });
    const boxBoolean = ctx.funcMap.get("__box_boolean");
    return buildClosureResultBody({ kind: "value", returnType, boxNumber: boxNumberIdx, boxSymbol, boxBoolean });
  }
  if (returnType.kind === "i64") {
    const boxBigInt = ctx.funcMap.get("__box_bigint");
    return buildClosureResultBody({ kind: "value", returnType, boxNumber: boxNumberIdx, boxBigInt });
  }
  return buildClosureResultBody({ kind: "value", returnType, boxNumber: boxNumberIdx });
}
