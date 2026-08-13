// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) `<dynamic>.valueOf()` in the JS-host / GC lane.
 *
 * ## What was wrong
 *
 * `compileReceiverMethodCall` ends with a blanket
 *
 * ```ts
 * if (propAccess.name.text === "valueOf" && expr.arguments.length === 0)
 *   return compileExpression(ctx, fctx, propAccess.expression);
 * ```
 *
 * That is `Object.prototype.valueOf`, and it is the right answer only when
 * nothing EARLIER in the receiver's prototype chain overrides it. Every arm
 * above it resolves the overriding cases from the receiver's STATIC TypeScript
 * type — so a receiver typed `any`, i.e. every receiver in compiled JavaScript,
 * reaches none of them and the blanket identity swallows both overriding cases:
 *
 * ```js
 * Object("a").valueOf()                              // was the wrapper, must be "a"
 * ({ valueOf: function () { return 7; } }).valueOf()  // was the object, must be 7
 * ```
 *
 * #4201 closed exactly this for `--target standalone` with a native
 * `__dyn_valueOf` helper. This module is its host-lane sibling.
 *
 * ## Why not "just fall through to the dynamic method call"
 *
 * Measured, and reverted: routing the call through `__extern_method_call`
 * resolves the wrapper and the override correctly but BREAKS the third case —
 *
 * ```js
 * function unbox(v) { return v.valueOf(); }
 * var o = { a: 1 };
 * unbox(o) === o        // must be true; became false
 * ```
 *
 * — because the ordinary-object answer round-trips the receiver through the
 * host and comes back as a different reference. The breakage is shape-sensitive
 * (it holds when the result is stored in a local first, fails when compared
 * inline), so category sampling does not surface it.
 *
 * ## The lowering
 *
 * Decide in-module, and return the ORIGINAL externref for the identity case so
 * no round-trip can happen:
 *
 * ```wat
 * <recv> local.tee $r
 * call $__dyn_valueof_is_override        ;; i32
 * (if (result externref)
 *   (then local.get $r  call $__dyn_valueof_call)   ;; wrapper slot / user override
 *   (else local.get $r))                            ;; Object.prototype.valueOf
 * ```
 *
 * `__dyn_valueof_is_override` answers 0 — the identity arm — whenever the
 * receiver's resolved `valueOf` is absent, non-callable, or is exactly
 * `Object.prototype.valueOf`. A primitive is not an Object and also answers 0,
 * matching the blanket behaviour it replaces.
 *
 * Same bounded surface #4201 reasoned about: only a zero-argument
 * `<expr>.valueOf()` property-access call site whose receiver the ORACLE cannot
 * pin down can change, so a module without one compiles byte-identically.
 */
import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { compileExpression, coerceType } from "./shared.js";

const IS_OVERRIDE = "__dyn_valueof_is_override";
const CALL_OVERRIDE = "__dyn_valueof_call";

/**
 * Emit `<recv>.valueOf()` for a receiver the oracle cannot pin down, in the
 * JS-host / GC lane. Returns the result ValType when it took the call, or
 * `undefined` to decline — in which case NOTHING has been emitted and the
 * caller keeps its blanket-identity fallback.
 *
 * The caller has already established `propAccess.name.text === "valueOf"` with
 * zero arguments.
 */
export function tryEmitHostDynamicValueOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
): ValType | undefined {
  // Host lane only — standalone / WASI are served by #4201's native helper.
  if (ctx.standalone || ctx.wasi) return undefined;
  const fact = ctx.oracle.typeFactOf(propAccess.expression).kind;
  if (fact !== "any" && fact !== "unknown") return undefined;

  // Reserve BOTH imports before any operand is compiled, so a late funcIdx
  // shift reaches already-emitted instructions through currentFunc.
  const isOverrideIdx = ensureLateImport(ctx, IS_OVERRIDE, [{ kind: "externref" }], [{ kind: "i32" }]);
  const callIdx = ensureLateImport(ctx, CALL_OVERRIDE, [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (isOverrideIdx === undefined || callIdx === undefined) return undefined;

  const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (!recvType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind !== "externref") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }
  const recvLocal = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: recvLocal });
  // Re-read the indices: compiling the receiver may have registered helpers.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(IS_OVERRIDE) ?? isOverrideIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [
      { op: "local.get", index: recvLocal },
      { op: "call", funcIdx: ctx.funcMap.get(CALL_OVERRIDE) ?? callIdx },
    ],
    // The ORIGINAL externref — never a host round-trip, so `o.valueOf() === o`
    // still holds for an ordinary object.
    else: [{ op: "local.get", index: recvLocal }],
  });
  releaseTempLocal(fctx, recvLocal);
  return { kind: "externref" };
}
