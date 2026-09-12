// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#5195 F1/F3) `c[k](...)` on a class whose hierarchy has a RUNTIME-KEYED
 * member, lowered as a real method call with the receiver bound.
 *
 * A member installed under a key that is only known at ClassDefinitionEvaluation
 * (`class C { [ID('dyn')]() {} }`) has no source-spellable name, so no static
 * dispatch ladder can reach it: the only route is the dynamic one. #5195 Step
 * 1.7 first routed that through `tryEmitInlineDynamicCall`, and two defects
 * followed from that choice:
 *
 *  - **No receiver (F3).** That dispatch invokes the closure with `this`
 *    unbound, so the prototype-installed method's trampoline reads
 *    `__current_this`, finds null, and throws the #2025 null-this TypeError —
 *    for `var c = new C(); c[ID('dyn')]()` just as much as for the
 *    `new C()[k]()` shape. A method that never touches `this` happened to work,
 *    which is what made the gap look narrower than it is.
 *  - **Compile-order dependence (F1).** Its `ref.test` candidate set is built
 *    from the closure wrappers registered SO FAR, and an INHERITED runtime-keyed
 *    member's wrapper is minted by the PARENT's prototype install in
 *    `__module_init`. A function compiled before that point saw an empty
 *    candidate set and folded the whole call to `ref.null.extern`. The same
 *    program with an unrelated read of the member earlier in source order
 *    compiled correctly — a silent, order-dependent wrong answer.
 *
 * Lowering `__apply_closure(__extern_get(recv, key), recv, args)` has neither
 * problem: the key is resolved at RUNTIME (so the prototype-chain walk that
 * carries inherited members applies, and nothing depends on what codegen has
 * registered yet) and the arity bridge is handed the receiver as `this`.
 *
 * The pair is spelled out here rather than delegated to `__extern_method_call`
 * because that native's own receiver classification is `$Object`-shaped: a
 * `$ClassName` struct takes its non-`$Object` brand path and the call does not
 * land (measured: "called value is not a function"). `__extern_get` is the
 * chokepoint that already knows about class receivers (`class-proto-lookup.ts`),
 * so consulting it directly is both shorter and the one place the class
 * knowledge lives.
 *
 * Scope: standalone only, and only for a class hierarchy that actually has a
 * runtime-keyed member — every other receiver keeps its existing lowering, so a
 * module without one compiles to identical bytes. The host lane keeps its own
 * `__extern_method_call_<n>` bridge (`dynamic-element-host-call.ts`).
 */

import type { Instr, ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, resolveEnclosingClassName } from "../shared.js";
import { allocLocal } from "../context/locals.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { emitToPropertyKeyOnce } from "./computed-member-reference.js";
import { classHierarchyHasDynamicMember } from "../class-dynamic-keys.js";
import { standaloneClassProtoObjectApplies } from "../class-proto-object.js";
import { elemAccessReceiverClassName } from "./calls.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * True when this element-access CALL must go through the runtime member
 * dispatch: a standalone class receiver whose hierarchy carries a member no
 * static ladder can name.
 */
function classDynamicMemberCallApplies(
  ctx: CodegenContext,
  fctx: FunctionContext,
  elemAccess: ts.ElementAccessExpression,
): boolean {
  if (!ctx.standalone) return false;
  // (#5195 R2-1) `super[k](...)` is a DIFFERENT operation and must not be
  // lowered as an ordinary member call. §13.3.7.1 reads the member off the HOME
  // OBJECT's [[Prototype]] and invokes it with the CURRENT `this`; compiling
  // `super` as the receiver yields `this`, so an overriding
  // `E[ID('m')]() { return super[ID('m')]() }` re-entered ITSELF — unbounded
  // self-recursion whose stack overflow escapes the wasm try/catch (measured
  // depth 51 with a guard). The receiver-class gate did not catch it because
  // `declaredNameOf(super)` answers the PARENT class name, which is in
  // `classSet`. It gets its own lane below; here it only has to be recognised.
  if (elemAccess.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return superElementCallTarget(ctx, fctx) !== undefined;
  }
  // (#5383 S2i) A class VALUE receiver — `C[k](5)` where `C` names a compiled
  // class. Its static surface lives in the #5195 Step 2 sidecar, which
  // `__extern_get` now reaches (`class-proto-lookup.ts`'s class-object arm), so
  // the same resolve-then-apply lowering serves it. Measured before this arm:
  // `C[k](5)` with `k="mk"` answered `undefined` (NaN through the f64 result)
  // while `const f = C[k]; f(5)` already answered 6 — the VALUE resolved and
  // only the CALL form did not.
  //
  // The gate is ORDER-INDEPENDENT on purpose: it asks the class table, never
  // the S2h/S2i runtime-key demand set, because that set is filled by read
  // sites as they compile and gating on it would reintroduce exactly the #5195
  // F1 compile-order dependence this module was written to remove. A local
  // binding that shadows a class name is a false positive of the NAME check
  // only — the lowering it selects is fully dynamic and correct for any
  // receiver, so the cost is bytes, not an answer.
  if (classValueReceiverApplies(ctx, elemAccess)) return true;
  const className = elemAccessReceiverClassName(ctx, elemAccess);
  return className !== undefined && classHierarchyHasDynamicMember(ctx, className);
}

