// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Narrow source admission for standalone `Reflect.set` (#2046).
 *
 * The native helper implements OrdinarySetWithOwnDescriptor only for the
 * ordinary `$Object` carrier. This pre-scan therefore promotes exactly the
 * source-proven object literals the native target path can serve, before
 * declarations choose their Wasm representation. The explicit-receiver path
 * additionally requires an ordinary literal or definitely primitive receiver.
 * Typed arrays, Proxy targets/receivers, aliases, and dynamic object values
 * deliberately stay on the existing compile-error path owned by their
 * respective slices.
 */
import { forEachChild, ts } from "../ts-api.js";
import type { TypeFact } from "../checker/oracle.js";
import type { CodegenContext } from "./context/types.js";
import { resolvesToAmbientGlobal } from "./expressions/non-constructable.js";

function unwrap(value: ts.Expression): ts.Expression {
  let current = value;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The final value of a comma expression is the only receiver/target value. */
function sourceValue(value: ts.Expression): ts.Expression {
  let current = unwrap(value);
  while (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    current = unwrap(current.right);
  }
  return current;
}

/** A bare name in a `with` body is resolved dynamically at runtime. */
function isInsideWithStatementBody(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    const parent: ts.Node | undefined = current.parent;
    if (parent !== undefined && ts.isWithStatement(parent) && parent.statement === current) return true;
  }
  return false;
}

/** The source spelling `Reflect` is native only when it is not locally shadowed. */
function isGlobalReflectIdentifier(ctx: CodegenContext, value: ts.Expression): value is ts.Identifier {
  return ts.isIdentifier(value) && value.text === "Reflect" && resolvesToAmbientGlobal(ctx, value);
}

function forEachWriteTarget(target: ts.Node, visit: (identifier: ts.Identifier) => void): void {
  if (ts.isIdentifier(target)) {
    visit(target);
    return;
  }
  if (
    ts.isParenthesizedExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isNonNullExpression(target) ||
    ts.isSatisfiesExpression(target) ||
    ts.isTypeAssertionExpression(target)
  ) {
    forEachWriteTarget(target.expression, visit);
    return;
  }
  // Destructuring defaults appear as `BindingElement` nodes in declarations
  // and as `x = fallback` binary expressions in assignment patterns. Both
  // initialize/write the binding on their left, so they must participate in
  // this fail-loud admission proof as well.
  if (ts.isBindingElement(target)) {
    forEachWriteTarget(target.name, visit);
    return;
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    forEachWriteTarget(target.left, visit);
    return;
  }
  if (ts.isObjectLiteralExpression(target)) {
    for (const property of target.properties) {
      if (ts.isPropertyAssignment(property)) forEachWriteTarget(property.initializer, visit);
      else if (ts.isShorthandPropertyAssignment(property)) visit(property.name);
      else if (ts.isSpreadAssignment(property)) forEachWriteTarget(property.expression, visit);
    }
    return;
  }
  if (ts.isObjectBindingPattern(target)) {
    for (const element of target.elements) forEachWriteTarget(element, visit);
    return;
  }
  if (ts.isArrayLiteralExpression(target)) {
    for (const element of target.elements) {
      if (ts.isOmittedExpression(element)) continue;
      forEachWriteTarget(ts.isSpreadElement(element) ? element.expression : element, visit);
    }
    return;
  }
  if (ts.isArrayBindingPattern(target)) {
    for (const element of target.elements) {
      if (!ts.isOmittedExpression(element)) forEachWriteTarget(element, visit);
    }
  }
}

/**
 * Is an identifier permanently bound to its literal initializer? We do not
 * relax this by source position: an apparent later write can run first through
 * a deferred function or on a later loop iteration. A control-flow proof for
 * eager, non-repeatable evaluation is intentionally out of this narrow slice,
 * so any binding write preserves the existing explicit-refusal path.
 * Resolution goes through the oracle so same-spelled Test262 harness locals
 * are not mistaken for this binding.
 */
