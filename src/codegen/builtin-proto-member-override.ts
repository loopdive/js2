// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4556 bucket A) A user override of a BUILTIN prototype member has to win
 * over the builtin lowering.
 *
 * ```js
 * Array.prototype.toString = Object.prototype.toString;
 * Array().toString();   // "[object Array]", not ""
 * ```
 *
 * ## What was already true, measured rather than assumed
 *
 * The write LANDS. After the assignment above,
 * `Array.prototype.hasOwnProperty("toString")` is `true` and
 * `getOwnPropertyDescriptor(Array.prototype, "toString").value` is a function —
 * `isProtoNamedWrite` sets `ctx.protoNamedDirty`, and the entry goes onto the
 * brand COMPANION (#4176). What was missing is the CONSULT: every reader
 * answers from the builtin member ladder first, so the entry is written and
 * never seen. `proto-index-store.ts` records this as a deliberate boundary —
 * "a name stored on a companion never overrides a BUILTIN member read".
 *
 * The consult order is wrong on BOTH paths, which is the part that decides the
 * design. The static `arr.toString()` never reaches the dynamic reader at all
 * (`compileArrayMethodCall` claims it), and forcing the same call down the
 * dynamic path — an implicitly-`any` parameter — still answers `""`, because
 * `__extern_method_call`'s builtin arms answer before the store. So a routing
 * change alone cannot fix it; the consult has to happen at the call site.
 *
 * ## Shape
 *
 * A two-arm runtime branch, copying `emitDynViewMethodTwoArm`'s discipline
 * (array-methods.ts) — the established precedent for "branch between two full
 * lowerings of the same call":
 *
 *   `__protoidx_has_r(recv, "<m>")` ? apply the companion entry : the builtin
 *
 * `has`, not `get`-and-test-nullish: presence is the spec question (§10.1.8
 * OrdinaryGet walks the chain), and an override whose VALUE is `undefined` must
 * still shadow the builtin — calling it is then a TypeError, which is also
 * right. Under `protoNamedDirty` alone the companion is seeded with NOTHING
 * (`protoMemberDirty` drives seeding and a proto WRITE deliberately does not set
 * it), so `has` is exactly "the user overrode this member", not "this member
 * exists".
 *
 * ## Gating
 *
 * Compile-time: standalone, `protoNamedDirty`, and the source must write
 * `<Ctor>.prototype.<thisMember>`. A module that never overrides emits
 * byte-identically — `protoNamedDirty` is a pre-scan flag, so the arm is not
 * merely dead, it is never built.
 *
 * IDENTIFIER RECEIVERS ONLY. The else arm re-dispatches the whole call so the
 * builtin lowering runs verbatim, which compiles the receiver a second time;
 * that is only sound when evaluating it has no side effects. Same restriction,
 * for the same reason, as the dyn-view two-arm.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { protoIndexRecvGetMissInstrs, protoIndexRecvHasMissInstrs } from "./proto-index-store.js";
import {
  coerceType,
  compileExpression,
  flushLateImportShifts,
  skipTransparentExpressions,
  VOID_RESULT,
} from "./shared.js";

/**
 * Does the source install `<ctorName>.prototype.<memberName>`?
 *
 * Whole-file, and that is the right scope here: writing `Array.prototype.join`
 * genuinely affects EVERY array in the module, so unlike
 * `sourceOverridesMethodOnReceiver` (member-override-scan.ts) there is no
 * "maybe this receiver" to get wrong. Both the assignment and the
 * `defineProperty` spellings count.
 */
/** `skipTransparentExpressions` takes an Expression; narrow before calling. */
function isExpressionNode(n: ts.Node): n is ts.Expression {
  return typeof (n as ts.Expression).kind === "number" && "getSourceFile" in n;
}

export function sourceOverridesBuiltinPrototypeMember(anchor: ts.Node, ctorName: string, memberName: string): boolean {
  const sf = anchor.getSourceFile();
  if (!sf) return false;
  // Unwrap the type-only wrappers on BOTH halves. `(Array.prototype as any).x =`
  // is the ordinary TypeScript spelling of the same write, and a predicate that
  // only matched the bare form silently declined for it — the arm then left the
  // builtin lowering in place and the override was ignored, which is the exact
  // defect this whole module exists to fix.
  const isCtorProto = (raw: ts.Node): boolean => {
    if (!isExpressionNode(raw)) return false;
    const n = skipTransparentExpressions(raw);
    return (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === "prototype" &&
      ts.isIdentifier(skipTransparentExpressions(n.expression)) &&
      (skipTransparentExpressions(n.expression) as ts.Identifier).text === ctorName
    );
  };

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // `<Ctor>.prototype.<m> = …` (any assignment operator)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === memberName &&
      isCtorProto(node.left.expression)
    ) {
      found = true;
      return;
    }
    // `Object.defineProperty(<Ctor>.prototype, "<m>", …)` / `Reflect.…`
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "defineProperty" &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect") &&
      node.arguments.length >= 2 &&
      isCtorProto(node.arguments[0]!) &&
      ts.isStringLiteralLike(node.arguments[1]!) &&
      node.arguments[1]!.text === memberName
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Re-entry guard: the ELSE arm re-dispatches the whole call so the builtin
 * lowering runs verbatim, and must not land back here.
 */
const overrideTwoArmActive = new WeakSet<ts.CallExpression>();

/** Unify an arm's result to `externref` so both branches agree. */
function coerceArmToExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  r: ValType | null | undefined | typeof VOID_RESULT,
): boolean {
  if (r === undefined) return false;
  if (r === null || r === VOID_RESULT) {
    // A void expression: push `undefined` so the branch stays balanced.
    fctx.body.push({ op: "ref.null.extern" });
    return true;
  }
  const t = r as ValType;
  if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
  return true;
}

