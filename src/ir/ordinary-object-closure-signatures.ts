// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrClosureSignature, IrType } from "./core/nodes.js";

export type OrdinaryObjectClosureDeclaration =
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;
export type OrdinaryObjectClosureSignatureResult =
  | { readonly kind: "supported"; readonly signature: IrClosureSignature }
  | { readonly kind: "unsupported"; readonly detail: string };

/** Checker-derived signatures only; no provider or runtime representation authority. */
export function resolveOrdinaryObjectClosureSignature(
  checker: ts.TypeChecker,
  declaration: OrdinaryObjectClosureDeclaration,
): OrdinaryObjectClosureSignatureResult {
  const active = new Set<ts.Type>();
  const refuse = (detail: string): never => {
    throw new UnsupportedSignature(detail);
  };
  const value = (type: ts.Type): IrType => {
    if (active.has(type)) refuse("recursive callable signature");
    const parts = type.isUnion() ? type.types : [type];
    if (parts.every((part) => !!(part.flags & ts.TypeFlags.NumberLike))) return { kind: "val", val: { kind: "f64" } };
    if (parts.every((part) => !!(part.flags & ts.TypeFlags.BooleanLike)))
      return { kind: "val", val: { kind: "i32", boolean: true } };
    if (parts.every((part) => !!(part.flags & ts.TypeFlags.StringLike))) return { kind: "string" };
    if (
      type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Union |
        ts.TypeFlags.Intersection |
        ts.TypeFlags.TypeParameter)
    )
      refuse("ambiguous or unsupported value type");
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    if (calls.length !== 1 || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length)
      refuse("value requires one non-constructible callable signature or a supported primitive");
    active.add(type);
    try {
      return { kind: "callable", signature: resolve(calls[0]!) };
    } finally {
      active.delete(type);
    }
  };
  const resolve = (signature: ts.Signature): IrClosureSignature => {
    const node = signature.getDeclaration();
    if (!node || signature.typeParameters?.length || node.typeParameters?.length || signature.thisParameter)
      refuse("generic, explicit-this or missing signature declaration");
    if (
      node.parameters.some(
        (parameter) =>
          parameter.questionToken ||
          parameter.dotDotDotToken ||
          parameter.initializer ||
          !ts.isIdentifier(parameter.name),
      )
    )
      refuse("optional, default, rest or destructured parameters require their own contract");
    const params = signature.getParameters();
    if (params.length !== node.parameters.length) refuse("checker parameter population differs from declaration");
    const result = checker.getReturnTypeOfSignature(signature);
    return {
      params: params.map((parameter, index) =>
        value(checker.getTypeOfSymbolAtLocation(parameter, node.parameters[index]!)),
      ),
      returnType: result.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never) ? null : value(result),
    };
  };
  try {
    if (
      !(
        ts.isGetAccessorDeclaration(declaration) ||
        ts.isSetAccessorDeclaration(declaration) ||
        ts.isMethodDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration)
      ) ||
      !declaration.body
    )
      refuse("requires a genuine closure/accessor body");
    if (
      ("asteriskToken" in declaration && declaration.asteriskToken) ||
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      refuse("async/generator completion requires its own contract");
    const signature = checker.getSignatureFromDeclaration(declaration);
    if (!signature) throw new UnsupportedSignature("checker supplied no declaration signature");
    if (ts.isMethodDeclaration(declaration)) {
      const symbol = checker.getSymbolAtLocation(declaration.name);
      if (
        !symbol ||
        checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, declaration), ts.SignatureKind.Call)
          .length !== 1
      )
        refuse("overloaded or ambiguous method declaration");
    }
    return { kind: "supported", signature: resolve(signature) };
  } catch (error) {
    if (error instanceof UnsupportedSignature) return { kind: "unsupported", detail: error.message };
    throw error;
  }
}
class UnsupportedSignature extends Error {}