function literalBindingIsStableAtUse(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  initializer: ts.Expression,
): boolean {
  // Direct eval/Function code can rebind a syntactically untouched local after
  // this pre-scan. Its storage/representation is outside this literal-only
  // slice, so retain the established explicit refusal for every identifier
  // admission in dynamic-code modules.
  if (ctx.dynamicCodeDirty) return false;
  const declaration = ctx.oracle.variableDeclarationOf(identifier);
  if (!declaration || declaration.initializer !== initializer) return false;
  const sourceFile = identifier.getSourceFile();
  // Do not let a future alias-aware oracle promote an imported literal without
  // also proving that its declaration storage is represented in this module.
  // The promotion pass only owns literals physically emitted by this source.
  if (declaration.getSourceFile() !== sourceFile || initializer.getSourceFile() !== sourceFile) return false;
  let changed = false;
  const isThisBindingWrite = (write: ts.Identifier): boolean => {
    if (ctx.oracle.variableDeclarationOf(write) !== declaration) return false;
    return write.getSourceFile() === sourceFile;
  };
  const record = (write: ts.Identifier): void => {
    if (isThisBindingWrite(write)) changed = true;
  };
  const visit = (node: ts.Node): void => {
    if (changed) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      forEachWriteTarget(node.left, record);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      forEachWriteTarget(node.operand, record);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const item of node.initializer.declarations) forEachWriteTarget(item.name, record);
      } else {
        forEachWriteTarget(node.initializer, record);
      }
    } else if (ts.isVariableDeclaration(node) && node !== declaration && node.initializer) {
      forEachWriteTarget(node.name, record);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return !changed;
}

function objectLiteralForExpression(
  ctx: CodegenContext,
  argument: ts.Expression | undefined,
): ts.ObjectLiteralExpression | undefined {
  if (!argument) return undefined;
  const value = sourceValue(argument);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (!ts.isIdentifier(value)) return undefined;
  const initializer = ctx.oracle.variableInitializerOf(value);
  if (!initializer || !literalBindingIsStableAtUse(ctx, value, initializer)) return undefined;
  const unwrappedInitializer = unwrap(initializer);
  return ts.isObjectLiteralExpression(unwrappedInitializer) ? unwrappedInitializer : undefined;
}

function isDefinitelyPrimitiveFact(fact: TypeFact): boolean {
  if (fact.kind === "union") return fact.parts.every(isDefinitelyPrimitiveFact);
  return (
    fact.kind === "string" ||
    fact.kind === "number" ||
    fact.kind === "boolean" ||
    fact.kind === "bigint" ||
    fact.kind === "symbol" ||
    fact.kind === "null" ||
    fact.kind === "undefined" ||
    fact.kind === "void"
  );
}

/**
 * A colon-form `__proto__` member can seed a non-ordinary prototype before
 * this call. The narrow `$Object` decision path intentionally does not model
 * Proxy/exotic [[Set]] traps, so retain the established refusal rather than
 * claiming a target whose prototype is not source-proven ordinary.
 */
function hasProtoInitializer(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) ||
        ts.isStringLiteral(property.name) ||
        ts.isNoSubstitutionTemplateLiteral(property.name)) &&
      property.name.text === "__proto__",
  );
}

