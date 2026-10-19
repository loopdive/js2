// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "./typescript.js";
import { irTypeEquals, irVal, type IrType } from "../ir/core/types.js";
import { IrUnsupportedError } from "../shared/contracts/ir-preparation-errors.js";

function unsupported(where: string, detail: string): never {
  throw new IrUnsupportedError("type-resolution-unsupported", "build", `record contract in ${where}: ${detail}`);
}

function scalar(type: ts.Type): IrType | undefined {
  if (type.flags & ts.TypeFlags.NumberLike) return irVal({ kind: "f64" });
  if (type.flags & ts.TypeFlags.BooleanLike) return irVal({ kind: "i32", boolean: true });
  if (type.flags & ts.TypeFlags.StringLike) return { kind: "string" };
  return undefined;
}

export function sourceCheckerScalar(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  return scalar(checker.getTypeAtLocation(node));
}

/** Keep source callable inference at the same frontend boundary as record facts. */
export function sourceInferredCallableResult(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration,
  where: string,
  convert: (type: ts.Type) => IrType | null,
): IrType | undefined {
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
  if (type.isUnionOrIntersection()) unsupported(where, "inferred callable result has an ambiguous contract");
  const result = convert(type);
  if (result?.kind !== "callable") unsupported(where, "inferred callable result lost its checker contract");
  return result;
}

/** Annotation and inferred data records share one logical field conversion. */
function recordType(checker: ts.TypeChecker, input: ts.Type, where: string, inferred: boolean): IrType {
  const active = new Set<ts.Type>();
  const convert = (type: ts.Type): IrType => {
    const primitive = scalar(type);
    if (primitive) return primitive;
    if (!(type.flags & ts.TypeFlags.Object) || type.isUnionOrIntersection())
      return unsupported(where, "field needs an exact scalar or record contract");
    if (active.has(type)) return unsupported(where, "recursive record needs a declared reference identity");
    // Expanding generic recursion can produce a fresh checker type at every
    // level. Fail explicitly rather than treating object identity as a bound.
    if (active.size >= 64) return unsupported(where, "record expansion exceeds the supported contract depth");
    if (
      checker.isArrayType(type) ||
      checker.isTupleType(type) ||
      checker.getIndexInfosOfType(type).length ||
      checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
      checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length ||
      type.getSymbol()?.declarations?.some((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d))
    )
      return unsupported(where, "array, index, callable or nominal class carrier needs its separate contract");
    const properties = checker.getPropertiesOfType(type);
    if (!properties.length && !inferred) return unsupported(where, "empty object does not declare record fields");
    active.add(type);
    try {
      const fields = properties.map((property) => {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        if (
          !declaration ||
          !(
            ts.isPropertySignature(declaration) ||
            (inferred && (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)))
          ) ||
          (ts.isPropertySignature(declaration) && declaration.questionToken) ||
          property.flags & ts.SymbolFlags.Optional ||
          (!inferred && (!ts.isPropertySignature(declaration) || !declaration.type)) ||
          (!ts.isIdentifier(declaration.name) &&
            !ts.isStringLiteral(declaration.name) &&
            !ts.isNumericLiteral(declaration.name))
        )
          return unsupported(where, "optional, computed or method member needs its separate contract");
        return { name: property.getName(), type: convert(checker.getTypeOfSymbolAtLocation(property, declaration)) };
      });
      fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { kind: "object", shape: { fields } };
    } finally {
      active.delete(type);
    }
  };
  return convert(input);
}

/** Logical source contract only: no native layout, own-property or boundary authority. */
export function sourceLogicalRecordType(checker: ts.TypeChecker, node: ts.TypeNode, where: string): IrType | undefined {
  const type = checker.getTypeFromTypeNode(node);
  if (
    !(type.flags & ts.TypeFlags.Object) ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
    checker.isArrayType(type) ||
    checker.isTupleType(type)
  )
    return undefined;
  const declared = recordType(checker, type, where, false),
    observed = recordType(checker, checker.getTypeAtLocation(node), where, false);
  if (!irTypeEquals(declared, observed)) return unsupported(where, "annotation disagrees with its checker contract");
  return declared;
}

/** Known undefined may use the existing zero-result ABI, not a fabricated value carrier. */
function sourceReturnsOnlyUndefined(checker: ts.TypeChecker, declaration: ts.FunctionDeclaration): boolean {
  const globalUndefined = checker.resolveName("undefined", undefined, ts.SymbolFlags.Value, false);
  let known = true;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      let value = node.expression;
      while (
        ts.isParenthesizedExpression(value) ||
        ts.isAsExpression(value) ||
        ts.isTypeAssertionExpression(value) ||
        ts.isNonNullExpression(value)
      )
        value = value.expression;
      if (
        !ts.isVoidExpression(value) &&
        !(
          ts.isIdentifier(value) &&
          value.text === "undefined" &&
          globalUndefined &&
          checker.getSymbolAtLocation(value) === globalUndefined
        )
      )
        known = false;
    }
    ts.forEachChild(node, visit);
  };
  if (!declaration.body) return false;
  visit(declaration.body);
  return known;
}

/** A failed lattice conversion is unknown, never proof that the source returns void. */
export function sourceInferredReturnType(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration,
  propagated: IrType | null,
): IrType | null {
  const where = declaration.name?.text ?? "anonymous source function";
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!signature) return unsupported(where, "missing actual inferred return signature");
  const callableResult = checker.getReturnTypeOfSignature(signature);
  const async = declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  const result = async ? checker.getAwaitedType(callableResult) : callableResult;
  if (!result) return unsupported(where, "inferred fulfillment contract is unresolved");
  const primitive = scalar(result);
  if (
    primitive?.kind === "val" &&
    primitive.val.kind === "f64" &&
    propagated?.kind === "val" &&
    propagated.val.kind === "i32"
  )
    return propagated; // Preserve an existing positive integer-domain proof.
  if (primitive) return primitive;
  // The checker preserves Boolean brands and complete nested field contracts
  // that the bounded scalar propagation lattice can widen or discard.
  if (
    (result.flags & ts.TypeFlags.Object) !== 0 &&
    !checker.getSignaturesOfType(result, ts.SignatureKind.Call).length &&
    !checker.isArrayType(result) &&
    !checker.isTupleType(result)
  )
    return recordType(checker, result, where, true);
  // Keep existing positive propagation/callable proofs, including recursive
  // numeric kernels whose checker result is any. No null coalescing to void.
  if (propagated) return propagated;
  if ((result.flags & ts.TypeFlags.Void) !== 0) return null;
  if ((result.flags & ts.TypeFlags.Undefined) !== 0 && sourceReturnsOnlyUndefined(checker, declaration)) return null;
  if ((result.flags & ts.TypeFlags.Object) !== 0) return recordType(checker, result, where, true);
  return unsupported(where, "inferred return has no owned value contract; it is not void");
}
