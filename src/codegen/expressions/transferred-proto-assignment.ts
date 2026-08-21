// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T1) The *assignment* spelling of the ES5 genericity idiom.
 *
 * `transferred-native-proto-call.ts` (wave-3) resolves a builtin prototype
 * method transferred through an OBJECT LITERAL:
 *
 *     var o = { split: String.prototype.split };
 *     o.split();                       // ✓ handled there
 *
 * Every Sputnik-era test writes the transfer as a **property assignment**
 * instead, and that shape was not merely unhandled — it was the exact case the
 * wave-3 module *declines on purpose* (`memberSlotIsWrittenTo`), because an
 * assignment invalidates the literal's initializer as proof of the slot's
 * contents:
 *
 *     var o = {};
 *     o.split = String.prototype.split;
 *     o.split();                       // ✗ base: TypeError
 *
 * ## Measured on this branch's base (`runTest262File(…, "standalone")`)
 *
 * | probe                                                        | base                                          | spec                |
 * | ------------------------------------------------------------ | --------------------------------------------- | ------------------- |
 * | `var o={}; o.split=String.prototype.split; o.split()`        | **THREW** `TypeError: Cannot access property on null or undefined` | `["[object Object]"]` |
 * | `var x={}; x.getClass=Object.prototype.toString; x.getClass()` | **THREW** same                                | `"[object Object]"`  |
 *
 * Same root cause as wave-3: `compileCallablePropertyCall`'s funcref dispatch
 * admits candidates by exact param count against the field's DECLARED
 * signature, and a native-proto member closure is lifted to `(self, this,
 * …args)`. No candidate matches, the guarded `ref.cast` yields null, and the
 * null funcref surfaces as that TypeError.
 *
 * ## What makes the assignment form sound to resolve
 *
 * The literal arm's proof is "the initializer says so, and nobody writes the
 * slot". The assignment arm's proof is the dual: **exactly one** write to
 * `<recv>.<member>` exists in the file, its right-hand side is syntactically
 * `<Iface>.prototype.<name>`, and it textually precedes the call. Anything that
 * could make a *different* value reach the slot — a second write, a computed
 * `recv[…]` write, or a rebinding of `recv` itself — declines the whole arm.
 *
 * Textual precedence is deliberately a weaker claim than dominance, and it is
 * enough here for the same reason the literal arm's is: the alternative on a
 * decline is the pre-existing TypeError, never a silent wrong answer. A write
 * that textually precedes the call but is not executed before it (inside a
 * branch, a loop, a later-called function) leaves the slot holding `undefined`,
 * and calling `undefined` must throw — which is what the un-resolved lowering
 * already does. So a mis-prediction cannot turn a throw into a wrong value.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileExpression } from "../shared.js";
import { resolveObjectToStringTag } from "../object-proto-tostring.js";

