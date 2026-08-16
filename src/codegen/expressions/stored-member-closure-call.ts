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
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { coerceType, compileExpression } from "../shared.js";
import { BUILTIN_CLASS_NAMES } from "./builtin-class-names.js";
import { sourceHasMethodOverride } from "./member-override-scan.js";
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

  // (#4207) The receiver was not an identifier (`(Number.NEGATIVE_INFINITY).m()`),
  // so the arm above declined — but a module that installed a NAMED property on
  // a builtin prototype can still resolve `m` through the receiver's implicit
  // chain at run time. One evaluation of the receiver, so the "read twice"
  // restriction that gates the arm above does not apply here.
  const inherited = tryEmitProtoInheritedMethodCall(ctx, fctx, expr);
  if (inherited !== undefined) return inherited;

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
export function tryEmitStoredMemberClosureCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  // Host-free lanes only — the JS-host lane already dispatches these correctly.
  if (!ctx.standalone && !ctx.wasi) return undefined;

  const callee = expr.expression;
  // (#4482) `o["exec"](…)` is the SAME shape as `o.exec(…)` — §12.3.2 computes
  // the property key from a string literal, and the element READ already
  // resolves the stored closure (`var g = o["exec"]` works). test262 writes the
  // §15.10.6.2 rows both ways on purpose (`_A2_T5` dot, `_A2_T6` bracket), and
  // only the dot half reached this arm, so the bracket half fell to the
  // graceful `ref.null.extern` fallback and answered `undefined` where the
  // transferred `RegExp.prototype.exec` must throw a real `TypeError`. A
  // NON-literal key is left alone: the key is then a runtime value and the
  // source scan below cannot name the member it will resolve to.
  let memberName: string;
  let recvExpr: ts.Expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (!ts.isIdentifier(callee.name)) return undefined;
    memberName = callee.name.text;
    recvExpr = callee.expression;
  } else if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression;
    if (key === undefined || !ts.isStringLiteralLike(key)) return undefined;
    memberName = key.text;
    recvExpr = callee.expression;
  } else {
    return undefined;
  }
  // Optional chaining has its own short-circuit semantics; not this arm's job.
  if (callee.questionDotToken !== undefined || expr.questionDotToken !== undefined) return undefined;

  // Receiver must be a plain identifier: it is read TWICE (once as `this`, once
  // as the base of the member read), so anything with side effects or a
  // non-trivial cost is out of scope.
  if (!ts.isIdentifier(recvExpr)) return undefined;
  // A builtin namespace/class receiver (`Math.floor`, `JSON.parse`, …) is not a
  // stored-member shape; those have dedicated static arms and must not be
  // re-routed through the dynamic bridge if one of them ever declines.
  if (BUILTIN_CLASS_NAMES.has(recvExpr.text)) return undefined;

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
  //
  // (#4482) …widened to `sourceHasMethodOverride`, which also sees
  // `Object.defineProperty(X, "<memberName>", …)`. That install route reads
  // back correctly today (`Object.defineProperty(d,"zz",{value:7}); d.zz === 7`
  // is TRUE for `any`/`Object`/`Date` receivers) but the CALL was not claimed
  // by this arm, so `d.zz()` answered the graceful-fallback null instead of
  // invoking the stored closure — the §15.x.4 rows install the transferred
  // intrinsic with `defineProperty` in block #1 and by assignment in block #2,
  // and only block #2 threw.
  if (!sourceHasMethodOverride(ctx, expr, memberName)) return undefined;

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
  //
  //    (#4207) …unless the member read answered nullish AND this module wrote a
  //    named property onto a builtin prototype. Then the callee may be an
  //    INHERITED method that the static member read cannot see: a primitive
  //    receiver has no own-property carrier, so `pushAsExternref(callee)` folds
  //    to `ref.null.extern` and the call silently answers `undefined`:
  //
  //      Number.prototype.zz = function () { return 42; };
  //      var n = 5; n.zz();            // measured: null (a PLAIN function —
  //                                    // this is a prototype-chain gap, not a
  //                                    // `this`-binding one)
  //      Object.prototype.exec = RegExp.prototype.exec;
  //      var i = false; i.exec("m");   // must be TypeError; measured: null
  //
  //    `__extern_method_call` resolves through the receiver's implicit chain
  //    (own brand, then `Object.prototype`) via the #4176 proto-property store
  //    and threads the ORIGINAL receiver as `this`, which is what lets a
  //    *transferred* builtin method run its own brand check / `ToString(this)`.
  //    Guarded on the nullish read, so every shape that resolves a callee today
  //    keeps the exact `__apply_closure` sequence; and on `protoNamedDirty`, a
  //    pre-scan flag, so a module with no such write emits byte-identically.
  const methodCallIdx = ctx.standalone && ctx.protoNamedDirty ? ctx.funcMap.get("__extern_method_call") : undefined;
  const applyCall: Instr[] = [
    { op: "local.get", index: fnLocal },
    { op: "local.get", index: thisLocal },
    { op: "local.get", index: vecLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx },
  ];
  if (methodCallIdx === undefined) {
    fctx.body.push(...applyCall);
    return { kind: "externref" };
  }
  const nameKey = memberName;
  addStringConstantGlobal(ctx, nameKey);
  // nullish(fn) — `null` OR the #2106 `undefined` singleton, which is a
  // DISTINCT non-null sentinel externref in standalone, so `ref.is_null` alone
  // would miss the "member absent" answer this arm has to catch.
  fctx.body.push({ op: "local.get", index: fnLocal });
  fctx.body.push({ op: "ref.is_null" });
  const isUndefIdx = ctx.funcMap.get("__extern_is_undefined");
  if (isUndefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: fnLocal });
    fctx.body.push({ op: "call", funcIdx: isUndefIdx });
    fctx.body.push({ op: "i32.or" });
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [
      { op: "local.get", index: thisLocal },
      ...stringConstantExternrefInstrs(ctx, nameKey),
      { op: "local.get", index: vecLocal },
      { op: "call", funcIdx: methodCallIdx },
    ],
    else: applyCall,
  });
  return { kind: "externref" };
}

