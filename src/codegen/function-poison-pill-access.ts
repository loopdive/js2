// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Property get/set lowering for ES5 Function poison accessors. */

import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { tryCompileArgumentsCalleePoison } from "./arguments-callee-poison.js"; // (#4243)
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { emitUndefined } from "./expressions/late-imports.js";
import {
  ensureCallerStrictSnapshot,
  isBoundFunctionValue,
  isCurrentSourceFunctionValue,
  isStrictFunctionConstructorValue,
  sourceFunctionForValue,
} from "./function-poison-pill.js";
import { isStrictFunction } from "./helpers/is-strict-function.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { isStaticFunctionSelfName } from "./static-function-self-names.js";
import { compileExpression, skipTransparentExpressions, type InnerResult } from "./shared.js";
import { tryCompileRegExpLegacyStaticWrite } from "./regexp-legacy-static.js";

type MemberExpression = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function poisonMember(
  expression: MemberExpression,
): { receiver: ts.Expression; name: string; computedKey?: ts.Expression } | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    if (ts.isPrivateIdentifier(expression.name)) return undefined;
    return { receiver: expression.expression, name: expression.name.text };
  }
  const key = skipTransparentExpressions(expression.argumentExpression);
  if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) return undefined;
  return {
    receiver: expression.expression,
    name: key.text,
    computedKey: expression.argumentExpression,
  };
}

/**
 * (#5270 step 10, cluster N) True when reading or writing `caller` /
 * `arguments` on this function value must throw %ThrowTypeError%.
 *
 * §10.2.4 AddRestrictedFunctionProperties installs the poison accessors on
 * every function EXCEPT the legacy sloppy-mode ordinary function, so an ARROW
 * is restricted regardless of the surrounding strictness — arrows have no
 * `arguments` binding and no `caller` at all. The base predicate only knew
 * about strict SOURCE functions, so `(() => {}).caller` answered `undefined`
 * where `ArrowFunction_restricted-properties` requires a TypeError.
 *
 * Methods, generators and class bodies are the same family; #5195 T owns those
 * and should share this predicate rather than adding a second one.
 *
 * (#5270 review R3-F2) The arrow answer is NOT unconditional — those accessors
 * are `configurable: true` and the binding can be rebound, so it is qualified by
 * `arrowValueStillCarriesRestrictedAccessors` below.
 */
function hasRestrictedProperties(
  ctx: CodegenContext,
  sourceFunction: ts.FunctionLikeDeclaration,
  receiver: ts.Expression,
): boolean {
  if (ts.isArrowFunction(sourceFunction)) return arrowValueStillCarriesRestrictedAccessors(receiver);
  return isStrictFunction(sourceFunction, ctx.inferModuleStrictArguments);
}

/**
 * (#5270 review R3-F2) An arrow's restricted `caller`/`arguments` accessors are
 * `configurable: true` (§10.2.4), so they are a fact about the value's CREATION,
 * not about its lifetime — exactly the reasoning this wave already applied to the
 * sibling `"prototype" in arrow` fold (`binary-ops-in.ts`,
 * `arrowBindingNeverGainsProperties`). Anyone holding the arrow can replace them:
 *
 *   var b = () => 2;
 *   Object.defineProperty(b, "arguments", { value: 7, configurable: true });
 *   b.arguments;   // node 7 · base 7 · unguarded fold TypeError
 *
 * and a REBOUND binding is not the arrow at all (`var f = () => 1; f = function(){}`
 * — node `null`, base `undefined`, unguarded fold TypeError). Turning a
 * wrong-but-stable answer into a throw is strictly worse than base: the throw
 * kills the rest of the enclosing evaluation.
 *
 * So the unconditional `true` is now earned only two ways:
 *  - an arrow LITERAL receiver (`(() => {}).caller`) — no binding exists for
 *    anyone to rebind or to hand to `Object.defineProperty`; or
 *  - an identifier whose EVERY appearance in the file is a "custodial" use: the
 *    receiver of a member access (`arrowFn.caller`, `arrowFn.caller = {}`,
 *    `arrowFn.hasOwnProperty("caller")`) or a direct callee (`k()`).
 *
 * The custodial-use test is one scan and subsumes three separate guards. A call
 * ARGUMENT (`Object.defineProperty(b, …)`, `Object.assign(b, …)`) is not
 * custodial, so escapes are refused; neither is a bare identifier in any other
 * position, which refuses BOTH rebinding in every spelling (`f = …`, `[f] = src`,
 * `({f} = src)`, `for (f of src)`, `f++`) and aliasing (`var m = k`, `return k`)
 * without enumerating any of them. A member WRITE through the binding needs no
 * check at all: `k.caller = x` and `k["caller"] = x` both go through the
 * inherited poison SETTER and throw, so they can never install an own
 * `caller`/`arguments` — only `defineProperty`, which is a call argument, can.
 *
 * Conservative in the safe direction: a refusal costs only the fold, handing
 * back base's answer, while a false `true` is a spurious throw.
 */
