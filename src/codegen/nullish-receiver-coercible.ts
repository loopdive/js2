// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4484 B) §7.3.2 RequireObjectCoercible at the MEMBER-EXPRESSION choke point —
 * `undefined.toString()`, `null.toString()`, `undefined["toString"]()`,
 * `undefined.foo`.
 *
 * ## The measured defect
 *
 * §13.3.2.1 evaluates `MemberExpression . IdentifierName` to a Reference whose
 * base is the *value* of the MemberExpression; `GetValue` on that Reference runs
 * `RequireObjectCoercible(base)`, which throws a **TypeError** for `null` and
 * `undefined`. Probed on this branch (`.tmp/probes/b4.js`), all four forms
 * returned WITHOUT THROWING AT ALL:
 *
 * | form                      | before      | spec      |
 * | ------------------------- | ----------- | --------- |
 * | `undefined.toString()`    | no throw    | TypeError |
 * | `null.toString()`         | no throw    | TypeError |
 * | `undefined["toString"]()` | no throw    | TypeError |
 * | `null["toString"]()`      | no throw    | TypeError |
 * | `undefined.foo`           | no throw    | TypeError |
 * | `null.foo`                | TypeError ✓ | TypeError |
 *
 * Only the last row worked, and only for the property-READ shape: a `toString`
 * receiver is intercepted by the builtin-method dispatch far upstream of any
 * null check, and the interception never looks at whether the receiver can
 * carry a method at all. `language/expressions/property-accessors/S11.2.1_A3_T4`
 * and `_A3_T5` fail on exactly this (measured fail→pass).
 *
 * ## Why a SYNTACTIC proof and not the checker
 *
 * The guard fires only on a receiver that is syntactically the `null` literal,
 * the un-shadowed global `undefined`, or `void <literal>` — never on a static
 * TYPE that happens to be `undefined`. Two independent reasons, each sufficient:
 *
 *  - A wrong throw here is *catchable* and therefore observable, and the static
 *    type of a binding is routinely wrong about its value at a given site. The
 *    sibling defect this issue also fixes — the `instanceof` / `in` folds firing
 *    on a REASSIGNED binding whose declared type is stale — is the same mistake
 *    in the same shape (`S11.8.6_A2.4_T1`, `S11.8.7_A2.4_T1`).
 *  - TypeScript reports `undefined` as the *flow* type of the test262 probe
 *    idiom `var probe; function f(){ probe = {}; } f(); probe.x;` — the exact
 *    false positive `isEvolvingAnyBinding` exists to stop in `calls-guards.ts`.
 *
 * A syntactic `null` / `undefined` receiver cannot be any of those: no binding
 * is involved, so there is nothing for control flow to be wrong about.
 *
 * ## Evaluation order
 *
 * §13.3.6.1 evaluates the MemberExpression, and `GetValue` on the resulting
 * Reference throws BEFORE the argument list is evaluated. So the call form
 * evaluates the receiver and (for a computed member) the key, then throws —
 * arguments are deliberately NOT compiled. `f(sideEffect())` never runs
 * `sideEffect` when `f` is `undefined.m`.
 *
 * Optional chains (`undefined?.foo`, `null?.m()`) short-circuit instead of
 * throwing and are excluded up front.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { InnerResult } from "./shared.js";
import { compileExpression } from "./shared.js";
import { emitThrowTypeError } from "./expressions/helpers.js";

/** Strip the transparent wrappers between a receiver position and its value. */
function unwrapReceiver(expr: ts.Expression): ts.Expression {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
}

/**
 * True when `expr` is SYNTACTICALLY the `null` literal, the global `undefined`,
 * or `void <literal>` — the three receivers whose value is `null`/`undefined`
 * with no binding in between, so no control-flow analysis can be wrong about it.
 *
 * `undefined` is admitted only when no enclosing binding shadows it. It is not
 * a reserved word, and `function f(undefined) { undefined.x }` is legal code
 * where the receiver may be anything at all. Shadowing is tested TWO ways
 * because neither alone is sufficient: `fctx.localMap` sees only bindings that
 * reached a wasm local (a `const undefined = {…}` inside the current function
 * may be lowered elsewhere and is then invisible there — measured: the pin
 * "does NOT throw when `undefined` is shadowed by a local" failed with the map
 * check alone), and the oracle sees the DECLARATION, which is the real question.
 * The lib.d.ts `declare const undefined: undefined` must not count as a shadow.
 */
