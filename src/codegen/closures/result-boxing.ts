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

import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { ensureAnyToExternHelper, isAnyValue, undefinedExternInstrs } from "../any-helpers.js";

/** Preserve the structural boolean brand when an i32 crosses the externref ABI. */
function boxI32ClosureResult(
  ctx: CodegenContext,
  returnType: { kind: "i32"; boolean?: true },
  boxNumberIdx: number | undefined,
): Instr[] {
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (returnType.boolean === true && boxBooleanIdx !== undefined) {
    return [{ op: "call", funcIdx: boxBooleanIdx }];
  }
  if (boxNumberIdx !== undefined) {
    return [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumberIdx }];
  }
  return [{ op: "drop" }, { op: "ref.null.extern" }];
}

export function buildClosureResultBoxing(
  ctx: CodegenContext,
  returnType: ValType | null,
  boxNumberIdx: number | undefined,
): Instr[] {
  // A void closure contributes no value — the ABI still owes one externref,
  // and it owes the CANONICAL undefined (the #2106 singleton when active), not
  // a bare null: a getter body with no return statement must read back as
  // `undefined` (§6.2.5.5), but the raw `ref.null.extern` printed/compared as
  // null through every dynamic consumer (measured: `Object.defineProperty(o,
  // "p", {get: function(){}}); o.p` answered null — 15.2.3.6-4-207 family, and
  // the same for any dynamically dispatched void method's result).
  if (!returnType) return undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  if ((ctx.standalone || ctx.wasi) && isAnyValue(returnType, ctx)) {
    const anyToExternIdx = ensureAnyToExternHelper(ctx);
    return anyToExternIdx !== undefined ? [{ op: "call", funcIdx: anyToExternIdx }] : [{ op: "extern.convert_any" }];
  }
  if (returnType.kind === "ref" || returnType.kind === "ref_null") {
    return [{ op: "extern.convert_any" }];
  }
  if (returnType.kind === "f64") {
    return boxNumberIdx !== undefined
      ? [{ op: "call", funcIdx: boxNumberIdx }]
      : [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  if (returnType.kind === "i32") {
    return boxI32ClosureResult(ctx, returnType, boxNumberIdx);
  }
  if (returnType.kind === "i64") {
    return boxNumberIdx !== undefined
      ? [{ op: "f64.convert_i64_s" }, { op: "call", funcIdx: boxNumberIdx }]
      : [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  // Already externref (or an ABI-compatible kind): nothing to do. Matches the
  // previous behaviour, which fell through every branch and emitted nothing.
  return [];
}
