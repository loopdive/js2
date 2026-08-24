// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2875, sub-cluster b2) The ES5 *genericity* idiom — a builtin prototype
 * method TRANSFERRED onto an ordinary object and then called through that
 * object's own slot:
 *
 *     var o = { toString: function(){ return "abcd"; },
 *               charAt:   String.prototype.charAt };
 *     o.charAt(1);                    // spec: "b"  (ToString(o).charAt(1))
 *
 * ## The defect this module closes
 *
 * Measured on this branch's base with `runTest262File(…, "standalone")`, the
 * probe above and its `.call` twin:
 *
 * | spelling                               | base                                            | spec  |
 * | -------------------------------------- | ----------------------------------------------- | ----- |
 * | `String.prototype.charAt.call(o, 1)`   | `"b"`                                           | `"b"` |
 * | `o.charAt(1)`                          | **THREW** `TypeError: Cannot access property on null or undefined` | `"b"` |
 *
 * Same operation, same stored value, two answers — and the failing one is the
 * spelling every Sputnik-era test uses.
 *
 * ## Root cause
 *
 * The slot call goes through `compileCallablePropertyCall`, whose funcref
 * dispatch admits candidates by EXACT param count against the field's DECLARED
 * signature (`charAt: (pos: number) => string` — one param). A native-proto
 * member closure is lifted to `(self, this, …args)`, i.e. TWO params here, so no
 * candidate matched, the guarded `ref.cast` produced null, and the null funcref
 * surfaced as that TypeError.
 *
 * Widening the candidate filter was rejected: it would admit any same-arity
 * closure on a mis-typed field, which trades a loud failure for a silent
 * mis-dispatch. Instead this module resolves the SYNTAX that put the value in
 * the slot and re-emits the call as the reflective
 * `<Iface>.prototype.<member>.call(recv, …args)` it is equivalent to — reusing
 * `emitReflectiveNativeProtoClosureCall`, the one emitter the `.call` spelling
 * already uses, so the two cannot disagree.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { getNativeProtoBuiltinGlue } from "../native-proto.js";
import { emitReflectiveNativeProtoClosureCall, nativeProtoBrandForInterface } from "./calls.js";
import {
  resolveAssignedTransferredProtoMember,
  tryEmitTransferredObjectToStringCall,
} from "./transferred-proto-assignment.js";

/** Unwrap parenthesized / `as` / non-null wrappers to the underlying expression. */
function unwrapTransparent(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * `recv.m(…args)` where `recv`'s object literal seeded `m` from
 * `<Iface>.prototype.<member>` → emit the equivalent reflective closure call.
 * Returns the pushed `ValType`, or `undefined` having emitted NOTHING so the
 * caller's existing dispatch continues unchanged.
 *
 * DECLINES (each keeps the pre-existing lowering byte-identical):
 *   - not standalone, or a receiver that is not a plain identifier;
 *   - a receiver whose single initializer is not an object literal, or whose
 *     `m` property is not syntactically `<Id>.prototype.<member>`;
 *   - a module that ASSIGNS `recv.m` (or any `recv[…]`) anywhere — the
 *     initializer would no longer prove what the slot holds at the call;
 *   - an interface with no wired glue, or a member whose glue kind is not
 *     `method` (a getter has a different ABI).
 */
export function tryEmitTransferredNativeProtoMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (ts.isPrivateIdentifier(propAccess.name)) return undefined;
  const recvExpr = unwrapTransparent(propAccess.expression);
  if (!ts.isIdentifier(recvExpr)) return undefined;
  const memberName = propAccess.name.text;

  const protoAccess = resolveTransferredProtoMemberFromEitherSpelling(ctx, recvExpr, memberName, expr);
  if (protoAccess === undefined) return undefined;

  // (#4491 wave-5 T1) `Object.prototype.toString` is resolved by the #2501
  // compile-time tag classifier, not by the Object glue — whose `toString` body
  // is the catchable-refusal stand-in. Try it before the glue route below;
  // declines emit nothing.
  const objToString = tryEmitTransferredObjectToStringCall(ctx, fctx, expr, recvExpr, protoAccess);
  if (objToString !== undefined) return objToString;

  const ifaceId = (protoAccess.expression as ts.PropertyAccessExpression).expression as ts.Identifier;
  const brand = nativeProtoBrandForInterface(ctx, ifaceId.text);
  if (brand === undefined) return undefined;
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return undefined;
  const member = protoAccess.name.text;
  if (glue.memberKind(member) !== "method") return undefined;

  return emitReflectiveNativeProtoClosureCall(
    ctx,
    fctx,
    { arguments: [recvExpr, ...expr.arguments] },
    protoAccess,
    brand,
    member,
    "method",
    /* isCall */ true,
  );
}

/**
 * (#4491 wave-5 T1) The `<Iface>.prototype.<member>` access the slot holds,
 * proved by EITHER transfer spelling — the wave-3 object-literal initializer,
 * or the wave-5 single-assignment form. Order matters: the literal arm is tried
 * first and keeps its own write-guard, so every program the literal arm already
 * resolved lowers byte-identically; only literal-arm DECLINES reach the
 * assignment arm.
 */
function resolveTransferredProtoMemberFromEitherSpelling(
  ctx: CodegenContext,
  recvExpr: ts.Identifier,
  memberName: string,
  expr: ts.CallExpression,
): ts.PropertyAccessExpression | undefined {
  const initializer = ctx.oracle.variableInitializerOf(recvExpr);
  if (initializer !== undefined && ts.isObjectLiteralExpression(initializer)) {
    const fromLiteral = resolveTransferredProtoMember(initializer, memberName);
    if (fromLiteral !== undefined && !memberSlotIsWrittenTo(recvExpr.getSourceFile(), recvExpr.text, memberName)) {
      return fromLiteral;
    }
  }
  return resolveAssignedTransferredProtoMember(recvExpr.getSourceFile(), recvExpr.text, memberName, expr.getStart());
}

/**
 * The `<Iface>.prototype.<member>` access `literal`'s `memberName` property is
 * initialized with, or `undefined`. The LAST matching property wins, mirroring
 * §13.2.5 duplicate-key evaluation order.
 */
function resolveTransferredProtoMember(
  literal: ts.ObjectLiteralExpression,
  memberName: string,
): ts.PropertyAccessExpression | undefined {
  let found: ts.PropertyAccessExpression | undefined;
  for (const prop of literal.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteralLike(prop.name)) continue;
    if (prop.name.text !== memberName) continue;
    const value = unwrapTransparent(prop.initializer);
    found =
      ts.isPropertyAccessExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      value.expression.name.text === "prototype" &&
      ts.isIdentifier(value.expression.expression)
        ? value
        : undefined;
  }
  return found;
}

/**
 * Whether `<recvName>.<memberName>` — or any computed `<recvName>[…]`, which
 * could name it — is ASSIGNED anywhere in `file`. Conservative on purpose: the
 * arm's soundness rests entirely on the literal's initializer still being what
 * the slot holds at the call site.
 */
function memberSlotIsWrittenTo(file: ts.SourceFile, recvName: string, memberName: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (
        ts.isPropertyAccessExpression(left) &&
        !ts.isPrivateIdentifier(left.name) &&
        left.name.text === memberName &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === recvName
      ) {
        found = true;
        return;
      }
      if (ts.isElementAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === recvName) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
