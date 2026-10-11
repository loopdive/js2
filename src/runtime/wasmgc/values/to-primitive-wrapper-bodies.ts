// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
export interface ToPrimitiveSlotBindings {
  readonly anyLocal: number;
  readonly slotLocal: number;
  readonly objectTypeIdx: number;
  readonly propEntryTypeIdx: number;
  readonly objFindIdx: number;
  readonly flagInternal: number;
}

/** A selected implicit intrinsic, after real Get/HasProperty and prototype checks. */
export type ToPrimitiveWrapperIntrinsic =
  | { readonly kind: "valueOf"; readonly primitiveKey: readonly Instr[] }
  | { readonly kind: "toString"; readonly primitiveKey: readonly Instr[]; readonly stringifyIdx: number };

/**
 * An internal primitive slot supplies the intrinsic at THIS ordinary-method
 * position only. Own/inherited nullish or noncallable properties still shadow
 * it. A missing valueOf returns the primitive; a missing toString must return
 * its string conversion, so the caller cannot accidentally select numeric +.
 */
export function buildWrapperIntrinsicResult(d: ToPrimitiveSlotBindings, binding: ToPrimitiveWrapperIntrinsic): Instr[] {
  return [
    // A replaced explicit prototype chain no longer implies this wrapper's
    // intrinsic prototype. Its real inherited methods keep their precedence.
    { op: "local.get", index: d.anyLocal },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: d.anyLocal },
        { op: "ref.cast", typeIdx: d.objectTypeIdx },
        ...structuredClone([...binding.primitiveKey]),
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
                ...(binding.kind === "toString"
                  ? ([{ op: "call", funcIdx: binding.stringifyIdx }] satisfies Instr[])
                  : []),
                { op: "return" },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** Complete ordinary-table observation; no generic has/get dispatch or getters. */
export interface ToPrimitivePresenceBindings {
  readonly anyLocal: number;
  readonly cursorLocal: number;
  readonly presentLocal: number;
  readonly objectTypeIdx: number;
  readonly objFindIdx: number;
  readonly implicitProtoIdx: number;
  readonly companion: { readonly kind: "absent" } | { readonly kind: "call"; readonly hasIdx: number };
}

export function buildWrapperMethodPresence(d: ToPrimitivePresenceBindings, key: readonly Instr[]): Instr[] {
  return [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: d.presentLocal },
    { op: "local.get", index: d.anyLocal },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    { op: "local.set", index: d.cursorLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: d.cursorLocal },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: d.cursorLocal },
            { op: "ref.as_non_null" },
            ...structuredClone([...key]),
            { op: "call", funcIdx: d.objFindIdx },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            { op: "local.tee", index: d.presentLocal },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: d.cursorLocal },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 0 },
            { op: "local.set", index: d.cursorLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...(d.companion.kind === "absent"
      ? []
      : ([
          { op: "local.get", index: d.presentLocal },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: d.anyLocal },
              { op: "ref.cast", typeIdx: d.objectTypeIdx },
              { op: "call", funcIdx: d.implicitProtoIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  ...structuredClone([...key]),
                  { op: "call", funcIdx: d.companion.hasIdx },
                  { op: "local.set", index: d.presentLocal },
                ],
              },
            ],
          },
        ] satisfies Instr[])),
  ];
}
