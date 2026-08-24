// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4492 wave-5) `__to_primitive`'s two `[[PrimitiveValue]]` arms.
 *
 * Lives outside `object-runtime.ts` because that file is a god-file under the
 * #3102 LOC gate and `ensureObjectRuntime` is under the #3400 function gate —
 * "add code to the subsystem module, not the barrel/driver". Every index and
 * constant arrives through {@link ToPrimitiveSlotDeps}, so there is no import
 * back into `object-runtime.ts` and therefore no ESM cycle (contrast
 * `native-proto-instance-method-read.ts`, which duplicates
 * `WRAPPER_PRIMITIVE_KEY` for the same reason).
 */
import type { Instr } from "../ir/types.js";

/** What both arms need from `__to_primitive`'s frame. */
export interface ToPrimitiveSlotDeps {
  /** local holding `any.convert_extern(input)`, already `ref.test`-ed `$Object`. */
  readonly anyLocal: number;
  /** `ref null $PropEntry` scratch. */
  readonly slotLocal: number;
  readonly objectTypeIdx: number;
  readonly propEntryTypeIdx: number;
  readonly objFindIdx: number;
  /** `WRAPPER_PRIMITIVE_KEY` (object-runtime.ts), passed in to avoid a cycle. */
  readonly wrapperPrimitiveKey: string;
  /** `FLAG_INTERNAL` (object-runtime.ts), same reason. */
  readonly flagInternal: number;
  /** Interns a string constant and pushes it as an externref. */
  readonly stringExtern: (value: string) => Instr[];
}

/**
 * #1910/#1472 S2 — read the boxed wrapper's `[[PrimitiveValue]]` internal slot
 * and RETURN it when present. A `new Number`/`new String`/`new Boolean` wrapper
 * carries its primitive in that reserved FLAG_INTERNAL own-slot; §7.1.1.1's
 * intrinsic `valueOf`/`toString` return exactly that, so the caller can skip the
 * method walk and apply its hint's final ToNumber/ToString directly. A plain
 * object has no such slot (`__obj_find` null ⇒ fall through, nothing emitted).
 *
 * (#4492 wave-5) `__to_primitive` emits this in TWO places, and both are
 * load-bearing:
 *
 *  - BEFORE the walk, gated on {@link buildOwnToPrimitiveOverridePresent} being
 *    false. Unconditional, it made the wrapper's OWN method unreachable for
 *    every ToPrimitive consumer at once (`==`, `+`, `String`, relational):
 *    `var s = new String("ABCABC"); s.valueOf = function(){ return "ed" };
 *    s == "ed"` measured FALSE on campaign HEAD `c42bdbe3e`. §7.1.1.1 reads
 *    `Get(O, …)`, and an own slot wins over `String.prototype.valueOf`.
 *  - AFTER the walk, ungated: an own method that returns a NON-primitive must
 *    still fall back to the intrinsic slot value rather than reach the
 *    §7.1.1.1 step-6 TypeError — which is what the real
 *    `String.prototype.valueOf` would have produced further up the chain.
 *
 * A wrapper with no override therefore keeps its previous answer for one extra
 * `$Object` hash probe per operand, and a plain object is untouched.
 *
 * Each call builds FRESH `Instr` objects: aliasing one array into two tree
 * positions double-shifts the `funcIdx` fields inside it when a post-codegen
 * pass walks the tree (the #1448 corruption class).
 */
export function buildWrapperSlotShortCircuit(d: ToPrimitiveSlotDeps): Instr[] {
  return [
    { op: "local.get", index: d.anyLocal },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    ...d.stringExtern(d.wrapperPrimitiveKey),
    { op: "call", funcIdx: d.objFindIdx },
    { op: "local.tee", index: d.slotLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // entry present — confirm it is the internal slot (FLAG_INTERNAL), then
        // return extern.convert_any(entry.value).
        { op: "local.get", index: d.slotLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 2 }, // flags
        { op: "i32.const", value: d.flagInternal },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: d.slotLocal },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 1 }, // value (anyref)
            { op: "extern.convert_any" },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/** i32: does this `$Object` carry an OWN `valueOf` or `toString` slot? */
export function buildOwnToPrimitiveOverridePresent(d: ToPrimitiveSlotDeps): Instr[] {
  const ownSlotPresent = (name: string): Instr[] => [
    { op: "local.get", index: d.anyLocal },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    ...d.stringExtern(name),
    { op: "call", funcIdx: d.objFindIdx },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
  ];
  return [...ownSlotPresent("valueOf"), ...ownSlotPresent("toString"), { op: "i32.or" }];
}
