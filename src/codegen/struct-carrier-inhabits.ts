// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5327) Element-carrier compatibility for an unannotated array literal.
 *
 * `compileArrayLiteral` keys a vec to element zero's carrier and guard-casts
 * every later element into it. That is only sound when the later element
 * genuinely INHABITS element zero's WasmGC struct; this module owns the proof.
 *
 * The two `ValType`/type-table primitives underneath it —
 * `closedDataStructCarrierIdx` (is the guard-cast even in play?) and
 * `structCarrierInhabits` (does the candidate reach element zero's carrier
 * through its declared supertype chain?) — ask wasm-lowering questions,
 * deliberately ABOVE what `ctx.oracle` models, which is why the resolution runs
 * here rather than through the oracle (#1930 / #3273).
 */
import { ts } from "../ts-api.js";
import { resolveWasmType } from "./index.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { valTypesMatch } from "./shared.js";
import {
  _isUndefinedLike,
  staticObjectLiteralDataKeys,
  unwrapArrayCarrierExpression,
  unwrapObjectLiteralElement,
} from "./literals.js";

/** Guard against a cyclic/self-referential supertype edge in a malformed table. */
const MAX_SUPERTYPE_HOPS = 64;

/**
 * The struct type index behind `carrier` when it is a plain closed data struct,
 * else `null`. String carriers and vec (nested-array) carriers are excluded:
 * they have their own dedicated element-carrier decisions in `literals.ts` and
 * must not be re-keyed by the data-struct rule.
 */
export function closedDataStructCarrierIdx(ctx: CodegenContext, carrier: ValType): number | null {
  if (carrier.kind !== "ref" && carrier.kind !== "ref_null") return null;
  const typeIdx = (carrier as { typeIdx: number }).typeIdx;
  if (typeIdx < 0) return null;
  if (typeIdx === ctx.anyStrTypeIdx || typeIdx === ctx.nativeStrTypeIdx) return null;
  if (ctx.mod.types[typeIdx]?.kind !== "struct") return null;
  for (const vecTypeIdx of ctx.vecTypeMap.values()) if (vecTypeIdx === typeIdx) return null;
  return typeIdx;
}

/**
 * Does the struct at `carrierIdx` inhabit the slot typed by `baseIdx`? True for
 * the same type and for any declared subtype of it (`superTypeIdx` chain). A
 * `baseIdx` of `-1` is the "no base constraint" sentinel, so callers running
 * only the object-literal proof can share the walk.
 */
export function structCarrierInhabits(ctx: CodegenContext, carrierIdx: number, baseIdx: number): boolean {
  if (baseIdx < 0) return true;
  let current = carrierIdx;
  for (let hops = 0; hops < MAX_SUPERTYPE_HOPS && current >= 0; hops++) {
    if (current === baseIdx) return true;
    const def = ctx.mod.types[current];
    if (!def || def.kind !== "struct") return false;
    const next = def.superTypeIdx;
    if (next === undefined || (next as number) < 0) return false;
    current = next as number;
  }
  return false;
}

/**
 * Does a first-object array literal contain another element that cannot inhabit
 * the first object's exact closed struct? `compileArrayLiteral` historically
 * keyed the vec to element zero, then guarded-cast every later object to it.
 * Equal property names are not sufficient: `{params: {a: 1}}` and
 * `{params: {b: 2}}` have the same outer key but incompatible nested-field
 * carriers. Compare the resolved closed structs as well as the conservative
 * static key proof before retaining element zero's carrier. (#4289)
 *
 * (#5327) The same hazard exists when element zero is NOT written as an object
 * literal — a CALL that returns one is the common spelling
 * (`[group(doc), ifBreak(doc)]` in Prettier's `doc-builders` unit). #4289's
 * proof bailed out on its first line for any non-literal element zero, so such
 * a literal kept element zero's exact closed struct and guard-cast every later
 * element into it. Where the later element's struct shares no field layout with
 * element zero's, that coercion can only emit
 * `ref.test` → `ref.null` → `ref.as_non_null`, which TRAPS with "dereferencing
 * a null pointer" while the module is still initialising — measured on
 * prettier@3.8.1, where it took all 46 tests of `tests/unit/doc-builders.js`
 * with it (that file's `valid` array is `[group(doc), ifBreak(doc), …]`).
 *
 * So the non-literal arm compares resolved carriers directly. It stays narrow
 * on purpose: only elements that themselves resolve to a closed data struct are
 * consulted (a string / number / vec element is another widening's business),
 * and a struct that INHABITS element zero's carrier through the declared
 * supertype chain is fine — `[new Shape(), new Circle()]` must keep the closed
 * `$Shape` vec that #2021 relies on.
 *
 * NOT fixed here, and measured to survive this change: when the later element's
 * field NAMES are a superset of element zero's (`{type, contents}` then
 * `{type, n, contents}`) nothing traps — the coercion re-projects the shared
 * fields and silently drops `n`. Widening the literal stops that at
 * CONSTRUCTION, but the binding's own slot type is independently keyed to
 * TypeScript's best-common-supertype inference (`{type, contents}[]`) and the
 * store into it re-narrows every element the same lossy way. That is a
 * binding-slot defect, not a literal one; see the issue file.
 */
export function hasIncompatibleElementCarrier(
  ctx: CodegenContext,
  expr: ts.ArrayLiteralExpression,
  first: ts.Expression,
): boolean {
  const firstObject = unwrapObjectLiteralElement(first);
  const firstKeys = firstObject ? staticObjectLiteralDataKeys(ctx, firstObject) : null;
  if (firstObject && !firstKeys) return true;
  const firstCarrier = carrierOf(ctx, firstObject ?? unwrapArrayCarrierExpression(first));
  const firstStructIdx = firstObject ? -1 : closedDataStructCarrierIdx(ctx, firstCarrier);
  if (firstStructIdx === null) return false;

  for (const element of expr.elements) {
    if (ts.isOmittedExpression(element) || ts.isSpreadElement(element) || _isUndefinedLike(element)) continue;
    const object = unwrapObjectLiteralElement(element);
    if (firstObject) {
      if (!object) return true;
      const keys = staticObjectLiteralDataKeys(ctx, object);
      if (!keys || keys.length !== firstKeys!.length || keys.some((key, index) => key !== firstKeys![index])) {
        return true;
      }
      if (!valTypesMatch(carrierOf(ctx, object), firstCarrier)) return true;
      continue;
    }
    const structIdx = closedDataStructCarrierIdx(ctx, carrierOf(ctx, object ?? unwrapArrayCarrierExpression(element)));
    if (structIdx === null) continue;
    if (!structCarrierInhabits(ctx, structIdx, firstStructIdx)) return true;
  }
  return false;
}

/**
 * One resolution site for every carrier proof in this module: the question is
 * which WasmGC carrier an element LOWERS to, which is a `ValType` fact above
 * what `ctx.oracle` models (#1930 / #3273).
 */
function carrierOf(ctx: CodegenContext, node: ts.Expression): ValType {
  return resolveWasmType(ctx, ctx.checker.getTypeAtLocation(node));
}

/**
 * (#6491) Does the literal hold an element that CANNOT inhabit a closed
 * data-struct carrier at all — a number, a boolean, a native string, a nested
 * vec?
 *
 * This is the case {@link hasIncompatibleElementCarrier}'s doc comment names
 * and deliberately declines ("a string / number / vec element is another
 * widening's business"). It had no other widening. Element zero fixes the vec
 * to its closed `$__anon_N` struct and `compileArrayLiteral` guard-casts every
 * later element into it; for an element whose carrier is not a struct at all
 * the only lowering available is `ref.test` → `ref.null` → `ref.as_non_null`,
 * which TRAPS while the literal is still being CONSTRUCTED. Measured on this
 * tree, standalone, four lines and no provider:
 *
 *     const obj = { year: 1, month: 2, day: 3 };
 *     [obj, "str"].length            // RuntimeError: dereferencing a null pointer
 *
 * `[{ year: 1 }, "str"]` — the same array written with element zero INLINE —
 * already widens, because the first-object arm above rejects any non-object
 * sibling outright. Only the far more common binding spelling
 * (`const obj = {…}; [obj, "str"]`) reached this hole, since
 * `unwrapObjectLiteralElement` does not resolve an identifier to its
 * initializer.
 *
 * Narrowness, in the same spirit as the proof above:
 *
 *  - an element whose carrier IS a closed data struct is #4289/#5327's
 *    business (the declared-supertype chain decides), so it is skipped here;
 *  - an `externref`/`anyref` element is the dynamic widenings' business
 *    (`hasDynamicOrCallableElement` and friends) and is skipped too — which is
 *    also why the JS-host lane, where a string element is plain `externref`,
 *    is untouched by this predicate;
 *  - a spread, a hole and an `undefined`-like element are skipped exactly as
 *    the proof above skips them.
 */
export function hasNonStructElementForStructCarrier(
  ctx: CodegenContext,
  expr: ts.ArrayLiteralExpression,
  carrier: ValType,
): boolean {
  const baseIdx = closedDataStructCarrierIdx(ctx, carrier);
  if (baseIdx === null) return false;
  for (const element of expr.elements) {
    if (ts.isOmittedExpression(element) || ts.isSpreadElement(element) || _isUndefinedLike(element)) continue;
    const value = unwrapObjectLiteralElement(element) ?? unwrapArrayCarrierExpression(element);
    const elemCarrier = carrierOf(ctx, value);
    // A number or a boolean lowers to a scalar: no cast into a struct exists.
    if (elemCarrier.kind === "f64" || elemCarrier.kind === "i32") return true;
    if (elemCarrier.kind !== "ref" && elemCarrier.kind !== "ref_null") continue;
    if ((elemCarrier as { typeIdx: number }).typeIdx === baseIdx) continue;
    // A closed data struct is the declared-supertype proof's business.
    if (closedDataStructCarrierIdx(ctx, elemCarrier) !== null) continue;
    // A native string / vec ref: a different rec-group member, never a subtype
    // of the element-zero struct, so the guard cast can only answer null.
    return true;
  }
  return false;
}
