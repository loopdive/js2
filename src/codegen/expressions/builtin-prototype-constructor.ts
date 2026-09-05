// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Resolve the small set of ES5 builtin constructors whose identity is exposed
// through `<Builtin>.prototype.constructor`. TypeScript types that property as
// the broad `Function` value, so the ordinary `new` dispatcher cannot use the
// checker signature to recover its constructability.

import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolvesToAmbientGlobal } from "./non-constructable.js";
import { NEW_GLOBAL_FALLTHROUGH, tryCompileBuiltinGlobalNew } from "./new-builtin-globals.js";

export type BuiltinPrototypeConstructorName = "String" | "Object" | "Error";

const BUILTIN_PROTOTYPE_CONSTRUCTORS = new Set<BuiltinPrototypeConstructorName>(["String", "Object", "Error"]);

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function prototypeConstructorName(
  ctx: CodegenContext,
  expr: ts.Expression,
): BuiltinPrototypeConstructorName | undefined {
  const candidate = unwrap(expr);
  if (!ts.isPropertyAccessExpression(candidate) || candidate.name.text !== "constructor") return undefined;
  const prototype = unwrap(candidate.expression);
  if (!ts.isPropertyAccessExpression(prototype) || prototype.name.text !== "prototype") return undefined;
  const builtin = unwrap(prototype.expression);
  if (
    !ts.isIdentifier(builtin) ||
    !BUILTIN_PROTOTYPE_CONSTRUCTORS.has(builtin.text as BuiltinPrototypeConstructorName) ||
    !resolvesToAmbientGlobal(ctx, builtin)
  ) {
    return undefined;
  }
  return builtin.text as BuiltinPrototypeConstructorName;
}

/** A writable prototype constructor must not be folded after a source write. */
function prototypeConstructorHasWrites(ctx: CodegenContext, source: ts.SourceFile, builtinName: string): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    const target =
      ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)
        ? node.left
        : ts.isDeleteExpression(node)
          ? node.expression
          : undefined;
    if (target !== undefined && prototypeConstructorName(ctx, target) === builtinName) {
      written = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return written;
}

/** A variable alias is safe only while its binding remains at the initializer. */
function bindingHasWrites(ctx: CodegenContext, declaration: ts.VariableDeclaration): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;

    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const target = unwrap(node.left as ts.Expression);
      if (ts.isIdentifier(target) && ctx.oracle.valueDeclarationOf(target) === declaration) {
        written = true;
        return;
      }
    }

    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const target = unwrap(node.operand as ts.Expression);
      if (ts.isIdentifier(target) && ctx.oracle.valueDeclarationOf(target) === declaration) {
        written = true;
        return;
      }
    }

    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      const target = unwrap(node.initializer as ts.Expression);
      if (ts.isIdentifier(target) && ctx.oracle.valueDeclarationOf(target) === declaration) {
        written = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(declaration.getSourceFile(), visit);
  return written;
}

function directPrototypeConstructor(
  ctx: CodegenContext,
  expr: ts.Expression,
): BuiltinPrototypeConstructorName | undefined {
  const candidate = unwrap(expr);
  const builtinName = prototypeConstructorName(ctx, candidate);
  return builtinName !== undefined && !prototypeConstructorHasWrites(ctx, candidate.getSourceFile(), builtinName)
    ? builtinName
    : undefined;
}

/**
 * Return the intrinsic name behind a direct prototype-constructor expression or
 * an immutable variable alias. Mutable aliases are deliberately declined: a
 * later assignment can replace the constructor with an arbitrary value.
 */
export function resolveBuiltinPrototypeConstructor(
  ctx: CodegenContext,
  expr: ts.Expression,
): BuiltinPrototypeConstructorName | undefined {
  const seen = new Set<ts.Declaration>();

  const visit = (candidate: ts.Expression): BuiltinPrototypeConstructorName | undefined => {
    const direct = directPrototypeConstructor(ctx, candidate);
    if (direct !== undefined) return direct;

    const unwrapped = unwrap(candidate);
    if (!ts.isIdentifier(unwrapped)) return undefined;

    const declaration = ctx.oracle.valueDeclarationOf(unwrapped);
    if (!declaration || seen.has(declaration)) return undefined;
    seen.add(declaration);
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined;
    if (bindingHasWrites(ctx, declaration)) return undefined;
    return visit(declaration.initializer);
  };

  return visit(expr);
}

/** Route an intrinsic prototype-constructor value through the matching `new` arm. */
export function tryCompileBuiltinPrototypeConstructorNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | null | typeof NEW_GLOBAL_FALLTHROUGH {
  const builtinName = resolveBuiltinPrototypeConstructor(ctx, expr.expression);
  if (builtinName === undefined) return NEW_GLOBAL_FALLTHROUGH;
  return tryCompileBuiltinGlobalNew(ctx, fctx, expr, builtinName);
}

/** Whether an expression is the ambient Error constructor itself or its alias. */
export function isBuiltinErrorConstructorExpression(ctx: CodegenContext, expr: ts.Expression): boolean {
  const candidate = unwrap(expr);
  if (ts.isIdentifier(candidate) && candidate.text === "Error" && resolvesToAmbientGlobal(ctx, candidate)) return true;
  return resolveBuiltinPrototypeConstructor(ctx, candidate) === "Error";
}