/** Unwrap parenthesized / `as` / non-null wrappers to the underlying expression. */
function unwrapTransparent(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/** `<Id>.prototype.<name>` (with `<Id>` a plain identifier), else `undefined`. */
function asProtoMemberAccess(e: ts.Expression): ts.PropertyAccessExpression | undefined {
  const v = unwrapTransparent(e);
  if (!ts.isPropertyAccessExpression(v)) return undefined;
  if (ts.isPrivateIdentifier(v.name)) return undefined;
  const base = v.expression;
  if (!ts.isPropertyAccessExpression(base)) return undefined;
  if (base.name.text !== "prototype") return undefined;
  if (!ts.isIdentifier(base.expression)) return undefined;
  return v;
}

/**
 * The `<Iface>.prototype.<member>` access that a single, unambiguous
 * `<recvName>.<memberName> = …` assignment in `file` puts into the slot, or
 * `undefined` when no such proof exists.
 *
 * DECLINES (each leaves the caller's pre-existing lowering byte-identical):
 *   - `recvName` is itself re-assigned anywhere (`recvName = …`), so the
 *     identifier at the call need not denote the object that was written;
 *   - any computed `recvName[…] = …` write, which could name `memberName`;
 *   - zero, or more than one, `recvName.memberName = …` write;
 *   - a right-hand side that is not syntactically `<Id>.prototype.<name>`;
 *   - a write that does not textually precede `callPos`.
 */
export function resolveAssignedTransferredProtoMember(
  file: ts.SourceFile,
  recvName: string,
  memberName: string,
  callPos: number,
): ts.PropertyAccessExpression | undefined {
  let bailed = false;
  const writes: ts.BinaryExpression[] = [];

  const visit = (node: ts.Node): void => {
    if (bailed) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isIdentifier(left) && left.text === recvName) {
        // The binding itself is re-pointed — the slot proof is per-object.
        bailed = true;
        return;
      }
      if (ts.isElementAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === recvName) {
        bailed = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(left) &&
        !ts.isPrivateIdentifier(left.name) &&
        left.name.text === memberName &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === recvName
      ) {
        writes.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (bailed || writes.length !== 1) return undefined;
  const write = writes[0]!;
  if (write.end > callPos) return undefined;
  return asProtoMemberAccess(write.right);
}

/**
 * (#4491 wave-5 T1) `recv.m(…args)` where the slot holds
 * `Object.prototype.toString` → compile the equivalent
 * `Object.prototype.toString.call(recv, …args)` **syntax**.
 *
 * Why this member gets its own emitter rather than the reflective-closure route
 * every other transferred method takes: measured on this branch's base, routing
 * it through `emitReflectiveNativeProtoClosureCall` reaches the Object glue's
 * `toString`, whose native body is the catchable-refusal stand-in, so
 * `x.getClass()` answered `TypeError: Object.prototype.toString is not yet
 * implemented in --target standalone`. The `.call` SPELLING is handled — by the
 * #2501 compile-time `[object X]` tag classifier — so re-emitting the syntax
 * routes the transfer to the arm that already answers, instead of teaching a
 * second site the same tag rules.
 *
 * `protoAccess` is the REAL `Object.prototype.toString` node from the transfer's
 * right-hand side, so `checker.getTypeAtLocation` still sees a real binding for
 * the base; only the `.call` access and the call itself are synthesized. The
 * receiver is likewise the caller's real identifier node, which is what the tag
 * classifier reads. Returns `undefined` having emitted nothing when the member
 * is not `Object.prototype.toString`.
 */
export function tryEmitTransferredObjectToStringCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  recvExpr: ts.Identifier,
  protoAccess: ts.PropertyAccessExpression,
): ValType | undefined {
  const base = protoAccess.expression as ts.PropertyAccessExpression;
  if (!ts.isIdentifier(base.expression) || base.expression.text !== "Object") return undefined;
  if (protoAccess.name.text !== "toString") return undefined;
  // Gate BEFORE emitting: the `.call` arm answers only when the §20.1.3.6 tag
  // is statically resolvable for this receiver, and it refuses loudly otherwise.
  // Checking first means a non-resolvable receiver declines having emitted
  // nothing, leaving the caller's pre-existing lowering (and its TypeError)
  // exactly as it was — never a half-emitted expression.
  if (resolveObjectToStringTag(ctx, recvExpr) === undefined) return undefined;

  const callProp = ts.factory.createPropertyAccessExpression(protoAccess, "call");
  ts.setTextRange(callProp, protoAccess);
  (callProp as unknown as { parent: ts.Node }).parent = expr;
  const callExpr = ts.factory.createCallExpression(callProp, undefined, [recvExpr, ...expr.arguments]);
  ts.setTextRange(callExpr, expr);
  (callExpr as unknown as { parent: ts.Node }).parent = expr.parent;

  const result = compileExpression(ctx, fctx, callExpr);
  return result === null || typeof result !== "object" ? undefined : result;
}
