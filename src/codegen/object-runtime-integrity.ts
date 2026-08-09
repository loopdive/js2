// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Object-integrity mutation providers extracted from the descriptor registry.
 *
 * The caller invokes this once at the original registration point, preserving
 * the exact native-function minting order. Seal/freeze update both the object
 * flags and every live property-entry descriptor flag.
 */
import type { Instr, ValType } from "../ir/types.js";

interface ObjectIntegrityMutationState {
  registerNative: (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => number;
  objectTypeIdx: number;
  propMapTypeIdx: number;
  propEntryTypeIdx: number;
  objRefNull: ValType;
  propMapRef: ValType;
  entryRefNull: ValType;
  FLAG_WRITABLE: number;
  FLAG_CONFIGURABLE: number;
  OBJ_FLAG_NONEXTENSIBLE: number;
  OBJ_FLAG_SEALED: number;
  OBJ_FLAG_FROZEN: number;
  /**
   * (#4032) `__integrity_bag(externref) -> externref` — the per-carrier
   * own-property bag (`$Object`) that holds the `[[Extensible]]`/sealed/frozen
   * slot for an Array/closure receiver. `undefined` in host mode (the bag
   * substrates are standalone/wasi-only), which keeps the emitted body
   * byte-identical there.
   */
  integrityBagIdx: number | undefined;
}

function entryFlagClearInstrs(
  objectTypeIdx: number,
  propMapTypeIdx: number,
  propEntryTypeIdx: number,
  entryClearMask: number,
): Instr[] {
  if (entryClearMask === 0) return [];
  return [
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
    { op: "local.tee", index: 3 },
    { op: "array.len" },
    { op: "local.set", index: 4 },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 5 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 5 },
            { op: "local.get", index: 4 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 3 },
            { op: "local.get", index: 5 },
            { op: "array.get", typeIdx: propMapTypeIdx },
            { op: "local.tee", index: 6 },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [],
              else: [
                { op: "local.get", index: 6 },
                { op: "ref.as_non_null" },
                { op: "local.get", index: 6 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                { op: "i32.const", value: ~entryClearMask },
                { op: "i32.and" },
                { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              ],
            },
            { op: "local.get", index: 5 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 5 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

export function buildObjectIntegrityMutationHelpers(s: ObjectIntegrityMutationState): void {
  const {
    registerNative,
    objectTypeIdx,
    propMapTypeIdx,
    propEntryTypeIdx,
    objRefNull,
    propMapRef,
    entryRefNull,
    FLAG_WRITABLE,
    FLAG_CONFIGURABLE,
    OBJ_FLAG_NONEXTENSIBLE,
    OBJ_FLAG_SEALED,
    OBJ_FLAG_FROZEN,
    integrityBagIdx,
  } = s;

  const emitSetFlags = (name: string, bits: number, entryClearMask: number): void => {
    // A FACTORY, never a shared array: the same instruction sequence is spliced
    // into two arms of the same body, and aliasing one `Instr[]` into both makes
    // the finalize walks remap it twice (see
    // reference_shared_instr_object_dce_double_remap).
    const setFlagsOnLocal1 = (): Instr[] => [
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: bits },
      { op: "i32.or" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 4 },
      ...entryFlagClearInstrs(objectTypeIdx, propMapTypeIdx, propEntryTypeIdx, entryClearMask),
    ];
    // (#4032) Non-`$Object` receiver (Array `__vec_*`, closure struct, …): route
    // the integrity bits into the carrier's own-property bag, which IS a
    // `$Object` and therefore owns a real flags slot. Without this the mutators
    // were a silent no-op for every non-`$Object` carrier — which is why the
    // matching predicates had to be *wrong in the pristine direction* to make
    // `Object.freeze(arr); Object.isFrozen(arr)` look right. `integrityBagIdx`
    // is undefined in host mode, restoring the previous body byte-for-byte.
    const bagArm: Instr[] =
      integrityBagIdx === undefined
        ? []
        : [
            {
              op: "if",
              blockType: { kind: "empty" },
              then: setFlagsOnLocal1(),
              else: [
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: integrityBagIdx },
                { op: "any.convert_extern" },
                { op: "local.tee", index: 1 },
                { op: "ref.test", typeIdx: objectTypeIdx },
                { op: "if", blockType: { kind: "empty" }, then: setFlagsOnLocal1() },
              ],
            },
          ];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      ...(bagArm.length > 0
        ? bagArm
        : ([
            {
              op: "if",
              blockType: { kind: "empty" },
              then: setFlagsOnLocal1(),
            },
          ] satisfies Instr[])),
      { op: "local.get", index: 0 },
    ];
    registerNative(
      name,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "props", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  };

  emitSetFlags("__object_preventExtensions", OBJ_FLAG_NONEXTENSIBLE, 0);
  emitSetFlags("__object_seal", OBJ_FLAG_NONEXTENSIBLE | OBJ_FLAG_SEALED, FLAG_CONFIGURABLE);
  emitSetFlags(
    "__object_freeze",
    OBJ_FLAG_NONEXTENSIBLE | OBJ_FLAG_SEALED | OBJ_FLAG_FROZEN,
    FLAG_WRITABLE | FLAG_CONFIGURABLE,
  );
}
