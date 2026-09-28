// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { UnsafeTypeAssumption } from "./semantic-safety-types.js";

type Access = { root: ts.Identifier; keys: (string | number)[] };
type Mutation = { node: ts.Node; access: Access; value?: ts.Expression };

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression))
    expression = expression.expression;
  return expression;
}

function accessOf(expression: ts.Expression, checker: ts.TypeChecker): Access | undefined {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) return { root: expression, keys: [] };
  if (ts.isPropertyAccessExpression(expression)) {
    const receiver = accessOf(expression.expression, checker);
    if (receiver) return { root: receiver.root, keys: [...receiver.keys, expression.name.text] };
  }
  if (ts.isElementAccessExpression(expression)) {
    const receiver = accessOf(expression.expression, checker);
    const key = unwrap(expression.argumentExpression);
    if (receiver && ts.isStringLiteralLike(key)) return { root: receiver.root, keys: [...receiver.keys, key.text] };
    // A numeric index's precise value does not affect the array element type.
    if (receiver && ts.isNumericLiteral(key))
      return { root: receiver.root, keys: [...receiver.keys, Number(key.text)] };
    if (receiver && (checker.getTypeAtLocation(key).flags & ts.TypeFlags.NumberLike) !== 0) {
      return { root: receiver.root, keys: [...receiver.keys, 0] };
    }
  }
  return undefined;
}

function mutationOf(node: ts.Node, checker: ts.TypeChecker): Mutation | undefined {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const access = accessOf(node.left, checker);
    if (access?.keys.length) return { node, access, value: node.right };
  }
  if (ts.isDeleteExpression(node)) {
    const access = accessOf(node.expression, checker);
    if (access?.keys.length) return { node, access };
  }
  return undefined;
}

