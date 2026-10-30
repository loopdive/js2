// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7106) Array-index facts the legacy codegen and the IR share, so legacy's
// named-key route (`codegen/array-nonindex-key.ts`) and the IR selector agree on
// which keys name an element: the §10.4.2 index domain (for a number and for a
// string key), the bounds on growing and indexing a backing vec array, and the
// value of a key known before runtime.
import { ts } from "../ts-api.js";
import { skipTransparentExpressions } from "./transparent-expressions.js";

/** 2^32 − 1 — the exclusive upper bound on array indices, itself not one (§10.4.2). */
export const MAX_ARRAY_INDEX_EXCLUSIVE = 4294967295;

/**
 * Largest index whose element legacy's store path grows a backing vec array to
 * hold. Above it legacy's store moves only `length` (a sparse tail, see
 * `codegen/vec-sparse-index.ts`); `a.length = n` and `defineProperty(a,
 * "length")` grow the backing array only up to it as well.
 */
export const SPARSE_INDEX_CEILING = 16777216;

/**
 * 2^31 − 1 — the largest array index an i32 carries as a non-negative value.
 * Legacy's high-index route (`codegen/vec-sparse-index.ts`) and the IR
 * selector both handle the indices above it apart.
 */
export const MAX_I32_INDEX = 0x7fffffff;

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
 * The array index a STRING property key names, else `undefined`: §10.4.2's
 * `ToString(ToUint32(k)) === k` and not 2^32 − 1. `"00"`, `"-0"`, `"1.0"`,
 * `" 1"`, `""` and `"4294967295"` name none.
 */
export function arrayIndexOfKey(key: string): number | undefined {
  const n = Number(key);
  return isArrayIndexNumber(n) && String(n) === key ? n : undefined;
}

/** The value of an element key known before runtime: a record, because the value may be `undefined`. */
export interface ElementKeyValue {
  readonly value: number | boolean | null | undefined;
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
): ElementKeyValue | undefined {
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

/**
 * (#7106) The value of an element key known before runtime: its literal
 * spelling (`literalElementKey`), else what `numberValue` reads for the key
 * with its type-erased casts removed (they change a key's type, not its
 * value). The caller's reader decides how far the value can be trusted.
 */
export function staticElementKey(
  key: ts.Expression,
  isShadowed: (name: string) => boolean,
  numberValue: ((expr: ts.Expression) => number | undefined) | undefined,
): ElementKeyValue | undefined {
  const literal = literalElementKey(key, isShadowed);
  if (literal !== undefined) return literal;
  const value = numberValue?.(skipTransparentExpressions(key));
  return value === undefined ? undefined : { value };
}

/** (#7106) `true` when a key's static value (`staticElementKey`) is an array index. */
export function isStaticArrayIndex(known: ElementKeyValue | undefined): boolean {
  return known !== undefined && typeof known.value === "number" && isArrayIndexNumber(known.value);
}
