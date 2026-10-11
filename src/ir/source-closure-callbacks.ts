// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { SourceClosureInvocationPlan } from "./source-closure-invocation.js";

export interface SourceClosureCallbackArgument {
  readonly index: number;
  readonly parameter: ts.ParameterDeclaration;
  readonly argument: ts.Identifier;
  readonly declaration: ts.VariableDeclaration;
}

function fail(detail: string): never {
  throw new IrUnsupportedError("method-call-unsupported", "build", `native closure invocation: ${detail}`);
}

/** Resolve the actual immutable allocation, never the asserted callable type. */
export function sourceClosureLiteralBinding(
  checker: ts.TypeChecker,
  node: ts.Identifier,
): ts.VariableDeclaration | undefined {
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const) ||
    !(ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
  )
    return undefined;
  return declaration;
}

/** Every admitted higher-order operand has its own current declaration and parameter coordinate. */
export function sourceClosureCallbackArguments(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
  arguments_: readonly ts.Expression[],
): readonly SourceClosureCallbackArgument[] {
  const literal = declaration.initializer;
  if (!literal || !(ts.isFunctionExpression(literal) || ts.isArrowFunction(literal)))
    fail("callback owner is not its actual function literal");
  const result: SourceClosureCallbackArgument[] = [];
  for (const [index, parameter] of literal.parameters.entries()) {
    if (!parameter.type || !ts.isFunctionTypeNode(parameter.type)) continue;
    const argument = arguments_[index];
    const target = argument && ts.isIdentifier(argument) ? sourceClosureLiteralBinding(checker, argument) : undefined;
    if (!argument || !ts.isIdentifier(argument) || !target)
      fail("callback argument needs its actual immutable local closure allocation");
    result.push({ index, parameter, argument, declaration: target });
  }
  return result;
}

export interface SourceClosureCallbackGraph {
  readonly protectedFunctions: ReadonlySet<ts.VariableDeclaration>;
  readonly parameters: ReadonlySet<ts.ParameterDeclaration>;
  readonly arguments: ReadonlySet<ts.Identifier>;
  readonly calls: ReadonlyMap<ts.CallExpression, readonly ts.VariableDeclaration[]>;
  readonly incoming: ReadonlyMap<ts.VariableDeclaration, readonly (readonly ts.Expression[])[]>;
}

/**
 * Closed parameter-call edges come from all actual selected invocation sites.
 * The effect proof must still visit every target body and reject other escapes.
 */
export function sourceClosureCallbackGraph(
  checker: ts.TypeChecker,
  sources: readonly ts.SourceFile[],
  plans: ReadonlyMap<ts.CallExpression, SourceClosureInvocationPlan>,
): SourceClosureCallbackGraph {
  const protectedFunctions = new Set<ts.VariableDeclaration>();
  const targets = new Map<ts.ParameterDeclaration, Set<ts.VariableDeclaration>>();
  const arguments_ = new Set<ts.Identifier>();
  const calls = new Map<ts.CallExpression, readonly ts.VariableDeclaration[]>();
  const incoming = new Map<ts.VariableDeclaration, (readonly ts.Expression[])[]>();
  const addIncoming = (declaration: ts.VariableDeclaration, args: readonly ts.Expression[]): void => {
    const list = incoming.get(declaration) ?? [];
    list.push(args);
    incoming.set(declaration, list);
  };
  for (const plan of plans.values()) {
    protectedFunctions.add(plan.declaration);
    addIncoming(plan.declaration, plan.arguments);
    for (const callback of plan.callbacks) {
      const row = targets.get(callback.parameter) ?? new Set<ts.VariableDeclaration>();
      row.add(callback.declaration);
      targets.set(callback.parameter, row);
      protectedFunctions.add(callback.declaration);
      arguments_.add(callback.argument);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
      const actual = declaration && ts.isParameter(declaration) ? targets.get(declaration) : undefined;
      if (actual) {
        if (node.questionDotToken || node.arguments.some(ts.isSpreadElement))
          fail("optional/spread callback invocation needs its actual argument proof");
        calls.set(node, [...actual]);
        for (const target of actual) addIncoming(target, node.arguments);
      }
    }
    ts.forEachChild(node, visit);
  };
  sources.forEach(visit);
  return { protectedFunctions, parameters: new Set(targets.keys()), arguments: arguments_, calls, incoming };
}
