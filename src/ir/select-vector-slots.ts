// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { asVal, type IrType } from "./nodes.js";
import type { ValType } from "./types.js";

type ImplicitNumericVecPredicate = (parameter: ts.ParameterDeclaration) => boolean;
type MutableSlotResolvedKind = "f64" | "bool" | "string" | "object" | "void" | "closure" | "dynamic";

export function isNumericArrayTypeNode(node: ts.TypeNode): boolean {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return isNumericArrayTypeNode(node.type);
  }
  if (ts.isArrayTypeNode(node)) return node.elementType.kind === ts.SyntaxKind.NumberKeyword;
  return (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    (node.typeName.text === "Array" || node.typeName.text === "ReadonlyArray") &&
    node.typeArguments?.length === 1 &&
    node.typeArguments[0]!.kind === ts.SyntaxKind.NumberKeyword
  );
}

export function parameterUsesNumericVecAbi(
  parameter: ts.ParameterDeclaration,
  implicit?: ImplicitNumericVecPredicate,
): boolean {
  const type = parameter.type ?? ts.getJSDocType(parameter);
  return type ? isNumericArrayTypeNode(type) : implicit?.(parameter) === true;
}

export function mutableParameterHasIrSlot(
  parameter: ts.ParameterDeclaration,
  resolvedKind: MutableSlotResolvedKind,
  implicit?: ImplicitNumericVecPredicate,
): boolean {
  return (
    resolvedKind === "f64" ||
    resolvedKind === "bool" ||
    resolvedKind === "string" ||
    resolvedKind === "dynamic" ||
    (resolvedKind === "object" && parameterUsesNumericVecAbi(parameter, implicit))
  );
}

/**
 * True for the IR type a direct-call plan gives an unannotated numeric-array
 * parameter: `vec<f64>`. The annotation-driven overrides path types the same
 * ABI as a raw `val ref` of the legacy `__vec_f64` struct instead — both
 * lower to the identical ValType, and the static numeric-array admission
 * (`directCallParamUsesNumericVecAbi`) accepts both, so the build-side plan
 * consumers must too. Accepting only the raw-ref shape made the selector
 * over-claim and surfaced as the hard `identifier "…" is not in scope`
 * invariant on acorn's `isIdentifierStart(code, astralIdentifierStartCodes)`.
 */
export function isNumericVecIrType(t: IrType): boolean {
  return t.kind === "vec" && t.elementType.kind === "val" && t.elementType.val.kind === "f64";
}

/**
 * True when `expected` is an acceptable static-numeric-array param type for
 * the plan consumers: a raw ref/ref_null val, or the vec<f64> IR shape.
 */
export function acceptsStaticNumericArrayParam(expected: IrType): boolean {
  if (isNumericVecIrType(expected)) return true;
  const expectedVal = asVal(expected);
  return expectedVal !== null && (expectedVal.kind === "ref" || expectedVal.kind === "ref_null");
}

/**
 * Build-side twin: the module global backing a static numeric array must be
 * type-compatible with the callee param. For the vec<f64> shape (no typeIdx
 * to compare exactly) the verification goes through the struct-name registry
 * — the global must actually be the legacy `__vec_f64` struct; the raw-ref
 * shape keeps the exact ValType comparison via `sameVal`.
 */
export function staticNumericArrayGlobalMatches(
  globalType: ValType,
  expected: IrType,
  structNameOf: (typeIdx: number) => string | undefined,
): boolean {
  if (isNumericVecIrType(expected)) {
    return (
      (globalType.kind === "ref" || globalType.kind === "ref_null") &&
      structNameOf((globalType as { typeIdx: number }).typeIdx) === "__vec_f64"
    );
  }
  const expectedVal = asVal(expected);
  if (expectedVal === null || globalType.kind !== expectedVal.kind) return false;
  if (globalType.kind === "ref" || globalType.kind === "ref_null") {
    return (globalType as { typeIdx: number }).typeIdx === (expectedVal as { typeIdx: number }).typeIdx;
  }
  return true;
}
