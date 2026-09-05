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
  // One resolution site for the whole proof: the question is which WasmGC
  // carrier an element LOWERS to, which is a `ValType` fact above what
  // `ctx.oracle` models (#1930 / #3273).
  const carrierOf = (node: ts.Expression): ValType => resolveWasmType(ctx, ctx.checker.getTypeAtLocation(node));

  const firstObject = unwrapObjectLiteralElement(first);
  const firstKeys = firstObject ? staticObjectLiteralDataKeys(ctx, firstObject) : null;
  if (firstObject && !firstKeys) return true;
  const firstCarrier = carrierOf(firstObject ?? unwrapArrayCarrierExpression(first));
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
      if (!valTypesMatch(carrierOf(object), firstCarrier)) return true;
      continue;
    }
    const structIdx = closedDataStructCarrierIdx(ctx, carrierOf(object ?? unwrapArrayCarrierExpression(element)));
    if (structIdx === null) continue;
    if (!structCarrierInhabits(ctx, structIdx, firstStructIdx)) return true;
  }
  return false;
}
