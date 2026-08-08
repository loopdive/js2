// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4243) `arguments.callee` inside STRICT code is a poison read.
 *
 * ## What the spec says, and what this module does about it
 * ES5 §10.6 step 14 gives a strict arguments object a `callee` property that is
 * an ACCESSOR whose `[[Get]]` and `[[Set]]` are both %ThrowTypeError%, with
 * `{enumerable: false, configurable: false}`. Minting that faithfully needs an
 * in-module callable throwing-function value to install as the getter and
 * setter — machinery this lane does not have yet.
 *
 * What it CAN do without that machinery is the case the spec text exists to
 * produce: a direct `arguments.callee` read in strict code throws a TypeError.
 * That is decided entirely syntactically, so it needs no runtime accessor at
 * all — the exact same trade `function-poison-pill-access.ts` makes for a
 * strict function's `caller`/`arguments` (#4221), and this module is
 * deliberately its twin.
 *
 * ## What that buys and what it does not
 * Covered: `arguments.callee` (or `arguments["callee"]`) written inside a strict
 * function — `language/arguments-object/10.6-2gs`, `10.6-13-c-1-s`.
 *
 * NOT covered, and the boundary is worth naming precisely: anything that
 * reaches the property through a VALUE rather than through the `arguments`
 * identifier. `var argObj = (function(){ return arguments })(); argObj.callee`
 * is the same property in the spec but a different expression here, so
 * `10.6-14-c-4-s` (assignment through an escaped arguments object) and the
 * descriptor queries `10.6-13-c-2-s` / `10.6-13-c-3-s` still need the real
 * accessor. Those stay on #4243's leftovers list.
 *
 * ## The load-bearing negative case
 * The receiver must be the IMPLICIT `arguments` binding. A program that
 * declares its own (`var arguments = …`, or a parameter named `arguments` —
 * both legal in sloppy code, and `10.6-6-3`/`10.6-6-4` in this very directory
 * do the former) must keep its ordinary property read. `valueDeclarationOf`
 * answering anything at all means the identifier resolved to a real
 * declaration, so it is not the implicit object and this declines.
 *
 * Lane-independent by design: strictness is a source property, not a target
 * one, so the gc lane gets the same throw. That matches how #4221 shipped its
 * `caller`/`arguments` poison.
 */
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import { emitThrowTypeError } from "./js-errors.js";
import { compileExpression, skipTransparentExpressions } from "./shared.js";

type MemberExpression = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** The `callee` key of a member expression, or `undefined` for anything else. */
function calleeReceiver(expression: MemberExpression): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    if (ts.isPrivateIdentifier(expression.name)) return undefined;
    return expression.name.text === "callee" ? expression.expression : undefined;
  }
  const key = skipTransparentExpressions(expression.argumentExpression);
  if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) return undefined;
  return key.text === "callee" ? expression.expression : undefined;
}

/**
 * Compile a strict-mode `arguments.callee` read as a TypeError throw, or
 * decline with `undefined`.
 */
export function tryCompileArgumentsCalleePoison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: MemberExpression,
): ValType | undefined {
  const receiver = calleeReceiver(expression);
  if (receiver === undefined) return undefined;
  const base = skipTransparentExpressions(receiver);
  if (!ts.isIdentifier(base) || base.text !== "arguments") return undefined;
  // A user-declared `arguments` shadows the implicit object — ordinary read.
  if (ctx.oracle.valueDeclarationOf(base) !== undefined) return undefined;
  if (!isStrictContext(expression, ctx.inferModuleStrictArguments)) return undefined;

  // Evaluate the receiver for its side effects before throwing, so the
  // observable order matches an ordinary member read that happens to hit a
  // throwing getter. (A bare identifier has none, but an element access can
  // carry one in its key, handled below.)
  const receiverType = compileExpression(ctx, fctx, receiver);
  if (receiverType) fctx.body.push({ op: "drop" });
  if (ts.isElementAccessExpression(expression)) {
    const keyType = compileExpression(ctx, fctx, expression.argumentExpression);
    if (keyType) fctx.body.push({ op: "drop" });
  }
  emitThrowTypeError(ctx, fctx, "Access to strict-mode arguments.callee is forbidden");
  return { kind: "externref" };
}