function arrowValueStillCarriesRestrictedAccessors(receiver: ts.Expression): boolean {
  const expr = skipTransparentExpressions(receiver);
  if (ts.isArrowFunction(expr)) return true;
  if (!ts.isIdentifier(expr)) return false;
  return identifierOnlyUsedCustodially(expr.getSourceFile(), expr.text);
}

/** Every `name` reference in `file` is a member-access receiver or a direct callee. */
function identifierOnlyUsedCustodially(file: ts.SourceFile, name: string): boolean {
  let escaped = false;
  const visit = (node: ts.Node): void => {
    if (escaped) return;
    if (ts.isIdentifier(node) && node.text === name && !isCustodialIdentifierUse(node)) {
      escaped = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return !escaped;
}

/** The binding's own declaration name, a member-access receiver, or a callee. */
function isCustodialIdentifierUse(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) {
    return true;
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true;
  return false;
}

/** Compile a statically-proven poison get, or decline with `undefined`. */
export function tryCompileFunctionPoisonRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: MemberExpression,
): ValType | undefined {
  // (#4243) §10.6 step 14's sibling poison, dispatched from the same hook so
  // both `property-access.ts` call sites get it without a third entry point.
  const calleePoison = tryCompileArgumentsCalleePoison(ctx, fctx, expression);
  if (calleePoison !== undefined) return calleePoison;

  const member = poisonMember(expression);
  if (!member || (member.name !== "caller" && member.name !== "arguments")) return undefined;

  const sourceFunction = sourceFunctionForValue(ctx, member.receiver);
  // (#4221) A bound function poisons `caller`/`arguments` unconditionally
  // (§15.3.4.5 steps 20-21) — the same terminal throw as the strict case.
  const strictFunction =
    (sourceFunction !== undefined && hasRestrictedProperties(ctx, sourceFunction, member.receiver)) ||
    isBoundFunctionValue(ctx, member.receiver) ||
    // (#4464) `var foo = Function("'use strict';")` — a strict function with no
    // source declaration for `sourceFunctionForValue` to find.
    isStrictFunctionConstructorValue(ctx, member.receiver);
  const currentSloppyCallerRead =
    member.name === "caller" &&
    !strictFunction &&
    (isCurrentSourceFunctionValue(ctx, fctx, member.receiver) || isStaticFunctionSelfName(ctx, fctx, member.receiver));
  if (!strictFunction && !currentSloppyCallerRead) return undefined;

  const receiverType = compileExpression(ctx, fctx, member.receiver);
  if (receiverType) fctx.body.push({ op: "drop" });
  if (member.computedKey) {
    const keyType = compileExpression(ctx, fctx, member.computedKey);
    if (keyType) fctx.body.push({ op: "drop" });
  }

  if (strictFunction) {
    emitThrowTypeError(ctx, fctx, `Access to strict function '${member.name}' is forbidden`);
    return { kind: "externref" };
  }

  const callerStrictLocalIdx = ensureCallerStrictSnapshot(ctx, fctx);
  emitUndefined(ctx, fctx);
  const undefinedLocal = allocLocal(fctx, `__fn_${member.name}_undefined_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: undefinedLocal });
  const throwInstrs = buildThrowJsErrorInstrs(ctx, "TypeError", "Access to a strict function caller is forbidden", {
    flush: fctx,
  });
  fctx.body.push(
    { op: "local.get", index: callerStrictLocalIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: throwInstrs,
      else: [{ op: "local.get", index: undefinedLocal }],
    },
  );
  return { kind: "externref" };
}

/** Compile a statically-proven strict-function poison set, or decline. */
export function tryCompileStrictFunctionPoisonAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: MemberExpression,
  value: ts.Expression,
): InnerResult | undefined {
  const regexpResult = tryCompileRegExpLegacyStaticWrite(ctx, fctx, target, value);
  if (regexpResult !== undefined) return regexpResult;
  const member = poisonMember(target);
  if (!member || (member.name !== "caller" && member.name !== "arguments")) return undefined;
  const sourceFunction = sourceFunctionForValue(ctx, member.receiver);
  const poisoned =
    (sourceFunction !== undefined && hasRestrictedProperties(ctx, sourceFunction, member.receiver)) ||
    // (#4221) `boundFn.arguments = 12` hits the same [[ThrowTypeError]] setter.
    isBoundFunctionValue(ctx, member.receiver) ||
    // (#4464) …and so does the `Function("'use strict';")` product.
    isStrictFunctionConstructorValue(ctx, member.receiver);
  if (!poisoned) return undefined;

  const receiverType = compileExpression(ctx, fctx, member.receiver);
  if (receiverType) fctx.body.push({ op: "drop" });
  if (member.computedKey) {
    const keyType = compileExpression(ctx, fctx, member.computedKey);
    if (keyType) fctx.body.push({ op: "drop" });
  }
  const rhsType = compileExpression(ctx, fctx, value);
  if (rhsType) fctx.body.push({ op: "drop" });
  emitThrowTypeError(ctx, fctx, `Assignment to strict function '${member.name}' is forbidden`);
  return rhsType ?? { kind: "externref" };
}
