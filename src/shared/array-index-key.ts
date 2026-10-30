// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7106) Array-index facts the legacy codegen and the IR share, so legacy's
// named-key route (`codegen/array-nonindex-key.ts`) and the IR selector agree on
// which constant keys name an element: the §10.4.2 index domain, the ceiling up
// to which a backing vec array is grown, and the value of a key spelled as a
// literal.
import { ts } from "../ts-api.js";
import { skipTransparentExpressions } from "./transparent-expressions.js";

/** 2^32 − 1 — the exclusive upper bound on array indices, itself not one (§10.4.2). */
export const MAX_ARRAY_INDEX_EXCLUSIVE = 4294967295;

/**
 * Largest index whose element the store path grows a backing vec array to
 * hold. Above it legacy's store moves only `length` (a sparse tail, see
 * `codegen/vec-sparse-index.ts`), and the IR selector leaves such a constant
 * index to legacy.
 */
export const SPARSE_INDEX_CEILING = 16777216;

/**
 * `true` when `n`'s property key (`ToString(n)`) is an array index.
 *
 * `-0` counts: `ToString(-0)` is `"0"`, and `0` is an index. `Number.isInteger`
 * accepts `-0` and `-0 >= 0` holds, so the plain arithmetic is already right.
 */
export function isArrayIndexNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n < MAX_ARRAY_INDEX_EXCLUSIVE;
}

/**
 * The value of an element key spelled as a literal, through transparent
 * wrappers: a numeric literal under any number of unary `+` / `-`, `true`,
 * `false`, `null`, `void …`, or the global `undefined` / `NaN` / `Infinity`
 * when `isShadowed` does not report the name as a local binding. `undefined`
 * (no record) for any other spelling.
 */
export function literalElementKey(
  key: ts.Expression,
  isShadowed: (name: string) => boolean,
): { readonly value: number | boolean | null | undefined } | undefined {
  const inner = skipTransparentExpressions(key);
  if (ts.isNumericLiteral(inner)) return { value: Number(inner.text) };
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (inner.kind === ts.SyntaxKind.NullKeyword) return { value: null };
  if (ts.isVoidExpression(inner)) return { value: undefined };
  if (ts.isIdentifier(inner) && !isShadowed(inner.text)) {
    if (inner.text === "undefined") return { value: undefined };
    if (inner.text === "NaN") return { value: NaN };
    if (inner.text === "Infinity") return { value: Infinity };
    return undefined;
  }
  if (
    ts.isPrefixUnaryExpression(inner) &&
    (inner.operator === ts.SyntaxKind.MinusToken || inner.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = literalElementKey(inner.operand, isShadowed)?.value;
    if (typeof operand !== "number") return undefined;
    return { value: inner.operator === ts.SyntaxKind.MinusToken ? -operand : operand };
  }
  return undefined;
}
