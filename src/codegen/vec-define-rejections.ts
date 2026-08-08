// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4227) Array exotic `[[DefineOwnProperty]]` REJECTION guards for the #3251
 * standalone descriptor overlay.
 *
 * `__vec_dp_value` delegates the hard part of a define — §10.1.6.3
 * ValidateAndApplyPropertyDescriptor, the partial-descriptor merge, the
 * CompletePropertyDescriptor defaults — to the already-correct `$Object`
 * natives, running them against the vec's COMPANION object. That delegation is
 * what makes the overlay small, and it is also precisely why two spec
 * rejections could not come from it: both are properties of the VEC, and the
 * companion does not know it is standing in for one.
 *
 *   - The `length` property's [[Writable]] bit lives on the companion's reserved
 *     `"length"` entry, but §10.4.2.2 step 3 consults it for an INDEX define —
 *     a key the companion has no reason to connect to `"length"`.
 *   - [[Extensible]] lives on the VEC (the #4032 integrity bag). The companion
 *     is a private bookkeeping object that is always extensible.
 *
 * So they are guards in front of the delegation, not fixes inside it — which is
 * why they live here rather than in the applier. Each returns `[]` (emitting
 * nothing, changing nothing) when its substrate is unavailable, so a module
 * without the S3 error constructors or without the integrity predicates keeps
 * exactly today's lenient behaviour.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** `$PropEntry.$flags` bit 0 — mirrors the object-runtime flag ABI (#1888). */
const FLAG_WRITABLE = 0x01;

/** What both guards need from the applier builder's scope. */
export interface VecRejectionDeps {
  /** `[] -> [externref]`: the `"length"` key as an externref string. */
  lengthLitExtern: () => Instr[];
  /** `__obj_find(comp, key) -> (ref null $PropEntry)`. */
  objFindIdx: number;
  /** `$PropEntry` type index (field 2 = flags). */
  propEntryTypeIdx: number;
  /** Throw a TypeError carrying `message`; `null` when the S3 substrate is absent. */
  throwTypeMsg: ((message: string) => Instr[]) | null;
}

/**
 * ES §10.4.2.2 `ArrayDefineOwnProperty` step 3 — defining an ARRAY INDEX at or
 * beyond the current length is a **TypeError** once the array's own `length`
 * has been made non-writable (`Object.defineProperty(arr, "length",
 * {writable: false})`).
 *
 * The writable bit is already maintained on the companion's `"length"` entry
 * (seeded `{value: len, writable: true, e: false, c: false}`, cleared by the
 * flags-only arm of the ArraySetLength body) — the INDEX path simply never read
 * it, so a frozen-length array happily accepted
 * `Object.defineProperty(arr, arr.length, {value: x})` and grew.
 *
 * A MISSING companion `"length"` entry means the length was never touched and
 * is therefore still writable, so nothing is rejected: this is a pure
 * add-a-throw, never a change to a define that legitimately succeeds today.
 * `i < 0` (a non-index key such as `"foo"`) is unaffected — only array INDICES
 * participate in step 3.
 */
export function nonWritableLengthIndexGuard(
  deps: VecRejectionDeps,
  l: { comp: number; i: number; len: number; entry: number },
): Instr[] {
  const { throwTypeMsg } = deps;
  if (throwTypeMsg === null) return [];
  return [
    { op: "local.get", index: l.i },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "local.get", index: l.i },
    { op: "local.get", index: l.len },
    { op: "i32.ge_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: l.comp },
        { op: "ref.as_non_null" },
        ...deps.lengthLitExtern(),
        { op: "call", funcIdx: deps.objFindIdx },
        { op: "local.tee", index: l.entry },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: l.entry },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: 2 },
            { op: "i32.const", value: FLAG_WRITABLE },
            { op: "i32.and" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: throwTypeMsg("TypeError: Cannot add property, array length is not writable"),
            },
          ],
        },
      ],
    },
  ];
}

/**
 * §10.1.6.3 `ValidateAndApplyPropertyDescriptor` step 2 — a NEW own property
 * cannot be added to a non-extensible object.
 *
 * `Object.preventExtensions(arr)` records the bit for a vec receiver correctly
 * (the #4032 integrity bag; `Object.isExtensible(arr)` reads it back), but the
 * index define validated against the companion `$Object`, which has no
 * extensibility flag of its own — so `Object.defineProperty(sealedArr, 0,
 * {value: 1})` silently succeeded.
 *
 * Only a FRESH index (`i >= vec.length`) is a NEW own property. An in-bounds
 * index is an existing element, and a non-extensible object may still have its
 * existing configurable properties redefined — so the guard must not fire
 * there. `__object_isExtensible_obj` is the KNOWN-OBJECT variant: a vec is an
 * object, and the plain `__object_isExtensible` answers the ES *non-object*
 * rule (`false`) on a `ref.test $Object` miss, which would reject every define
 * on every array.
 *
 * `recvLocalIdx` is the applier's raw `externref` receiver param.
 */
export function nonExtensibleFreshIndexGuard(
  ctx: CodegenContext,
  deps: VecRejectionDeps,
  l: { recvLocalIdx: number; i: number; len: number },
): Instr[] {
  const isExtIdx = ctx.funcMap.get("__object_isExtensible_obj");
  const { throwTypeMsg } = deps;
  if (throwTypeMsg === null || isExtIdx === undefined) return [];
  return [
    { op: "local.get", index: l.i },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "local.get", index: l.i },
    { op: "local.get", index: l.len },
    { op: "i32.ge_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: l.recvLocalIdx },
        { op: "call", funcIdx: isExtIdx },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: throwTypeMsg("TypeError: Cannot define property, object is not extensible"),
        },
      ],
    },
  ];
}
