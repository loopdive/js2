// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrType, IrClosureSignature } from "./core/types.js";
import { preparedIrDataMismatch } from "./program/data.js";
type SourceClosure =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;
/** Checker-owned logical signatures; nativeDynamic permits opaque values, never a physical provider. */
export function createSourceCallableSignatures(
  checker: ts.TypeChecker,
  unsupported: (detail: string) => never,
  nativeDynamic: boolean,
) {
  /** Shared logical callable conversion; this does not issue a physical carrier. */
  function checkerCallableType(input: ts.Type, where: string): IrType | null {
    const active = new Set<ts.Type>();
    const convert = (type: ts.Type): IrType | null => {
      if (nativeDynamic && type === checker.getAnyType()) return { kind: "dynamic" };
      if ((type.flags & ts.TypeFlags.Void) !== 0) return null;
      if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return { kind: "val", val: { kind: "f64" } };
      if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { kind: "val", val: { kind: "i32", boolean: true } };
      if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { kind: "string" };
      if (active.has(type)) unsupported(`callable annotation in ${where} has a recursive anonymous contract`);
      const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
      if (signatures.length !== 1 || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length)
        unsupported(`callable annotation in ${where} requires one non-constructing call signature`);
      const signature = signatures[0]!;
      if (signature.typeParameters?.length || signature.thisParameter)
        unsupported(`callable annotation in ${where} has unsupported generic/this parameters`);
      active.add(type);
      try {
        const params = signature.parameters.map((symbol) => {
          const declaration = symbol.valueDeclaration;
          if (
            !declaration ||
            !ts.isParameter(declaration) ||
            !declaration.type ||
            declaration.dotDotDotToken ||
            declaration.questionToken ||
            declaration.initializer ||
            (symbol.flags & ts.SymbolFlags.Optional) !== 0
          )
            unsupported(`callable annotation in ${where} requires exact required parameter declarations`);
          const value = convert(checker.getTypeOfSymbolAtLocation(symbol, declaration));
          if (!value) unsupported(`callable annotation in ${where} cannot use a void parameter`);
          return value;
        });
        return {
          kind: "callable",
          signature: { params, returnType: convert(checker.getReturnTypeOfSignature(signature)) },
        };
      } finally {
        active.delete(type);
      }
    };
    return convert(input);
  }

  /** Checker-certified callable annotations; no physical carrier or provider is inferred. */
  function checkerCallable(node: ts.TypeNode, where: string): IrType | undefined {
    const declared = checker.getTypeFromTypeNode(node);
    if (!checker.getSignaturesOfType(declared, ts.SignatureKind.Call).length) return undefined;
    const result = checkerCallableType(declared, where);
    const observed = checkerCallableType(checker.getTypeAtLocation(node), where);
    if (!result || preparedIrDataMismatch(result, observed) !== undefined)
      unsupported(`callable annotation in ${where} disagrees with its checker contract`);
    return result;
  }

  /** Preserve a real inferred callable return instead of the scalar lattice's null fallback. */
  function checkerInferredCallableResult(declaration: ts.FunctionDeclaration, where: string): IrType | undefined {
    if (
      declaration.type ||
      !declaration.body ||
      declaration.asteriskToken ||
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      return undefined;
    const signature = checker.getSignatureFromDeclaration(declaration);
    if (!signature) return undefined;
    const type = checker.getReturnTypeOfSignature(signature);
    const parts = type.isUnionOrIntersection() ? type.types : [type];
    if (!parts.some((part) => checker.getSignaturesOfType(part, ts.SignatureKind.Call).length)) return undefined;
    if (type.isUnionOrIntersection()) unsupported(`inferred callable result in ${where} has an ambiguous contract`);
    const result = checkerCallableType(type, where);
    if (result?.kind !== "callable") unsupported(`inferred callable result in ${where} lost its checker contract`);
    return result;
  }

  function closure(node: SourceClosure, where: string): IrClosureSignature | undefined {
    if (
      !nativeDynamic ||
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
      ("asteriskToken" in node && node.asteriskToken) ||
      !(
        node.type?.kind === ts.SyntaxKind.AnyKeyword ||
        node.parameters.some(
          (p) =>
            p.type &&
            (p.type.kind === ts.SyntaxKind.AnyKeyword ||
              checker.getSignaturesOfType(checker.getTypeFromTypeNode(p.type), ts.SignatureKind.Call).length > 0),
        )
      )
    )
      return undefined;
    const type = checkerCallableType(checker.getTypeAtLocation(node), where);
    return type?.kind === "callable" ? type.signature : undefined;
  }
  function runtimeParameter(node: ts.Expression, closedParameters: ReadonlySet<ts.TypeNode | undefined>): boolean {
    if (!nativeDynamic) return false;
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    return !!declaration && ts.isParameter(declaration) && !closedParameters.has(declaration.type);
  }
  return { callable: checkerCallable, inferredResult: checkerInferredCallableResult, closure, runtimeParameter };
}
