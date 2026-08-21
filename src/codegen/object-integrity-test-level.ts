// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T2) `TestIntegrityLevel(O, level)` — §7.3.15 — as a runtime
 * derivation over a `$Object`'s own-property table.
 *
 * ## Why a derivation and not a flag
 *
 * `__object_isFrozen` / `__object_isSealed` (object-integrity-carrier.ts) read
 * ONE bit off `$Object.flags`, and that bit is written only by
 * `Object.freeze` / `Object.seal`. But §20.1.2.16 / §20.1.2.18 do not ask "was
 * freeze called"; they ask a QUESTION ABOUT THE CURRENT SHAPE:
 *
 * > 1. If IsExtensible(O) is true, return false.
 * > 2. For each own property key P: if desc.[[Configurable]] is true, return
 * >    false; if level is frozen and desc is a data descriptor whose
 * >    [[Writable]] is true, return false.
 * > 3. Return true.
 *
 * With zero own properties step 2 is vacuous, so a merely NON-EXTENSIBLE object
 * is frozen and sealed. Measured on this branch before the fix:
 *
 * ```js
 * var child = new (function () {})();
 * Object.preventExtensions(child);
 * Object.isFrozen(child)   // was false, spec says true
 * ```
 *
 * The same shape is what `built-ins/Object/isFrozen/15.2.3.12-2-{1,2}` assert
 * (an inherited data / accessor property must not be considered), and
 * `…/15.2.3.12-3-28` adds the per-property half: a non-configurable
 * non-writable data property plus a non-configurable ACCESSOR is still frozen.
 *
 * ## Placement: the direct `$Object` arm only
 *
 * The predicate has two arms — a direct `$Object` receiver, and the #4032
 * integrity BAG that gives non-`$Object` carriers (arrays, closures, typed
 * structs) somewhere to keep their flags. The derivation is correct only on the
 * first: a bag holds the carrier's EXPANDO properties, never its elements, so
 * deriving over an array's bag would call `Object.preventExtensions([1, 2])`
 * frozen when its two writable elements say otherwise. The bag arm therefore
 * keeps its flag read verbatim.
 *
 * `$Proxy` is a standalone struct, NOT a `$Object` subtype (object-runtime.ts),
 * so a proxy never reaches this arm and needs no exclusion.
 *
 * ## Additive by construction
 *
 * The derivation runs only where the level's flag bit is CLEAR — a flagged
 * object still answers `true` from the bit. So no receiver that answers `true`
 * today can start answering `false`; the change can only turn a spec-wrong
 * `false` into `true`.
 *
 * Internal slots (`[[PrimitiveValue]]`) and tombstoned (deleted) entries are
 * skipped: neither is an own property for §7.3.15's purposes.
 */
import type { Instr, ValType } from "../ir/types.js";

/** `$PropEntry.$flags` field index (object-runtime.ts layout). */
const ENTRY_FLAGS = 2;
/**
 * MUST equal `FLAG_INTERNAL` / `FLAG_TOMBSTONE` in object-runtime.ts. Restated
 * rather than imported: `object-runtime-descriptors.ts` (this module's caller)
 * deliberately does not import `object-runtime.ts`, and neither does the rest of
 * the integrity-carrier cluster. Same convention as
 * `native-proto-instance-method-read.ts`'s `WRAPPER_PRIMITIVE_KEY`.
 */
const FLAG_INTERNAL = 0x10;
const FLAG_TOMBSTONE = 0x80;
/** `$Object` field indices: 1 = own-property table, 4 = object-level flags. */
const OBJ_PROPS = 1;
const OBJ_FLAGS = 4;

/** The locals `buildIntegrityDerivation` needs, appended after the caller's. */
export function integrityDerivationLocals(
  propMapRef: ValType,
  entryRefNull: ValType,
): { name: string; type: ValType }[] {
  return [
    { name: "tilProps", type: propMapRef },
    { name: "tilCap", type: { kind: "i32" } },
    { name: "tilIdx", type: { kind: "i32" } },
    { name: "tilEntry", type: entryRefNull },
    { name: "tilRes", type: { kind: "i32" } },
  ];
}

