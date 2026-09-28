// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, GlobalHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";

/** Existing $PropEntry/$Object encoding; these bits are not descriptor presence bits. */
export const ORDINARY_OBJECT_READ_ENCODING = Object.freeze({ accessor: 0x08, tombstone: 0x80, nullPrototype: 0x80 });
/** The public Get/Has join must resolve NeedsImplicitPrototype with its actual companion owner. */
export const ORDINARY_OBJECT_READ_STATUS = Object.freeze({ absent: 0, present: 1, needsImplicitPrototype: 2 });

export interface OrdinaryObjectLookupBindings {
  readonly objectTypeIdx: TypeHandle;
  readonly propEntryTypeIdx: TypeHandle;
  readonly findOwnIdx: FuncHandle;
}

/**
 * (ref Object, canonical PropertyKey) -> (status, nullable entry).
 * The key is already String or Symbol. This function does not perform ToPropertyKey.
 * Per-call locals preserve presence across reentrant getters in the separate Get body.
 */
export function buildOrdinaryObjectLookupDefinition(d: OrdinaryObjectLookupBindings): {
  locals: LocalDef[];
  body: Instr[];
} {
  return {
    locals: [
      { name: "cursor", type: { kind: "ref_null", typeIdx: d.objectTypeIdx } },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
      { name: "next", type: { kind: "ref_null", typeIdx: d.objectTypeIdx } },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.set", index: 2 },
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: 2 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: d.findOwnIdx },
          { op: "local.tee", index: 3 },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: ORDINARY_OBJECT_READ_STATUS.present },
              { op: "local.get", index: 3 },
              { op: "return" },
            ],
          },
          { op: "local.get", index: 2 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 0 },
          { op: "local.tee", index: 4 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // Only the final actual prototype node decides whether its null
              // link represents explicit null or the omitted implicit terminal.
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
              { op: "i32.const", value: ORDINARY_OBJECT_READ_ENCODING.nullPrototype },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "i32.const", value: ORDINARY_OBJECT_READ_STATUS.absent }],
                else: [{ op: "i32.const", value: ORDINARY_OBJECT_READ_STATUS.needsImplicitPrototype }],
              },
              { op: "ref.null", typeIdx: d.propEntryTypeIdx },
              { op: "return" },
            ],
          },
          { op: "local.get", index: 4 },
          { op: "local.set", index: 2 },
          { op: "br", depth: 0 },
        ],
      },
      { op: "unreachable" },
    ],
  };
}

/** Has never reads the value slot and never invokes a getter. */
export function buildOrdinaryObjectHasDefinition(lookupIdx: FuncHandle): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: lookupIdx },
      { op: "drop" }, // nullable entry; the status remains on the stack
    ],
  };
}

export interface OrdinaryObjectGetBindings {
  readonly propEntryTypeIdx: TypeHandle;
  readonly lookupIdx: FuncHandle;
  readonly getterDispatchIdx: FuncHandle;
  readonly undefinedGlobalIdx: GlobalHandle;
}
function undefinedValue(index: GlobalHandle): Instr[] {
  return [{ op: "global.get", index }, { op: "extern.convert_any" }];
}

/**
 * (ref Object, canonical PropertyKey, original receiver externref) -> (status, value).
 * A non-present status is internal: its undefined operand is not a public miss answer.
 * method0 owns real callable selection, declared-arity padding and receiver restoration.
 */
export function buildOrdinaryObjectGetDefinition(d: OrdinaryObjectGetBindings): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [
      { name: "entry", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
      { name: "status", type: { kind: "i32" } },
      { name: "getter", type: { kind: "anyref" } },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.lookupIdx },
      { op: "local.set", index: 3 },
      { op: "local.tee", index: 4 },
      { op: "i32.const", value: ORDINARY_OBJECT_READ_STATUS.present },
      { op: "i32.ne" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 4 }, ...undefinedValue(d.undefinedGlobalIdx), { op: "return" }],
      },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: ORDINARY_OBJECT_READ_ENCODING.accessor },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 4 },
          { op: "local.tee", index: 5 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: ORDINARY_OBJECT_READ_STATUS.present },
              ...undefinedValue(d.undefinedGlobalIdx),
              { op: "return" },
            ],
          },
          { op: "i32.const", value: ORDINARY_OBJECT_READ_STATUS.present },
          { op: "local.get", index: 2 },
          { op: "local.get", index: 5 },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: d.getterDispatchIdx },
          { op: "return" },
        ],
      },
      { op: "i32.const", value: ORDINARY_OBJECT_READ_STATUS.present },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 1 },
      { op: "extern.convert_any" },
    ],
  };
}
