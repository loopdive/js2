// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

// Runtime contract: keep in lock-step with _COMPILED_TYPED_ARRAY_CTORS in
// runtime.ts. Zero is deliberately not a valid brand.
const TYPED_ARRAY_HOST_TAGS: Readonly<Record<string, number>> = {
  Int8Array: 1,
  Uint8Array: 2,
  Uint8ClampedArray: 3,
  Int16Array: 4,
  Uint16Array: 5,
  Int32Array: 6,
  Uint32Array: 7,
  Float32Array: 8,
  Float64Array: 9,
  BigInt64Array: 10,
  BigUint64Array: 11,
};

export function isHostTypedArrayCarrierName(name: string | undefined): name is string {
  return name !== undefined && TYPED_ARRAY_HOST_TAGS[name] !== undefined;
}

/** The concrete host-lane TypedArray brand carried by an expression, if any. */
export function hostTypedArrayCarrierNameForExpression(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  let type = ctx.checker.getTypeAtLocation(expr);
  if (type.isUnion()) {
    const nonNullish = type.types.filter(
      (member) =>
        !(member.flags & ts.TypeFlags.Null) &&
        !(member.flags & ts.TypeFlags.Undefined) &&
        !(member.flags & ts.TypeFlags.Void),
    );
    if (nonNullish.length === 1) type = nonNullish[0]!;
  }
  const name = type.aliasSymbol?.name ?? type.getSymbol()?.name;
  if (isHostTypedArrayCarrierName(name)) return name;
  return ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    isHostTypedArrayCarrierName(expr.expression.text)
    ? expr.expression.text
    : undefined;
}
