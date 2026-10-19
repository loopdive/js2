// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
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

/** Logical source contract only: no native layout, own-property or boundary authority. */
export function sourceLogicalRecordType(checker: ts.TypeChecker, node: ts.TypeNode, where: string): IrType | undefined {
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
    if (!properties.length) return unsupported(where, "empty object does not declare record fields");
    active.add(type);
    try {
      const fields = properties.map((property) => {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        if (
          !declaration ||
          !ts.isPropertySignature(declaration) ||
          declaration.questionToken ||
          property.flags & ts.SymbolFlags.Optional ||
          !declaration.type ||
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
  const type = checker.getTypeFromTypeNode(node);
  if (
    !(type.flags & ts.TypeFlags.Object) ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
    checker.isArrayType(type) ||
    checker.isTupleType(type)
  )
    return undefined;
  const declared = convert(type),
    observed = convert(checker.getTypeAtLocation(node));
  if (!irTypeEquals(declared, observed)) return unsupported(where, "annotation disagrees with its checker contract");
  return declared;
}
