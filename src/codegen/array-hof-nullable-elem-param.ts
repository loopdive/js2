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
import ts from "typescript";
import type { ValType } from "../ir/types.js";
import { getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

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
  /** The receiver's real element type: `ref_null`, or `externref` (#7152). */
  readonly elemType: ValType;
  /** Runtime parameter index that receives the element. */
  readonly paramIndex: number;
  /**
   * (#7152) The callback the override is for. Required for an `externref`
   * element so a closure nested inside the callback body keeps its own types.
   */
  readonly callback?: ts.Node;
}

/**
 * The override to install for a receiver whose elements are `ref_null` — i.e.
 * the cases where "the checker's element type may be a nullability lie" is even
 * possible — or (#7152) whose elements are `externref`. Any other element type
 * returns `undefined` (no override).
 */
export function nullableElemParamOverrideFor(
  elemType: ValType | undefined,
  paramIndex: number,
  callback?: ts.Node,
): NullableElemParamOverride | undefined {
  if (elemType?.kind === "ref_null") return { elemType, paramIndex };
  // (#7152) An externref-storage vec (an evolving `const keys = []` filled by
  // `for…in` plus pushed numbers) whose checker element type is a primitive
  // union (`string | number` → `$AnyValue`). Its elements are never `$AnyValue`
  // structs, so the loop's externref→`$AnyValue` cast produced null and the
  // predicate's `typeof k` / `k !== "a"` dereferenced it.
  if (elemType?.kind === "externref" && callback !== undefined) {
    let fn: ts.Node = callback;
    while (ts.isParenthesizedExpression(fn)) fn = fn.expression; // `filter((k => …))`
    return { elemType, paramIndex, callback: fn };
  }
  return undefined;
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
 *
 * (#7152) For an `externref` element the only re-typed pair is an `$AnyValue`
 * parameter of the callback itself (`fn`): it then takes the element live,
 * where the loop's externref→`$AnyValue` cast would hand it null. (The
 * `reduce*` accumulator is deliberately NOT re-typed: the call's result is
 * still typed `$AnyValue`, so a pass-through `acc` would be cast to null.)
 */
export function applyNullableElemParamOverride(
  resolved: ValType,
  override: NullableElemParamOverride | undefined,
  runtimeIndex: number,
  anyValueTypeIdx = -1,
  fn?: ts.Node,
): ValType {
  if (override === undefined || override.paramIndex !== runtimeIndex) return resolved;
  if (override.elemType.kind === "externref") {
    const boxed = resolved.kind === "ref" || resolved.kind === "ref_null";
    const isAnyValue = boxed && anyValueTypeIdx >= 0 && resolved.typeIdx === anyValueTypeIdx;
    return isAnyValue && fn === override.callback ? override.elemType : resolved;
  }
  if (resolved.kind !== "ref" || override.elemType.kind !== "ref_null") return resolved;
  return resolved.typeIdx === override.elemType.typeIdx ? override.elemType : resolved;
}

/** `applyNullableElemParamOverride` with the context's live override and `$AnyValue` index. */
export function hofElemParamType(ctx: CodegenContext, resolved: ValType, runtimeIndex: number, fn: ts.Node): ValType {
  return applyNullableElemParamOverride(
    resolved,
    ctx.arrayHofNullableElemParamOverride,
    runtimeIndex,
    ctx.anyValueTypeIdx,
    fn,
  );
}

/**
 * (#7152) An identifier whose slot is a raw `externref` although the checker
 * types it as a primitive union (`$AnyValue`) — the callback element parameter
 * re-typed above. Boxing it into `$AnyValue` for `typeof`'s tag fast path
 * classifies every non-`$AnyValue` value as tag 5, so a stored number read
 * `typeof k === "number"` as false; the `__typeof_*` helpers inspect the value.
 */
export function identifierHoldsRawExternref(fctx: FunctionContext, operand: ts.Expression): boolean {
  if (!ts.isIdentifier(operand)) return false;
  // A mutably captured parameter lives in a ref cell: decide from the cell's value type.
  const boxed = fctx.boxedCaptures?.get(operand.text);
  if (boxed) return boxed.valType.kind === "externref";
  const index = fctx.localMap.get(operand.text);
  return index !== undefined && getLocalType(fctx, index)?.kind === "externref";
}
