// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4096) `o.f(…)` where `f` is a **stored function-valued member** of a
 * receiver whose static type is CLOSED (an object-literal struct, an array, a
 * regexp) — the shape an expando assignment produces:
 *
 * ```js
 * var o = { a: 1 };
 * o.f = function () { return 7; };
 * o.f();          // standalone before this arm: null. Expected: 7.
 * ```
 *
 * ## Why this arm exists
 *
 * The receiver's Wasm carrier is a CONCRETE struct ref, not `externref`, so the
 * any-receiver closed-method dispatcher (#2151, gated on
 * `isAnyOrExternref` in `call-receiver-method.ts`) never sees the call — and
 * that dispatcher is where #3117 already added the field-stored-closure arms
 * for the `any` twin (`const o: any = {}; o.f = function(){}; o.f()`). With no
 * static arm claiming the call either (there is no `<Struct>_f` method — `f` is
 * a FIELD holding a closure, not a declared method), the call fell all the way
 * through to `compileTailDispatch`'s graceful fallback, which evaluates the
 * callee and the arguments for side effects, DROPS them, and pushes
 * `ref.null.extern`.
 *
 * That fallback is the "detector that cannot say I don't know": an unrecognised
 * call shape answers `undefined` instead of refusing, so an ordinary
 * JavaScript program gets a silent wrong answer. Worse, the arguments are
 * evaluated but the *callee* never runs, so a spec-required `toString` /
 * getter side effect (and any `try/catch` around it) never fires at all.
 *
 * ## The lowering, and why it is not new
 *
 * Reading the member and invoking it already works on this lane:
 * `var g = o.f; g.call(o)` returns the right value. This arm emits exactly that
 * composition, with the receiver threaded as `this`:
 *
 *     T = <receiver as externref>
 *     F = <o.f as externref>          ;; the same member read that already works
 *     __apply_closure(F, T, [args…])  ;; the #1888/#3117 this-threaded bridge
 *
 * `__apply_closure` is the *same* bridge the closed-method dispatcher's
 * field-stored-closure arms use, so no new dispatch vocabulary is introduced.
 *
 * ## Blast radius
 *
 * The arm sits immediately before the graceful fallback, so every shape it can
 * claim is one that produces `ref.null.extern` today — it cannot displace a
 * working path. It is further narrowed to:
 *
 *  - host-free lanes only (`standalone`/`wasi`); the JS-host lane is already
 *    correct on all 14 cells of the #4096 trigger table and is left untouched;
 *  - a plain **identifier** receiver, so re-reading it for `this` is
 *    side-effect-free and evaluation order is preserved;
 *  - a member some `<expr>.<name> = …` assignment in the source could have
 *    stored, which is the only way this shape arises;
 *  - no spread arguments and at most `__apply_closure`'s dispatch cap.
 *
 * `__apply_closure` answers the undefined sentinel (`ref.null.extern`) for a
 * non-callable or an unsupported arity (S1 scope, see `fillApplyClosure`), so
 * even a mis-admitted shape lands on exactly the value the fallback produced —
 * this arm cannot make a currently-`undefined` answer worse.
 *
 * ## Known gap (deliberate, not an oversight)
 *
 * A member that is `null`/absent at RUNTIME should raise a `TypeError`
 * (§7.3.14 step 2). `__apply_closure` returns `undefined` instead — the same
 * S1 no-throw carve-out documented on `fillApplyClosure`, for the same
 * late-registration index-shift reason. This arm inherits that gap; it does not
 * widen it.
 */
import ts from "typescript";

import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { coerceType, compileExpression } from "../shared.js";
import { BUILTIN_CLASS_NAMES } from "./builtin-class-names.js";
import { sourceHasMethodReassignment } from "./calls.js";
import { flushLateImportShifts } from "./late-imports.js";

/**
 * `fillApplyClosure` dispatches arities 0..8 and answers the undefined sentinel
 * above that. Declining here instead keeps the fallback's behaviour verbatim
 * for the (vanishingly rare) 9+-argument case rather than routing it through a
 * bridge that would only return the same `undefined` more expensively.
 */
const APPLY_CLOSURE_MAX_ARITY = 8;

/**
 * The tail of `compileTailDispatch`: the stored-member-closure arm, then the
 * graceful fallback it guards. Always returns, so the caller's tail is a single
 * `return`.
 *
 * The two live together on purpose. The fallback is what makes this defect
 * class invisible — it is the point where "no arm recognised this call" is
 * silently rendered as the VALUE `undefined`, with the callee never invoked.
 * Anything added in front of it is a narrowing of that silence, and belongs in
 * the same file as the silence itself so the next reader sees both at once.
 */
