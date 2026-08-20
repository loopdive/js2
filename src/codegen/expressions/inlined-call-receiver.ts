// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4246) `(function () { … this … }).call(obj, …)` — binding the receiver of
// an INLINED function-expression callee.
//
// Case 0 of the `.call`/`.apply` dispatch (calls.ts) rewrites a function
// LITERAL callee into a direct invocation and reuses the IIFE-inlining path,
// which is what makes `arguments` come out right (#1596). It evaluated the
// receiver purely for side effects and dropped it, with the comment
// "standalone functions ignore `this`" — true for the shapes that arm was
// written for, and silently wrong for a callee that reads `this`:
//
//     var obj = {};
//     (function () { this.touched = true; }).call(obj);
//     obj.touched            // undefined — the write went to the ambient this
//
// The failure is asymmetric and that is why it survived: the READ side already
// looked plausible. With the body inlined into `__module_init`, a `this` read
// falls through the ThisKeyword arm to `emitUnboundThis`, which for sloppy code
// answers the GLOBAL OBJECT (#4190) — so `typeof this` is "object" and only the
// identity is wrong. Every property write then lands on the global object.
//
// ## The mechanism: bind `this` the way a real function binds it
//
// The ThisKeyword arm's FIRST binding source is `fctx.localMap.get("this")`.
// Inlining is precisely the claim that the callee's body executes in this
// frame, so giving that frame a `this` local for the duration of the inline is
// the same statement, and it needs no new arm in the `this` lowering — which
// matters, because that lowering is a five-way ladder (#3365 / #1636-S1 /
// #1702 / #4190 / #4203) where an extra arm is how the strict and sloppy
// answers drift apart.
//
// The binding is SAVED and RESTORED around the inline, because `__module_init`
// (and any enclosing method) may have a `this` of its own that outlives the
// call.
//
// ## Two gates, both refusals rather than approximations
//
//  - **Function expressions only, never arrows.** An arrow has no `this`
//    binding (§10.2.1.2 is not reached for one); its `this` is the enclosing
//    scope's. Installing a local for an arrow would not be an improvement, it
//    would be a new wrong answer.
//  - **A receiver the oracle proves non-nullish.** `f.call(null)` /
//    `.call(undefined)` are NOT "pass null as this": §10.4.3 substitutes the
//    global object in sloppy code and `undefined` in strict, and both of those
//    answers already come out of `emitUnboundThis` today. Installing the raw
//    nullish value would REPLACE two correct answers with one wrong one, so an
//    unprovable or nullish receiver keeps the existing evaluate-and-drop path.
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { bodyReferencesOwnThis } from "../helpers/body-references-own-this.js";

/**
 * Oracle fact kinds that PROVE a receiver is neither `null` nor `undefined`.
 * Everything absent from this set — `any`, unions, `unresolvable`, and the
 * nullish kinds themselves — declines, per the second gate above.
 */
const PROVABLY_NON_NULLISH_FACT_KINDS = new Set([
  "object",
  "builtin",
  "class",
  "array",
  "tuple",
  "function",
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
]);

export interface InlinedReceiverBinding {
  /** Local holding the receiver; the inlined body's `this` reads resolve here. */
  readonly localIdx: number;
  /** `fctx.localMap`'s prior `this` entry, restored when the inline finishes. */
  readonly previousThisLocal: number | undefined;
  /** The callee whose receiver this binding is, for {@link inlinedCalleeHasBoundReceiver}. */
  readonly fnExpr: ts.FunctionExpression;
}

/**
 * (#4555) Callees currently inside a receiver-bound inline, by nesting depth.
 *
 * `thisBelongsToInlinedIifeBody` (`helpers/sloppy-this-global.ts`) must NOT
 * hijack an inline that this module gave a real receiver to: a spliced-in
 * function expression with NO receiver takes §10.4.3's unbound answer, but
 * `(function(){ this.touched = true; }).call(obj)` is the very case #4246
 * exists to bind. Both shapes land in `fctx.inlinedIifeNodes`, so that set
 * alone cannot tell them apart — this one can.
 *
 * Module-local rather than a `FunctionContext` field because the window is
 * exactly plan→release, which is synchronous and strictly nested; the depth
 * count keeps a recursively inlined callee correct.
 */
const boundReceiverCallees = new Map<ts.Node, number>();

/** (#4555) Is `fnExpr` inside a receiver-bound inline right now? */
export function inlinedCalleeHasBoundReceiver(fnExpr: ts.Node): boolean {
  return (boundReceiverCallees.get(fnExpr) ?? 0) > 0;
}

/**
 * (#4246) Decide whether an inlined function-literal callee should get a real
 * `this` binding, and if so allocate the local and claim the `this` name.
 *
 * The caller must then compile the receiver expression as an `externref` and
 * `local.set` it into `localIdx`, and must call `releaseInlinedReceiver` once
 * the inlined call has been compiled — on every return path.
 */
export function planInlinedReceiver(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fnExpr: ts.Expression,
  receiver: ts.Expression | undefined,
): InlinedReceiverBinding | undefined {
  if (receiver === undefined || ts.isSpreadElement(receiver)) return undefined;
  if (!ts.isFunctionExpression(fnExpr) || fnExpr.body === undefined) return undefined;
  if (!bodyReferencesOwnThis(fnExpr.body)) return undefined;
  if (!PROVABLY_NON_NULLISH_FACT_KINDS.has(ctx.oracle.typeFactOf(receiver).kind)) return undefined;

  const localIdx = allocLocal(fctx, `__inlined_this_${fctx.locals.length}`, { kind: "externref" });
  const previousThisLocal = fctx.localMap.get("this");
  fctx.localMap.set("this", localIdx);
  boundReceiverCallees.set(fnExpr, (boundReceiverCallees.get(fnExpr) ?? 0) + 1);
  return { localIdx, previousThisLocal, fnExpr };
}

/** Restore the enclosing frame's `this` binding after the inlined call. */
export function releaseInlinedReceiver(fctx: FunctionContext, binding: InlinedReceiverBinding): void {
  const depth = (boundReceiverCallees.get(binding.fnExpr) ?? 1) - 1;
  if (depth > 0) boundReceiverCallees.set(binding.fnExpr, depth);
  else boundReceiverCallees.delete(binding.fnExpr);
  if (binding.previousThisLocal === undefined) {
    fctx.localMap.delete("this");
  } else {
    fctx.localMap.set("this", binding.previousThisLocal);
  }
}
