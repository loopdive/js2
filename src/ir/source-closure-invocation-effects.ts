// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { SourceClosureInvocationPlan } from "./source-closure-invocation.js";
import { sourceClosureCallbackGraph } from "./source-closure-callbacks.js";

function fail(detail: string): never {
  throw new IrUnsupportedError("method-call-unsupported", "build", `native closure invocation: ${detail}`);
}

/** Actual own getter allocations used only for the source effect proof, not prototype capability. */
function sourceGetterEffects(checker: ts.TypeChecker, sources: readonly ts.SourceFile[]) {
  const objects = new Map<ts.VariableDeclaration, ReadonlyMap<string, ts.GetAccessorDeclaration>>();
  const literals = new Set<ts.ObjectLiteralExpression>();
  const getters = new Set<ts.GetAccessorDeclaration>();
  const reads = new Map<ts.PropertyAccessExpression, ts.GetAccessorDeclaration>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const &&
      ts.isVariableStatement(node.parent.parent) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const members = new Map<string, ts.GetAccessorDeclaration>();
      for (const property of node.initializer.properties) {
        if (
          !ts.isGetAccessorDeclaration(property) ||
          !ts.isIdentifier(property.name) ||
          !property.body ||
          property.parameters.length ||
          members.has(property.name.text)
        )
          return;
        members.set(property.name.text, property);
      }
      if (members.size) {
        objects.set(node, members);
        literals.add(node.initializer);
        for (const getter of members.values()) getters.add(getter);
      }
    }
    ts.forEachChild(node, collect);
  };
  sources.forEach(collect);
  const associate = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken && ts.isIdentifier(node.expression)) {
      const declaration = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
      const getter =
        declaration && ts.isVariableDeclaration(declaration)
          ? objects.get(declaration)?.get(node.name.text)
          : undefined;
      if (getter) reads.set(node, getter);
    }
    ts.forEachChild(node, associate);
  };
  sources.forEach(associate);
  return { objects, literals, getters, reads };
}

function primitiveBodyReturn(body: ts.ConciseBody, primitive: (node: ts.Expression) => boolean): boolean {
  if (!ts.isBlock(body)) return primitive(body);
  const returns: ts.Expression[] = [];
  let bare = false;
  const collect = (part: ts.Node): void => {
    if (part !== body && ts.isFunctionLike(part)) return;
    if (ts.isReturnStatement(part)) {
      if (part.expression) returns.push(part.expression);
      else bare = true;
    }
    ts.forEachChild(part, collect);
  };
  collect(body);
  return !bare && returns.length > 0 && returns.every(primitive);
}

/**
 * A fresh function literal has the primordial member in the isolated program's
 * initial realm. Only an exhaustive, closed source-effect proof preserves that
 * fact until each member read. Declaration-file names and checker type assertions
 * do not grant runtime authority here.
 */
