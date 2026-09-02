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
import { coerceType, compileExpression } from "../shared.js";
import { allocLocal } from "../context/locals.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { emitToPropertyKeyOnce } from "./computed-member-reference.js";
import { classHierarchyHasDynamicMember } from "../class-dynamic-keys.js";
import { elemAccessReceiverClassName } from "./calls.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * True when this element-access CALL must go through the runtime member
 * dispatch: a standalone class receiver whose hierarchy carries a member no
 * static ladder can name.
 */
export function classDynamicMemberCallApplies(ctx: CodegenContext, elemAccess: ts.ElementAccessExpression): boolean {
  if (!ctx.standalone) return false;
  const className = elemAccessReceiverClassName(ctx, elemAccess);
  return className !== undefined && classHierarchyHasDynamicMember(ctx, className);
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
  if (!classDynamicMemberCallApplies(ctx, elemAccess)) return undefined;
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

  const recvLocal = allocLocal(fctx, `__cdyn_recv_${fctx.locals.length}`, EXTERNREF);
  if (!pushExtern(elemAccess.expression)) return undefined;
  fctx.body.push({ op: "local.set", index: recvLocal });

  const keyLocal = allocLocal(fctx, `__cdyn_key_${fctx.locals.length}`, EXTERNREF);
  if (!pushExtern(elemAccess.argumentExpression)) return undefined;
  // A numeric computed key (`[ID(2)]`) is stored under its canonical decimal
  // string, and a symbol key must survive as a symbol — which is exactly
  // ToPropertyKey.
  emitToPropertyKeyOnce(ctx, fctx);
  fctx.body.push({ op: "local.set", index: keyLocal });

  const argsLocal = allocLocal(fctx, `__cdyn_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: newIdx });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    if (!pushExtern(arg)) return undefined;
    fctx.body.push({ op: "call", funcIdx: pushIdx } satisfies Instr);
  }

  // callee = __extern_get(recv, key) — the read that already consults the class
  // prototype chain; then apply it WITH the receiver as `this`.
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  fctx.body.push({ op: "call", funcIdx: externGetIdx });
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: applyIdx });
  return EXTERNREF;
}