/**
 * Compile the receiver ONCE into an externref local and intern the member key,
 * so both arms and the presence test share them.
 */
function emitProtoOverridePresenceTest(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  memberName: string,
): { recvLocal: number; keyLocal: number } | undefined {
  const rt = compileExpression(ctx, fctx, receiverExpr);
  if (rt === null) return undefined;
  if (rt.kind !== "externref") coerceType(ctx, fctx, rt, { kind: "externref" });
  const recvLocal = allocLocal(fctx, `__pmo_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  addStringConstantGlobal(ctx, memberName);
  const keyLocal = allocLocal(fctx, `__pmo_key_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, memberName));
  fctx.body.push({ op: "local.set", index: keyLocal });
  return { recvLocal, keyLocal };
}

/**
 * THEN arm: read the companion entry and invoke it with the ORIGINAL receiver
 * as `this` (§6.2.5.5), through the same `__apply_closure` arity bridge
 * `__extern_method_call` uses.
 */
function emitProtoOverrideApply(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  recvLocal: number,
  keyLocal: number,
  applyClosureIdx: number,
  objVecNewIdx: number,
  objVecPushIdx: number,
): ValType | undefined {
  const getInstrs = protoIndexRecvGetMissInstrs(ctx, recvLocal, keyLocal);
  if (getInstrs === undefined) return undefined;

  const argsLocal = allocLocal(fctx, `__pmo_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? objVecNewIdx });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of callExpr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const t = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? objVecPushIdx });
  }

  fctx.body.push(...getInstrs);
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyClosureIdx });
  return { kind: "externref" };
}

/**
 * `recv.<m>(…)` where the source overrides `<ctorName>.prototype.<m>`.
 *
 * Returns the branch's ValType, or `undefined` to leave the caller on its
 * ordinary single path — which is what happens for every module that does not
 * override, for a non-identifier receiver, and whenever an arm declines.
 */
export function tryEmitProtoOverrideTwoArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  callExpr: ts.CallExpression,
  ctorName: string,
  memberName: string,
  expectedType: ValType | undefined,
): ValType | undefined {
  if (!ctx.standalone || !ctx.protoNamedDirty) return undefined;
  if (!ts.isPropertyAccessExpression(propAccess)) return undefined;
  if (overrideTwoArmActive.has(callExpr)) return undefined;
  // Unwrap the type-only wrappers (`(x as any)`, `<any>x`, `x!`, parens): they
  // carry no runtime meaning, so `(x as any).toString()` must decide exactly as
  // the bare `x.toString()` does. The IDENTIFIER requirement survives the
  // unwrap, which is what keeps the else arm's re-compile of the receiver
  // side-effect-free.
  const receiverExpr = skipTransparentExpressions(propAccess.expression);
  if (!ts.isIdentifier(receiverExpr)) return undefined;
  if (callExpr.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  if (!sourceOverridesBuiltinPrototypeMember(callExpr, ctorName, memberName)) return undefined;

  // Settle every helper BEFORE any arm code is buffered — a late registration
  // shifts defined-func indices under instructions already emitted into a
  // detached arm (the #1839/#117/#1886 trap).
  const applyClosureIdx = reserveApplyClosure(ctx);
  const { newIdx: objVecNewIdx, pushIdx: objVecPushIdx } = ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);
  if (objVecNewIdx === undefined || objVecPushIdx === undefined) return undefined;
  if (ctx.funcMap.get("__protoidx_has_r") === undefined) return undefined;

  const slots = emitProtoOverridePresenceTest(ctx, fctx, receiverExpr, memberName);
  if (slots === undefined) return undefined;
  const hasInstrs = protoIndexRecvHasMissInstrs(ctx, slots.recvLocal, slots.keyLocal);
  if (hasInstrs === undefined) return undefined;

  const outer = fctx.body;
  const thenArm: Instr[] = [];
  const elseArm: Instr[] = [];
  fctx.savedBodies.push(outer);
  fctx.savedBodies.push(thenArm);
  fctx.savedBodies.push(elseArm);

  fctx.body = thenArm;
  const rThen = emitProtoOverrideApply(
    ctx,
    fctx,
    callExpr,
    slots.recvLocal,
    slots.keyLocal,
    applyClosureIdx,
    objVecNewIdx,
    objVecPushIdx,
  );
  const thenOk = coerceArmToExternref(ctx, fctx, rThen);

  fctx.body = elseArm;
  overrideTwoArmActive.add(callExpr);
  const rElse = compileExpression(ctx, fctx, callExpr, expectedType);
  overrideTwoArmActive.delete(callExpr);
  const elseOk = coerceArmToExternref(ctx, fctx, rElse);

  fctx.body = outer;
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();

  if (!thenOk || !elseOk) {
    // An arm declined — abandon the branch. The receiver/key setup already in
    // `outer` is stack-balanced (local.set pairs) and merely a dead store; the
    // caller recompiles the receiver on the ordinary path.
    return undefined;
  }

  outer.push(...hasInstrs);
  outer.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: thenArm,
    else: elseArm,
  });
  return { kind: "externref" };
}