/** A source-proven ordinary literal target accepted by the native Reflect.set path. */
function standaloneReflectSetTargetLiteral(
  ctx: CodegenContext,
  target: ts.Expression | undefined,
): ts.ObjectLiteralExpression | undefined {
  // A lexical literal proof cannot survive dynamic Object Environment Record
  // lookup. Preserve the #5196-owned with/Proxy refusal rather than promoting
  // storage for a syntactically outer identifier that resolves differently.
  if (!ctx.standalone || ctx.dynamicCodeDirty || !target || isInsideWithStatementBody(target)) return undefined;
  // `objectLiteralForExpression` is the source proof: either the argument is
  // an ordinary literal itself or `variableInitializerOf` resolves its binding
  // to that literal. No raw checker classification is needed (or permitted),
  // and every non-literal producer remains on the loud refusal path.
  const literal = objectLiteralForExpression(ctx, target);
  // A literal recorded by the dynamic-prototype pre-scan may have its target
  // chain changed at runtime (including to a Proxy whose set trap native
  // `$Object` lookup would bypass). `__proto__` object-literal syntax can seed
  // the same exotic chain without that mutation marker. Neither is owned by
  // this ordinary-object slice; implicit Object.prototype remains admissible.
  if (!literal || ctx.dynamicProtoLiteralNodes.has(literal) || hasProtoInitializer(literal)) return undefined;
  return literal;
}

/**
 * Return the exact literals that must use the native `$Object` carrier for an
 * admitted explicit-receiver Reflect.set call, or undefined for every exotic
 * / dynamic shape that must retain the fail-loud boundary.
 */
export function standaloneReflectSetReceiverAdmission(
  ctx: CodegenContext,
  target: ts.Expression | undefined,
  receiver: ts.Expression | undefined,
): { target: ts.ObjectLiteralExpression; receiver?: ts.ObjectLiteralExpression } | undefined {
  if (!ctx.standalone || ctx.dynamicCodeDirty || !target || !receiver) return undefined;
  const targetLiteral = standaloneReflectSetTargetLiteral(ctx, target);
  if (!targetLiteral) return undefined;

  const receiverLiteral = objectLiteralForExpression(ctx, receiver);
  if (receiverLiteral) return { target: targetLiteral, receiver: receiverLiteral };
  const receiverValue = sourceValue(receiver);
  if (ts.isIdentifier(receiverValue)) {
    const initializer = ctx.oracle.variableInitializerOf(receiverValue);
    if (!initializer || !literalBindingIsStableAtUse(ctx, receiverValue, initializer)) return undefined;
  }
  return isDefinitelyPrimitiveFact(ctx.oracle.typeFactOf(receiverValue)) ? { target: targetLiteral } : undefined;
}

/**
 * Run before declaration collection, so every source-proven ordinary target
 * (and an admitted explicit receiver) is allocated as native `$Object` in
 * lockstep with the #2046 runtime helper. The three-argument marking is
 * necessary for rows that exercise ordinary `Reflect.set` before their new
 * explicit-receiver assertion; otherwise the old closed-struct target would
 * turn a former compile error into a runtime false result.
 */
export function scanForStandaloneReflectSetReceiver(ctx: CodegenContext, root: ts.Node): void {
  // Run after scanForArrayHoles has set dynamicCodeDirty. Eval/Function can
  // mutate otherwise stable bindings and must not trigger representation
  // promotion before the call-site admission later retains its loud refusal.
  if (!ctx.standalone || ctx.dynamicCodeDirty) return;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isGlobalReflectIdentifier(ctx, node.expression.expression) &&
      node.expression.name.text === "set" &&
      node.arguments.length >= 3
    ) {
      const target = standaloneReflectSetTargetLiteral(ctx, node.arguments[0]);
      if (target) ctx.reflectSetReceiverLiteralNodes.add(target);
      if (node.arguments.length >= 4) {
        const admission = standaloneReflectSetReceiverAdmission(ctx, node.arguments[0], node.arguments[3]);
        if (admission?.receiver) ctx.reflectSetReceiverLiteralNodes.add(admission.receiver);
      }
    }
    forEachChild(node, visit);
  };
  visit(root);
}

/** Shared carrier predicate for the existing proto and #2046 promotions. */
export function isOpenObjectLiteralPromotion(ctx: CodegenContext, literal: ts.ObjectLiteralExpression): boolean {
  return (
    ctx.dynamicProtoLiteralNodes.has(literal) || (ctx.standalone && ctx.reflectSetReceiverLiteralNodes.has(literal))
  );
}