/**
 * Instructions leaving one i32 (0/1) on the stack: `TestIntegrityLevel(O,
 * level)` for the `$Object` in `objLocal` (an anyref local the caller has
 * already proven with `ref.test $Object`).
 *
 * `frozen` selects the level: `true` also rejects a writable DATA property,
 * `false` (sealed) asks about configurability alone.
 *
 * Written as a single accumulator local rather than an early `br` out of the
 * loop with a value: the loop is bounded by the table's capacity and the extra
 * iterations cost nothing measurable, while a value-carrying branch across two
 * block depths is the shape most likely to be mis-encoded.
 */
export function buildIntegrityDerivation(args: {
  objectTypeIdx: number;
  propMapTypeIdx: number;
  propEntryTypeIdx: number;
  objLocal: number;
  /** First index of the five locals from {@link integrityDerivationLocals}. */
  localBase: number;
  frozen: boolean;
  nonExtensibleBit: number;
  flagWritable: number;
  flagConfigurable: number;
  flagAccessor: number;
}): Instr[] {
  const {
    objectTypeIdx,
    propMapTypeIdx,
    propEntryTypeIdx,
    objLocal,
    localBase,
    frozen,
    nonExtensibleBit,
    flagWritable,
    flagConfigurable,
    flagAccessor,
  } = args;
  const props = localBase;
  const cap = localBase + 1;
  const idx = localBase + 2;
  const entry = localBase + 3;
  const res = localBase + 4;

  /** `<entry>.flags` — a factory, never a shared array (double-remap hazard). */
  const entryFlags = (): Instr[] => [
    { op: "local.get", index: entry },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
  ];

  /** `res = 0` — this property disqualifies the level. */
  const reject: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: res },
  ];

  // §7.3.15 step 2: configurable ⇒ not sealed and not frozen.
  const perProperty: Instr[] = [
    ...entryFlags(),
    { op: "i32.const", value: flagConfigurable },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: [...reject] },
  ];
  if (frozen) {
    // …and, for `frozen`, a DATA property (not an accessor) that is writable.
    perProperty.push(
      ...entryFlags(),
      { op: "i32.const", value: flagAccessor },
      { op: "i32.and" },
      { op: "i32.eqz" },
      ...entryFlags(),
      { op: "i32.const", value: flagWritable },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "i32.and" },
      { op: "if", blockType: { kind: "empty" }, then: [...reject] },
    );
  }

  const walk: Instr[] = [
    { op: "local.get", index: objLocal },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: OBJ_PROPS },
    { op: "local.tee", index: props },
    { op: "array.len" },
    { op: "local.set", index: cap },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: idx },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: idx },
            { op: "local.get", index: cap },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: props },
            { op: "local.get", index: idx },
            { op: "array.get", typeIdx: propMapTypeIdx },
            { op: "local.tee", index: entry },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [],
              else: [
                // An internal slot / a tombstoned (deleted) entry is not an own
                // property — §7.3.15 iterates OwnPropertyKeys, which excludes both.
                ...entryFlags(),
                { op: "i32.const", value: FLAG_INTERNAL | FLAG_TOMBSTONE },
                { op: "i32.and" },
                { op: "i32.eqz" },
                { op: "if", blockType: { kind: "empty" }, then: perProperty },
              ],
            },
            { op: "local.get", index: idx },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: idx },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  return [
    { op: "i32.const", value: 1 },
    { op: "local.set", index: res },
    // §7.3.15 step 1 — an extensible object is neither sealed nor frozen.
    { op: "local.get", index: objLocal },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: OBJ_FLAGS },
    { op: "i32.const", value: nonExtensibleBit },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: walk,
      else: [...reject],
    },
    { op: "local.get", index: res },
  ];
}
