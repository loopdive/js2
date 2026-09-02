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
  const className = elemAccessReceiverClassName(ctx, elemAccess);
  return className !== undefined && classHierarchyHasDynamicMember(ctx, className);
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