function visitOwnBody(node: ts.Node, visitor: (node: ts.Node) => void): void {
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    visitor(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
}

/** Visible mutations that invalidate the compiler's structural carrier assumptions. */
export function collectStructuralUnsoundness(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): UnsafeTypeAssumption[] {
  const results: UnsafeTypeAssumption[] = [];
  const reported = new Set<ts.Node>();
  const aliases = new Map<ts.Symbol, ts.Identifier>();
  const detached = new Map<ts.Symbol, number[]>();
  const calls: ts.CallExpression[] = [];
  const mutations: Mutation[] = [];
  const report = (node: ts.Node, id: string, message: string): void => {
    if (reported.has(node)) return;
    reported.add(node);
    results.push({ node, id, message });
  };
  const symbol = (id: ts.Identifier): ts.Symbol | undefined => checker.getSymbolAtLocation(id);
  const origin = (id: ts.Identifier, position: number): ts.Identifier => {
    const seen = new Set<ts.Symbol>();
    for (;;) {
      const binding = symbol(id);
      if (!binding || seen.has(binding) || detached.get(binding)?.some((end) => end < position)) return id;
      seen.add(binding);
      const next = aliases.get(binding);
      if (!next) return id;
      id = next;
    }
  };
  const typeAtPath = (type: ts.Type, keys: Access["keys"]): ts.Type | undefined => {
    for (const key of keys) {
      if (typeof key === "number") {
        const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
        if (!element) return undefined;
        type = element;
      } else {
        const property = checker.getPropertyOfType(type, key);
        if (!property) return undefined;
        type = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? sourceFile);
      }
    }
    return type;
  };
  const permitsUndefined = (type: ts.Type): boolean =>
    (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 ||
    (type.isUnion() && type.types.some(permitsUndefined));
  const incompatible = (mutation: Mutation, target: ts.Type): boolean =>
    mutation.value
      ? !checker.isTypeAssignableTo(checker.getTypeAtLocation(mutation.value), target)
      : !permitsUndefined(target);

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      const binding = symbol(node.name);
      if (binding && ts.isIdentifier(initializer)) aliases.set(binding, initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const binding = symbol(node.left);
      if (binding) detached.set(binding, [...(detached.get(binding) ?? []), node.end]);
    }
    const mutation = mutationOf(node, checker);
    if (mutation) mutations.push(mutation);
    if (ts.isCallExpression(node)) {
      calls.push(node);
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        const receiverType = checker.getTypeAtLocation(receiver);
        const access = accessOf(receiver, checker);
        if (
          access &&
          (checker.isArrayType(receiverType) || checker.isTupleType(receiverType)) &&
          ["push", "unshift", "splice"].includes(method)
        ) {
          for (const value of node.arguments.slice(method === "splice" ? 2 : 0)) {
            mutations.push({ node, access: { root: access.root, keys: [...access.keys, 0] }, value });
          }
        }
      }
    }
    if (
      ts.isSpreadAssignment(node) &&
      (checker.getTypeAtLocation(node.expression).flags & ts.TypeFlags.TypeParameter) !== 0
    ) {
      report(
        node,
        "JS2WASM_UNSUPPORTED_GENERIC_SPREAD",
        "Object spread from an unresolved generic type is not yet preserved by js2wasm; use a concrete object type before spreading.",
      );
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  for (const mutation of mutations) {
    const original = origin(mutation.access.root, mutation.node.pos);
    if (symbol(original) === symbol(mutation.access.root)) continue;
    const originalType = checker.getTypeAtLocation(original);
    const target = typeAtPath(originalType, mutation.access.keys);
    if (!target || !incompatible(mutation, target)) continue;
    const arrayMutation = mutation.access.keys.some((key) => typeof key === "number");
    report(
      mutation.node,
      arrayMutation ? "JS2WASM_UNSOUND_ARRAY_MUTATION" : "JS2WASM_UNSOUND_STRUCTURAL_ALIAS",
      arrayMutation
        ? "This mutation through a widened array alias is incompatible with the original element type; js2wasm cannot yet preserve this shared array mutation."
        : "This write or deletion through a widened object alias invalidates the original property type; js2wasm cannot yet preserve this shared property mutation.",
    );
  }

  for (const call of calls) {
    const signature = checker.getResolvedSignature(call);
    const declaration = signature?.declaration;
    if (
      !declaration ||
      !(
        ts.isFunctionDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration)
      ) ||
      !declaration.body
    )
      continue;
    // Only report a refinement failure when a later read actually retains the
    // pre-call type. An arbitrary callback call is not mutation evidence.
    let block: ts.Node = call;
    while (block.parent && !ts.isBlock(block) && !ts.isSourceFile(block)) block = block.parent;
    const laterReads: ts.PropertyAccessExpression[] = [];
    visitOwnBody(block, (node) => {
      if (node.pos > call.end && ts.isPropertyAccessExpression(node)) laterReads.push(node);
    });
    visitOwnBody(declaration.body, (node) => {
      const mutation = mutationOf(node, checker);
      if (!mutation) return;
      const parameterIndex = declaration.parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && symbol(parameter.name) === symbol(mutation.access.root),
      );
      if (parameterIndex < 0) return;
      const argument = call.arguments[parameterIndex];
      if (!argument) return;
      const actual = accessOf(argument, checker);
      if (!actual) return;
      for (const read of laterReads) {
        const readAccess = accessOf(read, checker);
        if (!readAccess || symbol(origin(readAccess.root, read.pos)) !== symbol(origin(actual.root, call.pos)))
          continue;
        const keys = [...actual.keys, ...mutation.access.keys];
        if (JSON.stringify(keys) !== JSON.stringify(readAccess.keys)) continue;
        const narrowed = checker.getTypeAtLocation(read);
        const declared = typeAtPath(checker.getTypeAtLocation(actual.root), keys);
        if (!declared || checker.isTypeAssignableTo(declared, narrowed) || !incompatible(mutation, narrowed)) continue;
        report(
          call,
          "JS2WASM_UNSOUND_REFINEMENT",
          "This call visibly changes or deletes a property whose earlier refinement is reused afterward; js2wasm cannot yet invalidate that stale refinement.",
        );
      }
    });
  }
  return results;
}
