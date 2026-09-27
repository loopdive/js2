// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { getFuncSignature } from "./closures/funcref-wrapper-types.js";
import { fixedSourceFunctionCallHandle } from "./source-function-call.js";

/** A structural collection returned by source code need not have native slots. */
export function sourceCollectionFactoryUsesObjectCarrier(ctx: CodegenContext, expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const receiver = ctx.oracle.builtinReceiverOf(expression);
  if (receiver !== "Set" && receiver !== "Map" && receiver !== "WeakMap" && receiver !== "WeakSet") return false;
  if (ts.isPropertyAccessExpression(expression.expression)) {
    const object = expression.expression.expression;
    if (ts.isIdentifier(object) && ctx.externrefAccessorVars.has(object.text)) return true;
  }
  const callee = ts.isPropertyAccessExpression(expression.expression)
    ? expression.expression.name
    : expression.expression;
  if (!ts.isIdentifier(callee)) return false;
  const handle = fixedSourceFunctionCallHandle(ctx, callee);
  if (handle === undefined) return false;
  const signature = getFuncSignature(ctx, handle);
  return signature?.results.length === 1 && signature.results[0]?.kind === "externref";
}

/** A source collection's generic callback boundary transports T as a JS value. */
export function sourceCollectionCallbackParameterIsErased(
  ctx: CodegenContext,
  callback: ts.FunctionLikeDeclaration,
  index: number,
): boolean {
  const call = callback.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  const receiver = call.expression.expression;
  if (!ts.isIdentifier(receiver)) return false;
  const binding = ctx.oracle.valueDeclarationOf(receiver);
  if (
    !binding ||
    !ts.isVariableDeclaration(binding) ||
    !binding.initializer ||
    !sourceCollectionFactoryUsesObjectCarrier(ctx, binding.initializer)
  )
    return false;
  if (!ts.isCallExpression(binding.initializer)) return false;
  const callee = binding.initializer.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let factory = ctx.oracle.aliasedValueDeclarationOf(name);
  if (factory && ts.isShorthandPropertyAssignment(factory))
    factory = ctx.oracle.aliasedValueDeclarationOf(factory.name);
  if (!factory || !ts.isFunctionDeclaration(factory) || !factory.body) return false;
  const argumentIndex = call.arguments.indexOf(callback as ts.Expression);
  if (argumentIndex < 0) return false;
  const methodName = call.expression.name.text;
  const answers: boolean[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === methodName) {
      const type = node.parameters[argumentIndex]?.type;
      const parameterType = type && ts.isFunctionTypeNode(type) ? type.parameters[index]?.type : undefined;
      answers.push(
        !!parameterType &&
          ts.isTypeReferenceNode(parameterType) &&
          ctx.oracle
            .declarationsOf(parameterType.typeName)
            .some((decl) => ts.isTypeParameterDeclaration(decl) && decl.parent === factory),
      );
    }
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(factory.body);
  return answers.length > 0 && answers.every(Boolean);
}
