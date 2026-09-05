// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Binding identity for statically synthesized Function-constructor bodies.
 * The body is parsed in a foreign source file, so the ordinary checker cannot
 * connect a self-reference such as `var f = Function("return f.caller")` to
 * the source binding that receives the resulting closure.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

const ownerNameByArguments = new WeakMap<object, string>();
const namesByContext = new WeakMap<CodegenContext, Map<string, ReadonlySet<string>>>();

/** Remember the stable source binding for a value-form Function call. */
export function noteStaticFunctionOwner(ctx: CodegenContext, ownerCall: ts.CallExpression): void {
  const name = stableOwnerName(ctx, ownerCall);
  if (name !== undefined) ownerNameByArguments.set(ownerCall.arguments, name);
}

/** Associate a synthesized function name with its source binding, if any. */
export function recordStaticFunctionSelfName(
  ctx: CodegenContext,
  fnName: string,
  args: readonly ts.Expression[],
): void {
  const name = ownerNameByArguments.get(args as object);
  if (name === undefined) return;
  let names = namesByContext.get(ctx);
  if (names === undefined) {
    names = new Map();
    namesByContext.set(ctx, names);
  }
  names.set(fnName, new Set([name]));
}

/** Query whether a synthetic function receiver is its own stable binding. */
export function isStaticFunctionSelfName(ctx: CodegenContext, fctx: FunctionContext, receiver: ts.Expression): boolean {
  return ts.isIdentifier(receiver) && namesByContext.get(ctx)?.get(fctx.name)?.has(receiver.text) === true;
}

function stableOwnerName(ctx: CodegenContext, ownerCall: ts.CallExpression): string | undefined {
  let parent: ts.Node | undefined = ownerCall.parent;
  while (
    parent !== undefined &&
    (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent))
  ) {
    parent = parent.parent;
  }
  if (
    !parent ||
    !ts.isVariableDeclaration(parent) ||
    !ts.isIdentifier(parent.name) ||
    parent.initializer !== ownerCall
  ) {
    return undefined;
  }
  const binding = parent.name;
  if (ctx.oracle.variableDeclarationOf(binding) !== parent) return undefined;

  const isAssignment = (node: ts.Identifier): boolean => {
    const p = node.parent;
    if (ts.isBinaryExpression(p) && p.left === node) {
      return (
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    }
    if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && p.operand === node) {
      return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
    }
    if ((ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === node) return true;
    return ts.isDeleteExpression(p) && p.expression === node;
  };
  let reassigned = false;
  const visit = (node: ts.Node): void => {
    if (reassigned) return;
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      ctx.oracle.valueDeclarationOf(node) === parent &&
      isAssignment(node)
    ) {
      reassigned = true;
      return;
    }
    node.forEachChild(visit);
  };
  ownerCall.getSourceFile().forEachChild(visit);
  return reassigned ? undefined : binding.text;
}