/**
 * (#4207) `<non-identifier receiver>.<m>(…)` for a module that installed a
 * NAMED property on a builtin prototype — the shape
 * {@link tryEmitStoredMemberClosureCall} declines because it would have to read
 * the receiver twice. Here the receiver is evaluated ONCE into the
 * `__extern_method_call` receiver slot, so there is no re-read to worry about
 * and no ordering hazard.
 *
 * Same blast radius argument as the arm above: it sits immediately before the
 * graceful fallback, so every shape it can claim answers `ref.null.extern`
 * today, and `__extern_method_call` answers the same undefined sentinel on a
 * miss. Gated on `ctx.protoNamedDirty` (a pre-scan flag), so a module that
 * never writes a named property onto a builtin prototype emits byte-identically.
 */
function tryEmitProtoInheritedMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (!ctx.standalone || !ctx.protoNamedDirty) return undefined;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.questionDotToken !== undefined || expr.questionDotToken !== undefined) return undefined;
  if (!ts.isIdentifier(callee.name)) return undefined;
  // The identifier-receiver shape belongs to the arm above (it can still reach
  // `__apply_closure` when the static member read resolves).
  if (ts.isIdentifier(callee.expression)) return undefined;
  if (BUILTIN_CLASS_NAMES.has(callee.expression.getText())) return undefined;
  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  if (expr.arguments.length > APPLY_CLOSURE_MAX_ARITY) return undefined;

  const memberName = callee.name.text;
  // (#4482) `defineProperty`-installed members too — see the note on the
  // identifier-receiver arm above.
  if (!sourceHasMethodOverride(ctx, expr, memberName)) return undefined;

  // Same reserve-before-compile discipline as the arm above (#1839/#117/#1886).
  reserveApplyClosure(ctx);
  const { newIdx: vecNewIdx, pushIdx: vecPushIdx } = ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);
  const methodCallIdx = ctx.funcMap.get("__extern_method_call");
  if (methodCallIdx === undefined || vecNewIdx === undefined || vecPushIdx === undefined) return undefined;

  const pushAsExternref = (e: ts.Expression): void => {
    const t = compileExpression(ctx, fctx, e, { kind: "externref" });
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
  };

  const thisLocal = allocLocal(fctx, `__pim_this_${fctx.locals.length}`, { kind: "externref" });
  pushAsExternref(callee.expression);
  fctx.body.push({ op: "local.set", index: thisLocal });

  const vecLocal = allocLocal(fctx, `__pim_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? vecNewIdx });
  fctx.body.push({ op: "local.set", index: vecLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: vecLocal });
    pushAsExternref(arg);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? vecPushIdx });
  }

  addStringConstantGlobal(ctx, memberName);
  fctx.body.push({ op: "local.get", index: thisLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, memberName));
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_method_call") ?? methodCallIdx });
  return { kind: "externref" };
}
