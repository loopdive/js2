// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7060) `anyValue.use(…)` must call the receiver's OWN `use`, and reach
 * `DisposableStack.prototype.use` only when the receiver IS a DisposableStack.
 *
 * ```js
 * class A { constructor() { this.use = (a1, ...hs) => hs.length; } }
 * const a = new A();          // `any` at the call site
 * a.use("*", 1, 2);           // 2 — not "requires a DisposableStack receiver"
 * ```
 *
 * The host-free `any`-receiver dispatch (`tryExternClassMethodOnAny`) routes
 * every `dispose`/`defer`/`adopt`/`use` call to the native DisposableStack
 * substrate as soon as the name matches, and that substrate's own brand test
 * answers a non-stack receiver with the RequireInternalSlot TypeError. That is
 * right for `DisposableStack.prototype.use.call(x)`, but a plain method call
 * is §13.3.6.1 EvaluateCall over a property REFERENCE: the receiver's own (or
 * inherited) `use` is the callee, and the builtin is only reached through the
 * receiver's actual prototype chain. Hono's `app.use(...)` — called by most of
 * its test files — hit exactly this.
 *
 * Shape: a two-arm runtime branch on the brand, copying the discipline of
 * `tryEmitProtoOverrideTwoArm` (builtin-proto-member-override.ts):
 *
 *   `ref.test $DisposableStack(recv)` ? native DisposableStack method
 *                                     : the generic dynamic method call
 *
 * The ELSE arm re-dispatches the whole call with the shortcut suppressed (the
 * re-entry guard below), so the ordinary closed-struct / `$Object` dispatch
 * runs verbatim. That re-compiles the receiver, which is only sound when its
 * evaluation has no side effects — so the two-arm is taken for IDENTIFIER and
 * `this` receivers only (the same restriction, for the same reason, as the
 * proto-override and dyn-view two-arms). Any other receiver keeps the existing
 * brand-or-TypeError lowering.
 *
 * Host-free lanes only (`noJsHost`): the JS-host lane never takes this shortcut
 * (it binds the satisfiable `DisposableStack_*` import), so its output is
 * byte-identical.
 */
import { ts } from "../../ts-api.js";
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { ensureDisposableStackTypes, tryCompileNativeDisposableStackAnyMethodCall } from "../disposable-runtime.js";
import { noJsHost } from "../js-errors.js";
import { coerceType, compileExpression, skipTransparentExpressions, VOID_RESULT, type InnerResult } from "../shared.js";

/** Calls whose ELSE arm is being compiled: the shortcut must not claim them again. */
const twoArmActive = new WeakSet<ts.CallExpression>();

/** True while the generic arm of this call is compiling (the caller skips the shortcut). */
export function disposableStackShortcutSuppressed(callExpr: ts.CallExpression): boolean {
  return twoArmActive.has(callExpr);
}

/** Unify an arm's result to `externref` so both branches agree. */
function armToExternref(ctx: CodegenContext, fctx: FunctionContext, r: InnerResult | undefined): boolean {
  if (r === undefined) return false;
  if (r === null || r === VOID_RESULT) {
    fctx.body.push({ op: "ref.null.extern" });
    return true;
  }
  if (r.kind !== "externref") coerceType(ctx, fctx, r, { kind: "externref" });
  return true;
}

/**
 * Brand-guarded DisposableStack dispatch for an `any` receiver. Returns
 * `undefined` to leave the caller on its existing single path (a receiver whose
 * evaluation is not safe to repeat, or an arm that declined).
 */
export function tryEmitDisposableStackAnyTwoArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  methodName: string,
): InnerResult | undefined {
  if (!noJsHost(ctx) || twoArmActive.has(callExpr)) return undefined;
  const receiver = skipTransparentExpressions(propAccess.expression);
  if (!ts.isIdentifier(receiver) && receiver.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  const stackTypeIdx = ensureDisposableStackTypes(ctx).stackTypeIdx;

  // The brand test reads the receiver once more; an identifier / `this` read is
  // side-effect free, and each arm evaluates the arguments exactly once. It is
  // compiled BEFORE the arms so a late import it might register shifts the
  // arms' baked function indices too (they are built with `outer` on
  // `savedBodies`). If an arm declines, this is a balanced dead store.
  const recvType = compileExpression(ctx, fctx, receiver);
  if (recvType === null) return undefined;
  if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, { kind: "externref" });
  const recvLocal = allocLocal(fctx, `__ds2_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  const outer = fctx.body;
  const thenArm: Instr[] = [];
  const elseArm: Instr[] = [];
  fctx.savedBodies.push(outer, thenArm, elseArm);

  fctx.body = thenArm;
  const thenOk = armToExternref(
    ctx,
    fctx,
    tryCompileNativeDisposableStackAnyMethodCall(ctx, fctx, propAccess, callExpr, methodName),
  );

  fctx.body = elseArm;
  twoArmActive.add(callExpr);
  let elseOk = false;
  try {
    elseOk = armToExternref(ctx, fctx, compileExpression(ctx, fctx, callExpr));
  } finally {
    twoArmActive.delete(callExpr);
  }

  fctx.body = outer;
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();
  if (!thenOk || !elseOk) return undefined;

  outer.push(
    { op: "local.get", index: recvLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: stackTypeIdx },
    { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: thenArm, else: elseArm },
  );
  return { kind: "externref" };
}
