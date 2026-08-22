// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491) `this.f(…)` / `this["f"](…)` / `globalThis.f(…)` where `f` is a
 * `var`-declared script global holding a function value.
 *
 * #4500 Slice A taught the member READ to answer such a name from the wasm
 * module global that actually stores it, and this lane's sibling arm did the
 * same for the bracket spelling. The CALL never got either treatment, so it
 * kept resolving against the checker's `typeof globalThis` struct — which has
 * no field for a `var` global — and the resolved-method-is-null guard in
 * `__method_call` turned the miss into a hard `TypeError: called value is not
 * a function`. Measured on this head, with the spelling as the only varying
 * axis:
 *
 *     var count = 0, knock = function () { count++; };
 *     var g = this.knock;  typeof g   // "function"  — the READ is fine
 *     this.knock();                   // TypeError   — the CALL is not
 *     this["knock"]();                // TypeError
 *
 * The read being right while the call throws is the tell: one lowering learned
 * about module globals and the other did not.
 *
 * ## Receiver
 *
 * §13.3.6.2 binds `this` inside the callee to the object the reference came
 * from, so the receiver is compiled and passed through rather than dropped.
 * That matters for a STRICT callee, where a bare `f()` would bind `undefined`
 * and this spelling must bind the global object.
 *
 * ## Scope
 *
 * Standalone/WASI only (the JS-host lane dispatches these through the real
 * global object already), non-optional calls, no spread, arity within
 * `__apply_closure`'s dispatch range, and a key the compiler can resolve to a
 * fixed string. `receiverIsRealmGlobalObject` supplies the rest of the proof:
 * it refuses module sources, a shadowed `globalThis`, and any `this` that is
 * not script top-level.
 */
import { ts } from "../../ts-api.js";

import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import { receiverIsRealmGlobalObject } from "../helpers/sloppy-this-global.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { localGlobalIdx } from "../registry/imports.js";
import { coerceType, compileExpression } from "../shared.js";
import { flushLateImportShifts } from "./late-imports.js";

/** `fillApplyClosure` dispatches arities 0..8 and answers undefined above that. */
const APPLY_CLOSURE_MAX_ARITY = 8;

export function tryEmitRealmGlobalMemberCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  if (expr.questionDotToken !== undefined) return undefined;

  const callee = expr.expression;
  let memberName: string;
  if (ts.isPropertyAccessExpression(callee)) {
    if (!ts.isIdentifier(callee.name)) return undefined;
    memberName = callee.name.text;
  } else if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression;
    if (key === undefined || !ts.isStringLiteralLike(key)) return undefined;
    memberName = key.text;
  } else {
    return undefined;
  }
  if (callee.questionDotToken !== undefined) return undefined;
  if (!receiverIsRealmGlobalObject(ctx, fctx, callee.expression)) return undefined;

  const globalIdx = ctx.moduleGlobals.get(memberName);
  if (globalIdx === undefined) return undefined;
  // A primitive slot cannot hold a callable, and passing one to
  // `__apply_closure` would be a type error rather than a TypeError.
  if (ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type.kind !== "externref") return undefined;

  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  if (expr.arguments.length > APPLY_CLOSURE_MAX_ARITY) return undefined;

  // Register the bridge + arg-vector builders BEFORE compiling anything, so any
  // import they pull in shifts function indices while the body is still empty
  // (#1839/#117/#1886 late-registration class).
  const applyIdx = reserveApplyClosure(ctx);
  const { newIdx: vecNewIdx, pushIdx: vecPushIdx } = ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);
  if (applyIdx === undefined || vecNewIdx === undefined || vecPushIdx === undefined) return undefined;

  const pushAsExternref = (e: ts.Expression): void => {
    const t = compileExpression(ctx, fctx, e, { kind: "externref" });
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
  };

  // 1. The receiver (§13.3.6.2 binds it as `this`).
  const thisLocal = allocLocal(fctx, `__rgc_this_${fctx.locals.length}`, { kind: "externref" });
  pushAsExternref(callee.expression);
  fctx.body.push({ op: "local.set", index: thisLocal });

  // 2. The callee — read straight out of the module global that stores it, the
  //    same location the #4500 Slice A member read answers from.
  const fnLocal = allocLocal(fctx, `__rgc_fn_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "local.set", index: fnLocal });

  // 3. The argument vector, in source order (after the callee reference, per
  //    §13.3.6 EvaluateCall).
  const vecLocal = allocLocal(fctx, `__rgc_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? vecNewIdx });
  fctx.body.push({ op: "local.set", index: vecLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: vecLocal });
    pushAsExternref(arg);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? vecPushIdx });
  }

  // 4. `__apply_closure(fn, this, args)` — re-read the index, since compiling
  //    the receiver / arguments may have registered late imports.
  fctx.body.push({ op: "local.get", index: fnLocal });
  fctx.body.push({ op: "local.get", index: thisLocal });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx });
  return { kind: "externref" };
}
