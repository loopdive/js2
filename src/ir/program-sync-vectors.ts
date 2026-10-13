// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import { irTypeEquals, irVec } from "./core/types.js";
import {
  nativeFamilyAmbientSymbol,
  type NativeFamilyVectorNode,
  type NativeFamilyVectorType,
} from "./program-logical-types.js";
import type { IrDirectCallLoweringPlan } from "./ast-lowering-plans.js";
import { IrUnsupportedError } from "./outcomes.js";

function unsupported(detail: string): never {
  throw new IrUnsupportedError("type-resolution-unsupported", "build", `native synchronous vector: ${detail}`);
}

/** Genuine checker type, with no backend carrier or layout coordinates. */
function nativeSynchronousVectorType(checker: ts.TypeChecker, type: ts.Type): NativeFamilyVectorType | undefined {
  if (!checker.isArrayType(type)) return undefined;
  const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (
    type.getSymbol() !== nativeFamilyAmbientSymbol(checker, "Array", ts.SymbolFlags.Type) ||
    !element ||
    (element.flags & ts.TypeFlags.NumberLike) === 0
  )
    unsupported("requires the ambient numeric Array contract");
  return irVec({ kind: "val", val: { kind: "f64" } }, true) as NativeFamilyVectorType;
}

export function nativeSynchronousVectorParameter(
  checker: ts.TypeChecker,
  owner: ts.FunctionDeclaration,
  parameter: ts.ParameterDeclaration,
  enabled: boolean,
): NativeFamilyVectorType | undefined {
  return enabled && !owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ? nativeSynchronousVectorType(checker, checker.getTypeAtLocation(parameter.name))
    : undefined;
}