export function assertSourceClosureInvocationEffects(
  checker: ts.TypeChecker,
  sources: readonly ts.SourceFile[],
  plans: ReadonlyMap<ts.CallExpression, SourceClosureInvocationPlan>,
): void {
  const callbacks = sourceClosureCallbackGraph(checker, sources, plans);
  const getterEffects = sourceGetterEffects(checker, sources);
  const selected = callbacks.protectedFunctions;
  const members = new Set([...plans.keys()].map((call) => call.expression));
  const arrays = new Set(
    [...plans.values()].flatMap((plan) => (plan.method === "apply" ? [plan.expression.arguments[1]!] : [])),
  );
  const active = new Set<ts.Node>();
  const undefinedName = (node: ts.Identifier): boolean => {
    const symbol = checker.getSymbolAtLocation(node);
    return node.text === "undefined" && !!symbol && !symbol.valueDeclaration && !symbol.declarations?.length;
  };
  const primitive = (node: ts.Expression): boolean => {
    if (active.has(node)) return false;
    active.add(node);
    try {
      return primitiveValue(node);
    } finally {
      active.delete(node);
    }
  };
  const primitiveValue = (node: ts.Expression): boolean => {
    if (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)
    )
      return true;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return primitive(node.expression);
    if (ts.isVoidExpression(node) || ts.isTypeOfExpression(node)) return true;
    if (ts.isPrefixUnaryExpression(node))
      return node.operator === ts.SyntaxKind.ExclamationToken || primitive(node.operand);
    if (ts.isConditionalExpression(node)) return primitive(node.whenTrue) && primitive(node.whenFalse);
    if (ts.isBinaryExpression(node)) {
      if (
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
          node.operatorToken.kind,
        )
      )
        return true;
      return primitive(node.left) && primitive(node.right);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const getter = getterEffects.reads.get(node);
      return !!getter?.body && primitiveBodyReturn(getter.body, primitive);
    }
    if (ts.isCallExpression(node)) {
      const plan = plans.get(node);
      const targets = plan ? [plan.declaration] : callbacks.calls.get(node);
      if (!targets?.length) return false;
      return targets.every((target) => {
        const fn = target.initializer;
        if (!fn || !(ts.isFunctionExpression(fn) || ts.isArrowFunction(fn))) return false;
        return primitiveBodyReturn(fn.body, primitive);
      });
    }
    if (!ts.isIdentifier(node)) return false;
    if (undefinedName(node)) return true;
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    )
      return primitive(declaration.initializer);
    if (!declaration || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return false;
    const fn = declaration.parent;
    if (
      !(ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) ||
      !ts.isVariableDeclaration(fn.parent) ||
      !selected.has(fn.parent)
    )
      return false;
    const index = fn.parameters.indexOf(declaration);
    const calls = callbacks.incoming.get(fn.parent) ?? [];
    return (
      calls.length > 0 &&
      calls.every((args) => !args[index] || primitive(args[index]!)) &&
      (!declaration.initializer || primitive(declaration.initializer))
    );
  };
  const visit = (node: ts.Node): void => {
    // Types have no execution. In particular, assertions cannot prove a value's
    // primitive nature: primitive() unwraps them and checks the actual producer.
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && members.has(node.parent)) return;
      if (
        (ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node &&
          getterEffects.reads.has(node.parent)) ||
        (ts.isGetAccessorDeclaration(node.parent) &&
          node.parent.name === node &&
          getterEffects.getters.has(node.parent))
      )
        return;
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (!declaration && !undefinedName(node)) {
        // Property/declaration names are syntax; other unknown reads can be
        // host global accessors, even without a CallExpression in the source.
        if (!(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
          fail("unproven identifier read can execute an external accessor");
      }
      if (
        declaration &&
        selected.has(declaration as ts.VariableDeclaration) &&
        node !== (declaration as ts.VariableDeclaration).name
      ) {
        const access = node.parent;
        if (
          !callbacks.arguments.has(node) &&
          (!ts.isPropertyAccessExpression(access) || access.expression !== node || !members.has(access))
        )
          fail("selected closure escapes or is mutated outside its certified invocation sites");
      }
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        getterEffects.objects.has(declaration) &&
        node !== declaration.name
      ) {
        const access = node.parent;
        if (!ts.isPropertyAccessExpression(access) || access.expression !== node || !getterEffects.reads.has(access))
          fail("getter receiver escapes or is mutated outside its actual own getter reads");
      }
      if (
        declaration &&
        ts.isParameter(declaration) &&
        callbacks.parameters.has(declaration) &&
        node !== declaration.name
      ) {
        const call = node.parent;
        if (!ts.isCallExpression(call) || call.expression !== node || !callbacks.calls.has(call))
          fail("callback parameter escapes its actual allocation/call association");
      }
      if (declaration && declaration.getSourceFile().isDeclarationFile && !undefinedName(node))
        fail("ambient value read lacks an owned execution contract");
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const inert = [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.CommaToken,
      ].includes(op);
      if (
        !inert &&
        ((op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) ||
          op === ts.SyntaxKind.InKeyword ||
          op === ts.SyntaxKind.InstanceOfKeyword ||
          !primitive(node.left) ||
          !primitive(node.right))
      )
        fail("unproven binary coercion or write can replace call/apply");
      visit(node.left);
      visit(node.right);
      return;
    }
    if (ts.isPrefixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken ||
        (node.operator !== ts.SyntaxKind.ExclamationToken && !primitive(node.operand))
      )
        fail("unproven numeric unary coercion or update can replace call/apply");
      visit(node.operand);
      return;
    }
    if (ts.isCallExpression(node) && !plans.has(node) && !callbacks.calls.has(node)) {
      const declaration = ts.isIdentifier(node.expression)
        ? checker.getSymbolAtLocation(node.expression)?.valueDeclaration
        : undefined;
      if (
        !declaration ||
        !ts.isFunctionDeclaration(declaration) ||
        !declaration.body ||
        !sources.includes(declaration.getSourceFile())
      )
        fail("unknown call can replace call/apply");
    }
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      node.declarationList.declarations.some(
        (declaration) => selected.has(declaration) || getterEffects.objects.has(declaration),
      )
    )
      fail("selected closure export escapes the isolated source effect proof");
    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name))
      fail("binding patterns can execute getters or iteration");
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.Const))
      fail("mutable bindings need a complete effect proof");
    if (ts.isParameter(node) && (!ts.isIdentifier(node.name) || node.dotDotDotToken))
      fail("parameter binding/iteration lacks its effect proof");
    if (
      ts.isFunctionLike(node) &&
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      fail("suspension can expose the primordial member to external mutation");
    const allowed =
      ts.isSourceFile(node) ||
      ts.isBlock(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isParameter(node) ||
      ts.isVariableStatement(node) ||
      ts.isVariableDeclarationList(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isReturnStatement(node) ||
      ts.isIfStatement(node) ||
      ts.isEmptyStatement(node) ||
      ts.isExpressionStatement(node) ||
      ts.isCallExpression(node) ||
      (ts.isPropertyAccessExpression(node) && (members.has(node) || getterEffects.reads.has(node))) ||
      (ts.isObjectLiteralExpression(node) && getterEffects.literals.has(node)) ||
      (ts.isGetAccessorDeclaration(node) && getterEffects.getters.has(node)) ||
      (ts.isArrayLiteralExpression(node) && arrays.has(node)) ||
      ts.isConditionalExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isVoidExpression(node) ||
      ts.isTypeOfExpression(node) ||
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      [
        ts.SyntaxKind.TrueKeyword,
        ts.SyntaxKind.FalseKeyword,
        ts.SyntaxKind.NullKeyword,
        ts.SyntaxKind.ExportKeyword,
        ts.SyntaxKind.DefaultKeyword,
        ts.SyntaxKind.EqualsGreaterThanToken,
        ts.SyntaxKind.EndOfFileToken,
      ].includes(node.kind);
    if (!allowed) fail(`syntax ${ts.SyntaxKind[node.kind]} has no closed primordial-effect proof`);
    ts.forEachChild(node, visit);
  };
  sources.forEach(visit);
}