/**
 * The S2i arm's own predicate: the receiver is an IDENTIFIER naming a compiled
 * class, i.e. the class OBJECT is the receiver rather than an instance.
 *
 * Split out from {@link classDynamicMemberCallApplies} because the callee
 * resolution differs (see the `## The S2i regression` note on
 * {@link tryEmitClassDynamicMemberCall}), and because being an identifier is
 * what makes re-evaluating the receiver for `this` free of side effects.
 */
function classValueReceiverApplies(ctx: CodegenContext, elemAccess: ts.ElementAccessExpression): boolean {
  return (
    ts.isIdentifier(elemAccess.expression) &&
    ctx.classSet.has(elemAccess.expression.text) &&
    standaloneClassProtoObjectApplies(ctx, elemAccess.expression.text) &&
    ctx.classObjectGlobals.get(elemAccess.expression.text) !== undefined
  );
}

/**
 * (#5195 R2-1) The `super[k]` lookup target for the method being compiled: the
 * home object's [[Prototype]], i.e. the PARENT class's prototype `$Object`.
 *
 * Returns the parent's proto global index, or `undefined` when this frame has
 * no resolvable enclosing class, no compiled parent, no parent `$Object`
 * prototype, or no `this` to invoke with — in each case the caller declines and
 * the existing super lowering runs unchanged.
 */
function superElementCallTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
): { protoGlobalIdx: number; thisLocal: number } | undefined {
  const enclosing = resolveEnclosingClassName(fctx);
  if (enclosing === undefined) return undefined;
  const parent = ctx.classParentMap.get(enclosing);
  if (parent === undefined) return undefined;
  if (!classHierarchyHasDynamicMember(ctx, enclosing)) return undefined;
  if (!standaloneClassProtoObjectApplies(ctx, parent)) return undefined;
  const protoGlobalIdx = ctx.protoGlobals.get(parent);
  const thisLocal = fctx.localMap.get("this");
  if (protoGlobalIdx === undefined || thisLocal === undefined) return undefined;
  return { protoGlobalIdx, thisLocal };
}

/**
 * Emit `__apply_closure(__extern_get(recv, ToPropertyKey(key)), recv, [args…])`,
 * leaving the result externref on the stack. Returns `undefined` without emitting anything
 * when a dependency is missing, in which case the caller keeps its existing
 * lowering.
 *
 * The receiver and the key are each compiled EXACTLY ONCE, in source order
 * (receiver, then key, then arguments) — which is also §13.3.3's evaluation
 * order, and is why a `new C()[k]()` receiver is safe here where a
 * capture-then-redispatch wrapper would have constructed twice.
 */
/**
 * ## The S2i regression (#5383, fixed 2026-09-12)
 *
 * S2i widened {@link classDynamicMemberCallApplies} to claim every `C[k](…)`
 * whose receiver names a compiled class, and then resolved the callee the way
 * the INSTANCE arm does: `__extern_get(recv, key)` on a freshly materialized
 * class-object struct. That is strictly WEAKER than what the ordinary READ
 * lowering of `C[k]` already does for a class value — S2i's own measurement
 * said so ("`const f = C[k]; f(5)` already answered 6 … only the CALL form did
 * not"), and the gap it leaves is a **computed static FIELD**:
 *
 * ```js
 * let C = class { [1.1] = () => 2; static [1.1] = () => 2; };
 * C[String(1.1)]()   // the read answers the closure; `__extern_get` on the
 *                    // class-object struct answers null, so the call was null
 * ```
 *
 * That is the whole of the 32-row `cpn-class-{decl,expr}-fields-methods-*`
 * standalone regression #5820 shipped: the value was right and only the fused
 * call form resolved against the wrong carrier.
 *
 * The fix is to stop re-deriving the callee and simply ASK the read lowering —
 * compile `elemAccess` itself. It subsumes the static sidecar (S2i's win) and
 * the `staticProps`/own-property surface (the regression) because it is the one
 * place that knows about both. Re-evaluating the receiver afterwards for `this`
 * is free of side effects **because** the arm only fires on an identifier, which
 * is also why this cannot be done on the instance arm (`new C()[k]()` would
 * construct twice) — the two arms stay separate for that reason alone.
 */
function emitClassValueDynamicCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
  pushExtern: (value: ts.Expression) => boolean,
  helpers: { newIdx: number; pushIdx: number; applyIdx: number },
): InnerResult | undefined {
  // §13.3.6.1: the MemberExpression is evaluated and GetValue'd BEFORE the
  // arguments, so the read — which evaluates the receiver and then the key,
  // each exactly once — comes first and its side effects are ordered right.
  const calleeLocal = allocLocal(fctx, `__cval_callee_${fctx.locals.length}`, EXTERNREF);
  if (!pushExtern(elemAccess)) return undefined;
  fctx.body.push({ op: "local.set", index: calleeLocal });

  const argsLocal = allocLocal(fctx, `__cval_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: helpers.newIdx });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    if (!pushExtern(arg)) return undefined;
    fctx.body.push({ op: "call", funcIdx: helpers.pushIdx } satisfies Instr);
  }

  fctx.body.push({ op: "local.get", index: calleeLocal });
  // The class object is the `this` of a static call. Recompiling the identifier
  // is a global read of the same lazy singleton — no second evaluation of any
  // user expression, which is what `classValueReceiverApplies` guarantees.
  if (!pushExtern(elemAccess.expression)) return undefined;
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: helpers.applyIdx });
  return EXTERNREF;
}

export function tryEmitClassDynamicMemberCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
): InnerResult | undefined {
  if (!classDynamicMemberCallApplies(ctx, fctx, elemAccess)) return undefined;
  if (elemAccess.argumentExpression === undefined) return undefined;
  if (expr.arguments.some((arg) => ts.isSpreadElement(arg))) return undefined;

  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const applyIdx = reserveApplyClosure(ctx);
  if (externGetIdx === undefined) return undefined;

  const pushExtern = (value: ts.Expression): boolean => {
    const type = compileExpression(ctx, fctx, value, EXTERNREF);
    if (type === null) {
      fctx.body.push({ op: "ref.null.extern" });
      return true;
    }
    if (type === undefined) return false;
    if ((type as ValType).kind !== "externref") coerceType(ctx, fctx, type as ValType, EXTERNREF);
    return true;
  };

  if (classValueReceiverApplies(ctx, elemAccess)) {
    return emitClassValueDynamicCall(ctx, fctx, expr, elemAccess, pushExtern, { newIdx, pushIdx, applyIdx });
  }

  // `super[k]` splits the two roles an ordinary call fuses: the LOOKUP happens
  // on the home object's [[Prototype]], the INVOCATION on the current `this`.
  const superTarget =
    elemAccess.expression.kind === ts.SyntaxKind.SuperKeyword ? superElementCallTarget(ctx, fctx) : undefined;
  const isSuper = elemAccess.expression.kind === ts.SyntaxKind.SuperKeyword;
  if (isSuper && superTarget === undefined) return undefined;

  const lookupLocal = allocLocal(fctx, `__cdyn_lookup_${fctx.locals.length}`, EXTERNREF);
  const recvLocal = allocLocal(fctx, `__cdyn_recv_${fctx.locals.length}`, EXTERNREF);
  if (superTarget !== undefined) {
    fctx.body.push({ op: "global.get", index: superTarget.protoGlobalIdx });
    fctx.body.push({ op: "local.set", index: lookupLocal });
    fctx.body.push({ op: "local.get", index: superTarget.thisLocal });
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "local.set", index: recvLocal });
  } else {
    if (!pushExtern(elemAccess.expression)) return undefined;
    fctx.body.push({ op: "local.tee", index: recvLocal });
    fctx.body.push({ op: "local.set", index: lookupLocal });
  }

  const keyLocal = allocLocal(fctx, `__cdyn_key_${fctx.locals.length}`, EXTERNREF);
  if (!pushExtern(elemAccess.argumentExpression)) return undefined;
  // A numeric computed key (`[ID(2)]`) is stored under its canonical decimal
  // string, and a symbol key must survive as a symbol — which is exactly
  // ToPropertyKey.
  emitToPropertyKeyOnce(ctx, fctx);
  fctx.body.push({ op: "local.set", index: keyLocal });

  // (#5195 R2-5) The CALLEE is read before the arguments are evaluated.
  // §13.3.6.1 evaluates the MemberExpression and performs GetValue on it before
  // ArgumentListEvaluation, which is observable whenever the member is an
  // accessor or sits behind a Proxy `get` trap: its side effects must come
  // first. Reading it into a local here (rather than leaving it on the stack)
  // keeps that order while still letting `__apply_closure` receive its operands
  // in the order it wants.
  const calleeLocal = allocLocal(fctx, `__cdyn_callee_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.get", index: lookupLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  fctx.body.push({ op: "call", funcIdx: externGetIdx });
  fctx.body.push({ op: "local.set", index: calleeLocal });

  const argsLocal = allocLocal(fctx, `__cdyn_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: newIdx });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    if (!pushExtern(arg)) return undefined;
    fctx.body.push({ op: "call", funcIdx: pushIdx } satisfies Instr);
  }

  // Apply the already-read callee WITH the receiver as `this`. For an ordinary
  // call the lookup object and the receiver are the same; for `super[k]` they
  // are not, which is the whole point.
  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: applyIdx });
  return EXTERNREF;
}