/** Checked callable return, retaining precise nullable contracts and annotation agreement. */
export function nativeSynchronousVectorResult(
  checker: ts.TypeChecker,
  owner: ts.FunctionDeclaration,
  enabled: boolean,
): NativeFamilyVectorType | undefined {
  if (!enabled || owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
  const signature = checker.getSignatureFromDeclaration(owner);
  if (!signature) unsupported("function has no actual checker signature");
  const actual = nativeSynchronousVectorType(checker, checker.getReturnTypeOfSignature(signature));
  if (!actual) return undefined;
  if (owner.type) {
    const annotation = nativeSynchronousVectorType(checker, checker.getTypeFromTypeNode(owner.type));
    if (!annotation || !irTypeEquals(actual, annotation))
      unsupported("return annotation and actual checker result disagree");
  }
  return actual;
}

/** Original owner map; direct calls use the already authenticated unit-bound plans. */
export function buildSynchronousLogicalVectors(
  checker: ts.TypeChecker,
  owner: ts.FunctionDeclaration,
  directCalls: ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan>,
): ReadonlyMap<NativeFamilyVectorNode, NativeFamilyVectorType> {
  if (!owner.body) unsupported("owner has no executable body");
  const facts = new Map<NativeFamilyVectorNode, NativeFamilyVectorType>();
  const bindings = new Map<ts.Declaration, NativeFamilyVectorType>();
  const vector = (node: ts.Node): NativeFamilyVectorType => {
    const type = nativeSynchronousVectorType(checker, checker.getTypeAtLocation(node));
    if (!type) unsupported("expected an exact numeric vector expression");
    return type;
  };
  const initializer = (node: ts.Expression, declared: NativeFamilyVectorType): NativeFamilyVectorType => {
    let actual: NativeFamilyVectorType;
    if (ts.isParenthesizedExpression(node)) actual = initializer(node.expression, declared);
    else if (ts.isArrayLiteralExpression(node)) {
      // Native vector length is a signed i32. This also bounds ++ induction before exit.
      if (node.elements.length > 2147483647) unsupported("literal exceeds native signed vector length");
      for (const item of node.elements)
        if (
          ts.isSpreadElement(item) ||
          ts.isOmittedExpression(item) ||
          (checker.getTypeAtLocation(item).flags & ts.TypeFlags.NumberLike) === 0
        )
          unsupported("literal contains a hole, spread or nonnumeric element");
      actual = { ...declared, nullable: false };
    } else if (ts.isCallExpression(node)) {
      const call = directCalls.get(node);
      const signature = checker.getResolvedSignature(node);
      const target = signature?.declaration;
      if (
        !call ||
        call.target.binding.kind !== "unit" ||
        !target ||
        !ts.isFunctionDeclaration(target) ||
        !target.body ||
        target.typeParameters?.length ||
        target.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
        call.signature.returnType?.kind !== "vec"
      )
        unsupported("vector call has no authenticated synchronous source-unit result");
      actual = call.signature.returnType;
      if (!irTypeEquals(actual, vector(node))) unsupported("callable and checker vector result disagree");
    } else if (ts.isConditionalExpression(node)) {
      const left = initializer(node.whenTrue, declared);
      const right = initializer(node.whenFalse, declared);
      if (!irTypeEquals(left.elementType, right.elementType)) unsupported("conditional element contracts disagree");
      actual = { ...declared, nullable: left.nullable || right.nullable };
    } else if (ts.isIdentifier(node)) {
      const binding = checker.getSymbolAtLocation(node)?.valueDeclaration;
      const type = binding && bindings.get(binding);
      if (!type) unsupported("alias has no owned parameter or immutable binding");
      actual = type;
    } else unsupported("initializer has no finite literal, alias or direct-call provenance");
    if (!irTypeEquals(actual.elementType, declared.elementType)) unsupported("initializer element contract changed");
    facts.set(node, actual);
    return actual;
  };
  for (const parameter of owner.parameters) {
    const type = nativeSynchronousVectorType(checker, checker.getTypeAtLocation(parameter.name));
    if (!type) continue;
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.dotDotDotToken ||
      parameter.questionToken ||
      parameter.initializer
    )
      unsupported("vector parameter must be one required identifier");
    facts.set(parameter, type);
    bindings.set(parameter, type);
  }
  const declarations = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isTypeNode(node)) return;
    if (ts.isVariableDeclaration(node)) {
      const declared = nativeSynchronousVectorType(checker, checker.getTypeAtLocation(node.name));
      if (declared) {
        if (
          !ts.isIdentifier(node.name) ||
          !node.initializer ||
          !ts.isVariableDeclarationList(node.parent) ||
          (node.parent.flags & ts.NodeFlags.Const) === 0
        )
          unsupported("local must be immutable and initialized");
        if (
          node.type &&
          !irTypeEquals(declared, nativeSynchronousVectorType(checker, checker.getTypeFromTypeNode(node.type))!)
        )
          unsupported("annotation disagrees with its actual binding");
        facts.set(node, declared);
        bindings.set(node, initializer(node.initializer, declared));
      }
    }
    ts.forEachChild(node, declarations);
  };
  declarations(owner.body);
  const uses = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isTypeNode(node)) return;
    ts.forEachChild(node, uses);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (
        (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyAccessExpression(parent)) &&
        parent.name === node
      )
        return;
      const binding = checker.getSymbolAtLocation(node)?.valueDeclaration;
      const type = binding && bindings.get(binding);
      if (type) facts.set(node, type);
      else if (checker.isArrayType(checker.getTypeAtLocation(node))) unsupported("read has no exact owner binding");
    }
    if (ts.isParenthesizedExpression(node)) {
      const type = facts.get(node.expression);
      if (type) facts.set(node, type);
    }
    if (
      (ts.isArrayLiteralExpression(node) || ts.isConditionalExpression(node)) &&
      checker.isArrayType(checker.getTypeAtLocation(node)) &&
      !facts.has(node)
    )
      initializer(node, vector(node));
    if (ts.isCallExpression(node) && checker.isArrayType(checker.getTypeAtLocation(node)) && !facts.has(node))
      initializer(node, vector(node));
  };
  uses(owner.body);
  return facts;
}
