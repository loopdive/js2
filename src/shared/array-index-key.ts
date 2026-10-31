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
 * Legacy's high-index route (`codegen/vec-sparse-index.ts`,
 * `codegen/array-nonindex-key.ts`) and its `in` carrier handle the indices
 * above it apart.
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
 * The value of an element key spelled as a literal: a numeric literal under
 * any number of unary `+` / `-`, `true`, `false`, `null`, `void …`, or the
 * global `undefined` / `NaN` / `Infinity` unless `isShadowed` reports a
 * binding of the identifier's own. `key` comes unwrapped
 * (`skipTransparentExpressions`); a unary operand is unwrapped here.
 * `undefined` (no record) for any other spelling.
 */
export function literalElementKey(
  key: ts.Expression,
  isShadowed: (id: ts.Identifier) => boolean,
): ElementKeyValue | undefined {
  if (ts.isNumericLiteral(key)) return { value: Number(key.text) };
  if (key.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (key.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (key.kind === ts.SyntaxKind.NullKeyword) return { value: null };
  if (ts.isVoidExpression(key)) return { value: undefined };
  if (ts.isIdentifier(key) && !isShadowed(key)) {
    if (key.text === "undefined") return { value: undefined };
    if (key.text === "NaN") return { value: NaN };
    if (key.text === "Infinity") return { value: Infinity };
    return undefined;
  }
  if (
    ts.isPrefixUnaryExpression(key) &&
    (key.operator === ts.SyntaxKind.MinusToken || key.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = literalElementKey(skipTransparentExpressions(key.operand), isShadowed)?.value;
    if (typeof operand !== "number") return undefined;
    return { value: key.operator === ts.SyntaxKind.MinusToken ? -operand : operand };
  }
  return undefined;
}

/**
 * (#7106) The value of an element key known before runtime: its literal
 * spelling (`literalElementKey`), else what `numberValue` reads for it. `key`
 * comes unwrapped: a type-erased cast changes a key's type, not its value.
 *
 * The reader decides how far the value can be trusted. The selector reads the
 * key's number literal TYPE (`isLegacyOnlyVecKey`), which narrowing gets wrong
 * once a call changes the value (`if (o.k === 1) { o.set(); a[o.k] }`), and a
 * `const` copying the narrowed value copies the wrong type. The selector only
 * refuses on it, which is safe: legacy's key lowering reads no types, so it
 * handles such a key from its runtime value. The element lowering skips the
 * runtime key test on the value, so it reads a `const` binding's own
 * initializer instead (`constBindingNumber`).
 */
export function staticElementKey(
  key: ts.Expression,
  isShadowed: (id: ts.Identifier) => boolean,
  numberValue: ((key: ts.Expression) => number | undefined) | undefined,
): ElementKeyValue | undefined {
  const literal = literalElementKey(key, isShadowed);
  if (literal !== undefined) return literal;
  const value = numberValue?.(key);
  return value === undefined ? undefined : { value };
}

/**
 * (#7106) The number a `const` binding holds when its initializer spells one,
 * directly or through another such binding (`const K = 2147483648; a[K]`).
 * `bindings` is the type oracle, whose `constInitializerOf` (#869) answers for
 * a plain `const` with an initializer. An ambient `declare const K = 1` gives
 * nothing: the host defines its value. `key` comes unwrapped.
 */
export function constBindingNumber(
  key: ts.Expression,
  bindings: { constInitializerOf(id: ts.Identifier): ts.Expression | undefined },
): number | undefined {
  const seen = new Set<ts.Expression>();
  for (let inner = key; ts.isIdentifier(inner); ) {
    const initializer = bindings.constInitializerOf(inner);
    if (initializer === undefined || seen.has(initializer)) return undefined;
    const declaration = initializer.parent as ts.VariableDeclaration;
    if ((ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0) return undefined;
    seen.add(initializer);
    inner = skipTransparentExpressions(initializer);
    // Every name counts as shadowed: a name in the initializer resolves
    // through `bindings` on the next turn, a user's `const NaN = 2` included.
    const literal = literalElementKey(inner, () => true);
    if (literal !== undefined) return typeof literal.value === "number" ? literal.value : undefined;
  }
  return undefined;
}

/** (#7106) `true` when a key's static value (`staticElementKey`) is an array index. */
export function isStaticArrayIndex(known: ElementKeyValue | undefined): boolean {
  return known !== undefined && typeof known.value === "number" && isArrayIndexNumber(known.value);
}