export function compileCallDispatchTail(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): ValType {
  const stored = tryEmitStoredMemberClosureCall(ctx, fctx, expr);
  if (stored !== undefined) return stored;

  // Graceful fallback: compile the callee expression and all arguments for side
  // effects, then push `ref.null.extern`. This avoids hard compile errors for
  // unrecognized call patterns (chained calls, dynamic dispatch, uncommon AST
  // shapes) — at the cost of answering `undefined` for a call that should have
  // run. Every narrowing arm above it converts one shape out of that bucket.
  const calleeType = compileExpression(ctx, fctx, expr.expression);
  if (calleeType) fctx.body.push({ op: "drop" });
  for (const arg of expr.arguments) {
    const argType = compileExpression(ctx, fctx, arg);
    if (argType) fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * Try to lower `o.f(a, b)` as `__apply_closure(o.f, o, [a, b])`.
 *
 * @returns the result `ValType` when the call was emitted, or `undefined` to
 *          fall through to the graceful fallback.
 */
function tryEmitStoredMemberClosureCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  // Host-free lanes only — the JS-host lane already dispatches these correctly.
  if (!ctx.standalone && !ctx.wasi) return undefined;

  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  // Optional chaining has its own short-circuit semantics; not this arm's job.
  if (callee.questionDotToken !== undefined || expr.questionDotToken !== undefined) return undefined;
  if (!ts.isIdentifier(callee.name)) return undefined;

  // Receiver must be a plain identifier: it is read TWICE (once as `this`, once
  // as the base of the member read), so anything with side effects or a
  // non-trivial cost is out of scope.
  const recvExpr = callee.expression;
  if (!ts.isIdentifier(recvExpr)) return undefined;
  // A builtin namespace/class receiver (`Math.floor`, `JSON.parse`, …) is not a
  // stored-member shape; those have dedicated static arms and must not be
  // re-routed through the dynamic bridge if one of them ever declines.
  if (BUILTIN_CLASS_NAMES.has(recvExpr.text)) return undefined;

  const memberName = callee.name.text;
  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  if (expr.arguments.length > APPLY_CLOSURE_MAX_ARITY) return undefined;

  // THE ADMISSION TEST — the source must contain an `<expr>.<memberName> = …`
  // assignment somewhere. This is the #1397 scan that already gates the
  // wrapper-receiver dynamic exit, reused verbatim.
  //
  // It is the right test because the assignment is what CREATES this bug: a
  // member that no assignment ever added cannot be the stored-closure shape, so
  // the fallback's `undefined` there is some other defect and is not ours to
  // claim. It is also what keeps the #942 "Option B was rejected on perf
  // grounds" argument intact — but note that argument barely applies here at
  // all: this arm runs only AFTER every static arm has declined, so a hot
  // `arr.push(x)` / `re.test(s)` never reaches it. Nobody writes `x.push = …`,
  // so even the scan's deliberate over-approximation cannot pull an intrinsic
  // onto the dynamic path.
  //
  // Deliberately NOT keyed on a type-oracle "is this member a function"
  // fact: measured on both a `.ts` and a `.js` (expando-widening) compile of
  // the repro, `propertyFactOf(o, "toLowerCase")` answers `unresolvable` — the
  // member the assignment added is invisible to the checker in this program
  // setup, so a fact-based gate admits nothing at all. The member read is
  // resolved by codegen's own shape registry, not by TS.
  if (!sourceHasMethodReassignment(ctx, expr, memberName)) return undefined;

  // Register the bridge + the arg-vector builders BEFORE compiling anything, so
  // any import they pull in shifts function indices while the body is still
  // empty (#1839/#117/#1886 late-registration class).
  const applyIdx = reserveApplyClosure(ctx);
  const { newIdx: vecNewIdx, pushIdx: vecPushIdx } = ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);
  if (applyIdx === undefined || vecNewIdx === undefined || vecPushIdx === undefined) return undefined;

  const pushAsExternref = (e: ts.Expression): void => {
    const t = compileExpression(ctx, fctx, e, { kind: "externref" });
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
  };

  // 1. `this` — the receiver, as externref.
  const thisLocal = allocLocal(fctx, `__smc_this_${fctx.locals.length}`, { kind: "externref" });
  pushAsExternref(recvExpr);
  fctx.body.push({ op: "local.set", index: thisLocal });

  // 2. The member read — the lowering that already works standalone
  //    (`var g = o.f` / `typeof o.f === "function"`).
  const fnLocal = allocLocal(fctx, `__smc_fn_${fctx.locals.length}`, { kind: "externref" });
  pushAsExternref(callee);
  fctx.body.push({ op: "local.set", index: fnLocal });

  // 3. The argument vector, in source order (after the callee read, per §13.3.6
  //    EvaluateCall: the reference is resolved before the arguments).
  const vecLocal = allocLocal(fctx, `__smc_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? vecNewIdx });
  fctx.body.push({ op: "local.set", index: vecLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: vecLocal });
    pushAsExternref(arg);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? vecPushIdx });
  }

  // 4. `__apply_closure(fn, this, args)`. Re-read the index: compiling the
  //    receiver / member / arguments may have registered late imports.
  fctx.body.push({ op: "local.get", index: fnLocal });
  fctx.body.push({ op: "local.get", index: thisLocal });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx });
  return { kind: "externref" };
}