export function isSyntacticallyNullishReceiver(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): boolean {
  const target = unwrapReceiver(expr);
  if (target.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(target) && target.text === "undefined" && !isShadowedUndefined(ctx, fctx, target)) return true;
  // `void 0` / `void "s"` — the operand must be side-effect-free, otherwise the
  // throw would skip an effect the spec runs.
  if (ts.isVoidExpression(target)) {
    const op = unwrapReceiver(target.expression);
    return (
      ts.isNumericLiteral(op) ||
      ts.isStringLiteralLike(op) ||
      op.kind === ts.SyntaxKind.NullKeyword ||
      op.kind === ts.SyntaxKind.TrueKeyword ||
      op.kind === ts.SyntaxKind.FalseKeyword
    );
  }
  return false;
}

/** True when a USER binding named `undefined` shadows the global at this site. */
function isShadowedUndefined(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): boolean {
  if (fctx.localMap.has("undefined")) return true;
  if (fctx.boxedCaptures?.has("undefined") ?? false) return true;
  if (ctx.moduleGlobals?.has("undefined") ?? false) return true;
  const decl = ctx.oracle.valueDeclarationOf(id);
  return decl !== undefined && !decl.getSourceFile().isDeclarationFile;
}

/** The V8-shaped message the rest of the codegen already emits for this class. */
function coercibleMessage(receiver: ts.Expression, property: string | undefined): string {
  const base = unwrapReceiver(receiver).kind === ts.SyntaxKind.NullKeyword ? "null" : "undefined";
  return property === undefined
    ? `Cannot read properties of ${base}`
    : `Cannot read properties of ${base} (reading '${property}')`;
}

/** The static property name of a member access, when it has one. */
function staticPropertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const arg = node.argumentExpression;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isNumericLiteral(arg)) return arg.text;
  return undefined;
}

/**
 * §7.3.2 for a member READ (`undefined.foo`, `null["foo"]`). Emits the receiver
 * (and a computed key) for side effects, then the TypeError. Returns the
 * (unreachable) result type, or `undefined` to decline.
 */
export function tryEmitNullishReceiverMemberRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): InnerResult | undefined {
  if (expr.questionDotToken !== undefined || ts.isOptionalChain(expr)) return undefined;
  if (!isSyntacticallyNullishReceiver(ctx, fctx, expr.expression)) return undefined;
  emitCoercibleThrow(ctx, fctx, expr);
  return { kind: "externref" };
}

/**
 * §7.3.2 for a member CALL (`undefined.toString()`, `null["toString"]()`).
 * Arguments are NOT evaluated — `GetValue` on the callee Reference throws first
 * (§13.3.6.1). Returns the (unreachable) result type, or `undefined` to decline.
 */
export function tryEmitNullishReceiverCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (expr.questionDotToken !== undefined || ts.isOptionalChain(expr)) return undefined;
  const callee = unwrapReceiver(expr.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
  if (callee.questionDotToken !== undefined) return undefined;
  if (!isSyntacticallyNullishReceiver(ctx, fctx, callee.expression)) return undefined;
  emitCoercibleThrow(ctx, fctx, callee);
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/** Receiver → computed key → throw, in spec order, all results discarded. */
function emitCoercibleThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): void {
  const recvType = compileExpression(ctx, fctx, member.expression);
  if (recvType !== null) fctx.body.push({ op: "drop" });
  if (ts.isElementAccessExpression(member) && staticPropertyName(member) === undefined) {
    const keyType = compileExpression(ctx, fctx, member.argumentExpression);
    if (keyType !== null) fctx.body.push({ op: "drop" });
  }
  emitThrowTypeError(ctx, fctx, coercibleMessage(member.expression, staticPropertyName(member)));
}
