// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Frontend checker facts only. No physical vector registration or layout indices.
import { ts } from "../ts-api.js";
import { irTypeEquals, irVal, irVec, type IrType } from "./core/types.js";
import type { PreparedAsyncAwaitSite } from "./async-from-ast.js";
import { IrUnsupportedError } from "./outcomes.js";

export type NativeFamilyVectorType = Extract<IrType, { kind: "vec" }>;
export type NativeFamilyVectorNode = ts.ParameterDeclaration | ts.VariableDeclaration | ts.Expression;

function unsupported(detail: string): never {
  throw new IrUnsupportedError("type-resolution-unsupported", "build", `native async family: ${detail}`);
}

/** Resolve the actual compiler ambient binding, never a source spelling alone. */
export function nativeFamilyAmbientSymbol(checker: ts.TypeChecker, name: string, meaning: ts.SymbolFlags): ts.Symbol {
  const symbol = checker.resolveName(name, undefined, meaning, false);
  if (!symbol?.declarations?.length || !symbol.declarations.every((node) => node.getSourceFile().isDeclarationFile))
    unsupported(`${name} has no exact ambient declaration`);
  return symbol;
}

/** A Promise's fulfillment and its callable carrier are intentionally different contracts. */
export function nativeFamilyPromiseFulfillment(checker: ts.TypeChecker, type: ts.Type): IrType | null {
  const promise = nativeFamilyAmbientSymbol(checker, "Promise", ts.SymbolFlags.Type);
  if ((type.flags & ts.TypeFlags.Object) === 0 || type.getSymbol() !== promise)
    unsupported("expected the ambient Promise fulfillment contract");
  const arguments_ = checker.getTypeArguments(type as ts.TypeReference);
  if (arguments_.length !== 1) unsupported("Promise must have one fulfillment type");
  const value = arguments_[0]!;
  if ((value.flags & ts.TypeFlags.Void) !== 0) return null;
  return nativeFamilyLogicalType(checker, value);
}

/** Construct the canonical, layout-free dense-vector arm. */
export function nativeFamilyVector(element: IrType, nullable: boolean): NativeFamilyVectorType {
  const type = irVec(element, nullable);
  if (type.kind !== "vec") unsupported("canonical vector constructor did not return a vector");
  return type;
}

/** Admit only the family's numeric scalar and its two exact vector element contracts. */
export function nativeFamilyLogicalType(checker: ts.TypeChecker, type: ts.Type): IrType {
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return irVal({ kind: "f64" });
  if (
    !checker.isArrayType(type) ||
    type.getSymbol() !== nativeFamilyAmbientSymbol(checker, "Array", ts.SymbolFlags.Type)
  )
    unsupported("expected number, number[], or an ambient Promise<number>[]");
  const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (!element) unsupported("array has no numeric element contract");
  if ((element.flags & ts.TypeFlags.NumberLike) !== 0) return nativeFamilyVector(irVal({ kind: "f64" }), true);
  const fulfillment = nativeFamilyPromiseFulfillment(checker, element);
  if (!fulfillment || !irTypeEquals(fulfillment, irVal({ kind: "f64" })))
    unsupported("pending vector elements must fulfill with number");
  return nativeFamilyVector(irVal({ kind: "externref" }), true);
}

/** Per-function declaration contracts; no allocating public type resolver is involved. */
export function nativeFamilySignature(
  checker: ts.TypeChecker,
  owner: ts.FunctionDeclaration,
): {
  readonly params: readonly IrType[];
  readonly result: IrType | null;
} {
  const signature = checker.getSignatureFromDeclaration(owner);
  if (!signature || owner.asteriskToken || !owner.type) unsupported("function lacks a concrete declared signature");
  const params = owner.parameters.map((parameter) => {
    if (
      !ts.isIdentifier(parameter.name) ||
      !parameter.type ||
      parameter.dotDotDotToken ||
      parameter.questionToken ||
      parameter.initializer
    )
      unsupported("parameter requires one exact required binding and type");
    const declared = nativeFamilyLogicalType(checker, checker.getTypeFromTypeNode(parameter.type));
    const actual = nativeFamilyLogicalType(checker, checker.getTypeAtLocation(parameter.name));
    if (!irTypeEquals(declared, actual)) unsupported("parameter declaration and checker type disagree");
    return declared;
  });
  const declared = nativeFamilyPromiseFulfillment(checker, checker.getTypeFromTypeNode(owner.type));
  const actual = nativeFamilyPromiseFulfillment(checker, checker.getReturnTypeOfSignature(signature));
  if (declared === null ? actual !== null : actual === null || !irTypeEquals(declared, actual))
    unsupported("function annotation and checker fulfillment disagree");
  return { params, result: declared };
}

