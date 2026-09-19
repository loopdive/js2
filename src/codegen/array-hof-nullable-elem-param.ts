// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6602 (#5383 S15) — the array-HOF callback boundary for a **nullable** vec
 * element.
 *
 * A vec whose element type is `ref_null T` can hold a null slot that the rest
 * of the compiler reads as `undefined` — the standalone `exec` match vec is the
 * load-bearing instance (`native-regex.ts` `ensureRegexMatchVecType` stores an
 * unmatched capture group as a null native string, documented in
 * `regexp-standalone.ts` as "the compiler's `undefined` for nullable native
 * string slots").
 *
 * TypeScript does not model that: `RegExpExecArray extends Array<string>`, so
 * the checker resolves an array-HOF callback's first parameter to the NON-NULL
 * twin `ref T`. `buildClosureCallInstrs` then coerces the loaded element
 * `ref_null T` → `ref T`, which is a bare `ref.as_non_null`, and the very first
 * unmatched group traps.
 *
 * `map` never hit this because it already pins its callback's first parameter
 * to the receiver's real element type (`arrayMapCallbackFirstParamOverride`,
 * #4527/#5319). This module is that same idea for the rest of the family, but
 * deliberately NARROWER: it fires only on the exact non-null-twin pair, so no
 * other callback shape can change a single emitted byte.
 */
import type { ValType } from "../ir/types.js";

/**
 * Which callback parameter carries the ELEMENT, and what the element's real
 * type is.
 *
 * The index is not always 0: `reduce` / `reduceRight` call their callback as
 * `(accumulator, element, index, array)`, so pinning parameter 0 there would
 * re-type the ACCUMULATOR — wrong, and it would leave the `reduce` arm of the
 * family still trapping. Carrying the index with the type is what makes one
 * mechanism cover both callback shapes.
 */
export interface NullableElemParamOverride {
  /** The receiver's real element type. Always `ref_null` by construction. */
  readonly elemType: ValType;
  /** Runtime parameter index that receives the element. */
  readonly paramIndex: number;
}

/**
 * The override to install for a receiver whose elements are `ref_null` — i.e.
 * the cases where "the checker's element type may be a nullability lie" is even
 * possible. Any other element type returns `undefined` (no override).
 */
export function nullableElemParamOverrideFor(
  elemType: ValType | undefined,
  paramIndex: number,
): NullableElemParamOverride | undefined {
  return elemType !== undefined && elemType.kind === "ref_null" ? { elemType, paramIndex } : undefined;
}

/**
 * Apply the override to a checker-resolved parameter type.
 *
 * Returns the override's type **only** at the element parameter, and only when
 * `resolved` is the exact non-null twin of it (`ref X` against `ref_null X`).
 * Every other pair — a different parameter position, a different `typeIdx`, an
 * `externref`/scalar parameter, an already-nullable parameter, an absent
 * override — returns `resolved` unchanged. That is what keeps the blast radius
 * to the lie itself: a callback whose parameter the checker already typed
 * correctly is compiled exactly as before.
 */
export function applyNullableElemParamOverride(
  resolved: ValType,
  override: NullableElemParamOverride | undefined,
  runtimeIndex: number,
): ValType {
  if (override === undefined || override.paramIndex !== runtimeIndex) return resolved;
  if (resolved.kind !== "ref" || override.elemType.kind !== "ref_null") return resolved;
  return resolved.typeIdx === override.elemType.typeIdx ? override.elemType : resolved;
}
