// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491) `__vec_index_enumerable(vec, key) -> i32` — the `[[Enumerable]]` half
 * of a `for…in` over an array whose indices carry descriptors.
 *
 * ## What was wrong
 *
 * `emitArrayForIn` (statements/loops.ts) enumerates `"0" … "length-1"`
 * unconditionally in the native (standalone / wasi) lane. Since #3251 an array
 * index CAN carry a descriptor — `Object.defineProperties(arr, {"0": {value:
 * 1001, writable: true, configurable: true}})` records `enumerable: false`
 * (§6.2.5.6 CompletePropertyDescriptor: an absent attribute defaults to
 * `false`) in the overlay companion — and the loop enumerated it anyway.
 *
 * Measured on this branch, `--target standalone`, before the fix: the
 * descriptor itself is already right (`getOwnPropertyDescriptor(a,"0")` reads
 * `1001/true/false/true`); only the enumeration disagreed. Two rows in the
 * `built-ins/Object/defineProperties` bucket fail on exactly that —
 * `15.2.3.7-6-a-198` (data descriptor) and `15.2.3.7-6-a-203` (accessor
 * descriptor); both assert that a `for…in` does NOT yield `"0"`.
 *
 * ## Where the check goes, and why there
 *
 * `emitArrayForIn` already has a per-iteration gate inside its `$continue`
 * block — #4222's `__extern_has_idx` presence test, which `br_if 0`s (i.e.
 * continues) on a `delete`d index. `[[Enumerable]]` is the same shape of
 * question about the same store, so it joins that gate rather than adding a
 * second one: the user body's break/continue depths stay untouched, and the two
 * conditions compose with a single `i32.and`.
 *
 * ## Demand gate
 *
 * `vecOwnKeysEnumerationActive` (`vec-overlay-keys.ts`): standalone AND the
 * module syntactically mentions a descriptor-defining / own-key-reading builtin.
 * A module that never mentions one cannot have a non-enumerable index, so it
 * gets no native, no call and no local — its bytes are unchanged.
 *
 * ## Reserve / fill
 *
 * `__vec_overlay_lookup` is minted by `fillVecOverlayHelpers` at FINALIZE, long
 * after a function body is emitted, so this follows the #4230 reserve-then-fill
 * discipline of `__vec_overlay_push_keys`: reserved as a placeholder that
 * answers `1` ("enumerable" — today's answer), the call is baked at for-in emit
 * time, and the real body is installed from `fillObjVecReflectionHelpers`. A
 * skipped fill degrades to exactly the previous behaviour, never a trap.
 *
 * ## Deliberately NOT widened here
 *
 * `Object.keys` / `getOwnPropertyNames` over a vec have the same gap (measured:
 * `Object.keys(a)` still answers `["0"]` for the array above) but reach it
 * through `__vec_overlay_push_keys` and the `__object_keys` vec arm — different
 * wiring, no test in this bucket asserting it, and widening both at once would
 * make one regression indistinguishable from the other. Recorded so the next
 * reader does not have to re-derive it.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { vecOwnKeysEnumerationActive } from "./vec-overlay-keys.js";

/** `(externref vec, externref key) -> i32` — 1 iff the index may be enumerated. */
export const VEC_INDEX_ENUMERABLE = "__vec_index_enumerable";

/** #3251 descriptor overlay (`vec-overlay.ts`) — minted at FINALIZE. */
const VEC_OVERLAY_LOOKUP = "__vec_overlay_lookup";

/** `$PropEntry.$flags` mirror of the object-runtime ABI (stable since #1888). */
const FLAG_ENUMERABLE = 0x02;

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * Reserve the native so a for-in site can bake `call <idx>` before
 * `__vec_overlay_lookup` exists. Append-only mint (defined funcs live after the
 * imports, so no existing index shifts), idempotent, and a no-op unless the
 * demand gate is open — in which case the caller emits no gate at all.
 */
export function reserveVecIndexEnumerable(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(VEC_INDEX_ENUMERABLE);
  if (existing !== undefined) return existing;
  if (!vecOwnKeysEnumerationActive(ctx)) return undefined;
  const typeIdx = addFuncType(ctx, [EXT, EXT], [I32], `$${VEC_INDEX_ENUMERABLE}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: VEC_INDEX_ENUMERABLE,
    typeIdx,
    locals: [],
    // SAFE placeholder: "enumerable", i.e. today's answer.
    body: [{ op: "i32.const", value: 1 }],
    exported: false,
  });
  ctx.funcMap.set(VEC_INDEX_ENUMERABLE, funcIdx);
  return funcIdx;
}

/**
 * Fill `__vec_index_enumerable`. Called from `fillObjVecReflectionHelpers`
 * AFTER `fillVecOverlayHelpers` has minted `__vec_overlay_lookup`. Callers baked
 * the RESERVED index, so this is order-independent with respect to them.
 */
export function fillVecIndexEnumerable(ctx: CodegenContext): void {
  const selfIdx = ctx.funcMap.get(VEC_INDEX_ENUMERABLE);
  if (selfIdx === undefined) return;
  const fn = definedFuncAt(ctx, selfIdx);
  if (!fn) return;
  const types = ctx.objectRuntimeTypes;
  if (!types) return;
  const { objectTypeIdx, propEntryTypeIdx } = types;
  const overlayLookupIdx = ctx.funcMap.get(VEC_OVERLAY_LOOKUP);
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (overlayLookupIdx === undefined || objFindIdx === undefined) return;

  const L_COMPANION = 2;
  const L_ENTRY = 3;
  const body: Instr[] = [
    // companion = __vec_overlay_lookup(any.convert_extern(vec))
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "call", funcIdx: overlayLookupIdx },
    { op: "local.tee", index: L_COMPANION },
    { op: "ref.is_null" },
    // No companion ⇒ no descriptor ⇒ an ordinary enumerable element.
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
    // entry = __obj_find(companion, key)
    { op: "local.get", index: L_COMPANION },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objFindIdx },
    { op: "local.tee", index: L_ENTRY },
    { op: "ref.is_null" },
    // The companion exists but says nothing about THIS index — the dense
    // element stands, and a dense element is enumerable.
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
    // return (entry.$flags & FLAG_ENUMERABLE) != 0
    { op: "local.get", index: L_ENTRY },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
    { op: "i32.const", value: FLAG_ENUMERABLE },
    { op: "i32.and" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
  ];
  fn.locals = [
    { name: "companion", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
    { name: "entry", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
  ];
  fn.body = body;
}