function vectorType(checker: ts.TypeChecker, node: ts.Node): NativeFamilyVectorType {
  const type = nativeFamilyLogicalType(checker, checker.getTypeAtLocation(node));
  if (type.kind !== "vec") unsupported("vector declaration has a non-vector checker type");
  return type;
}

function isBindingName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node)
  );
}

/**
 * Complete original-AST map for one owner. Declaration entries retain nullable
 * contracts; literals and reads of immutable literal bindings remain non-null.
 */
export function buildNativeFamilyLogicalVectors(
  checker: ts.TypeChecker,
  owner: ts.FunctionDeclaration,
  awaits: ReadonlyMap<ts.AwaitExpression, PreparedAsyncAwaitSite>,
): ReadonlyMap<NativeFamilyVectorNode, NativeFamilyVectorType> {
  if (!owner.body) unsupported("vector owner has no executable body");
  const result = new Map<NativeFamilyVectorNode, NativeFamilyVectorType>();
  const bindings = new Map<ts.Declaration, NativeFamilyVectorType>();
  for (const [node, site] of awaits) {
    let current: ts.Node | undefined = node;
    while (current && current !== owner && !ts.isFunctionLike(current)) current = current.parent;
    if (current !== owner) unsupported("await map contains a foreign executable owner");
    if (site.resultType.kind === "vec") result.set(node, site.resultType);
  }
  const initializer = (node: ts.Expression, declared: NativeFamilyVectorType): NativeFamilyVectorType => {
    let actual: NativeFamilyVectorType;
    if (ts.isParenthesizedExpression(node)) actual = initializer(node.expression, declared);
    else if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) {
        if (ts.isSpreadElement(item) || ts.isOmittedExpression(item))
          unsupported("vector literal cannot contain spread or holes");
        const checked = checker.getTypeAtLocation(item);
        if (declared.elementType.kind === "val" && declared.elementType.val.kind === "f64") {
          if ((checked.flags & ts.TypeFlags.NumberLike) === 0)
            unsupported("numeric vector literal has a foreign element");
        } else {
          const value = nativeFamilyPromiseFulfillment(checker, checked);
          if (!value || !irTypeEquals(value, irVal({ kind: "f64" })))
            unsupported("pending literal has a foreign Promise result");
        }
      }
      actual = nativeFamilyVector(declared.elementType, false);
    } else if (ts.isAwaitExpression(node)) {
      const site = awaits.get(node);
      if (!site || site.resultType.kind !== "vec") unsupported("vector await has no exact source plan");
      actual = site.resultType;
    } else unsupported("vector initializer is outside the certified literal/await boundary");
    if (!irTypeEquals(actual.elementType, declared.elementType))
      unsupported("vector initializer element contract changed");
    result.set(node, actual);
    return actual;
  };
  for (const parameter of owner.parameters) {
    if (!checker.isArrayType(checker.getTypeAtLocation(parameter.name))) continue;
    const type = vectorType(checker, parameter.name);
    result.set(parameter, type);
    bindings.set(parameter, type);
  }
  const declarations = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isTypeNode(node)) return;
    if (ts.isVariableDeclaration(node) && checker.isArrayType(checker.getTypeAtLocation(node.name))) {
      if (
        !ts.isIdentifier(node.name) ||
        !node.initializer ||
        !ts.isVariableDeclarationList(node.parent) ||
        (node.parent.flags & ts.NodeFlags.Const) === 0
      )
        unsupported("vector local must be an immutable initialized binding");
      const declared = vectorType(checker, node.name);
      if (node.type) {
        const annotation = nativeFamilyLogicalType(checker, checker.getTypeFromTypeNode(node.type));
        if (!irTypeEquals(declared, annotation)) unsupported("vector annotation disagrees with its binding");
      }
      result.set(node, declared);
      bindings.set(node, initializer(node.initializer, declared));
    }
    ts.forEachChild(node, declarations);
  };
  declarations(owner.body);
  const uses = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isTypeNode(node)) return;
    ts.forEachChild(node, uses);
    if (ts.isIdentifier(node) && !isBindingName(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      const type = declaration && bindings.get(declaration);
      if (type) result.set(node, type);
      else if (checker.isArrayType(checker.getTypeAtLocation(node)))
        unsupported("vector read is not bound to this function's declaration");
    }
    if (ts.isParenthesizedExpression(node)) {
      const type = result.get(node.expression);
      if (type) result.set(node, type);
    }
    if (ts.isArrayLiteralExpression(node) && !result.has(node)) initializer(node, vectorType(checker, node));
  };
  uses(owner.body);
  return result;
}
