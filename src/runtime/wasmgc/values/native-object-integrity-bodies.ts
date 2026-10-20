// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import type { MixedObjectAccessOperands, MixedObjectDefinition } from "./mixed-object-access-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as bits } from "./ordinary-object-descriptor-common.js";
import { CLOSURE_BAG_FIELD_IDX } from "./closure-layouts.js";

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const when = (then: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then });

/** Own storage only. A selected intrinsic population must be actually ready;
 * unjoined intrinsic/source populations are never treated as empty ordinary bags.
 */
export function buildNativeIntegrityStorageDefinition(
  d: MixedObjectAccessOperands,
  intrinsicPopulationState?: number,
): MixedObjectDefinition {
  const missing = (status: number): Instr[] => [
    n(status),
    { op: "ref.null", typeIdx: d.objectTypeIdx },
    { op: "return" },
  ];
  const ordinary = (): Instr[] => [
    n(1),
    get(0),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    { op: "return" },
  ];
  const intrinsic = (typeIdx: number, callable: boolean): Instr[] => {
    if (intrinsicPopulationState === undefined) return missing(2);
    return [
      { op: "global.get", index: intrinsicPopulationState },
      n(2),
      { op: "i32.ne" },
      when(missing(2)),
      ...(callable
        ? [
            get(0),
            { op: "any.convert_extern" } as Instr,
            { op: "ref.cast", typeIdx } as Instr,
            { op: "struct.get", typeIdx, fieldIdx: CLOSURE_BAG_FIELD_IDX } as Instr,
            set(2),
            get(2),
            { op: "ref.is_null" } as Instr,
            when(missing(2)),
            get(2),
            { op: "any.convert_extern" } as Instr,
            { op: "ref.test", typeIdx: d.objectTypeIdx } as Instr,
            { op: "i32.eqz" } as Instr,
            when(missing(3)),
            n(1),
            get(2),
            { op: "any.convert_extern" } as Instr,
            { op: "ref.cast", typeIdx: d.objectTypeIdx } as Instr,
            { op: "return" } as Instr,
          ]
        : ordinary()),
    ];
  };
  return {
    locals: [
      { name: "family", type: { kind: "i32" } },
      ...(intrinsicPopulationState === undefined ? [] : [{ name: "bag", type: { kind: "externref" as const } }]),
    ],
    body: [
      get(0),
      { op: "call", funcIdx: d.classify },
      { op: "local.tee", index: 1 },
      n(-2),
      { op: "i32.eq" },
      when(missing(2)),
      get(1),
      n(0),
      { op: "i32.le_s" },
      when(missing(3)),
      ...d.carriers.flatMap((c, index): Instr[] => [
        get(1),
        n(index + 1),
        { op: "i32.eq" },
        when(
          c.kind === "source"
            ? missing(2)
            : c.kind === "native" || c.kind === "object-prototype"
              ? intrinsic(c.typeIdx, c.kind === "native")
              : ordinary(),
        ),
      ]),
      { op: "unreachable" },
    ],
  };
}

export interface NativeIntegrityOperands {
  readonly objectTypeIdx: number;
  readonly mapTypeIdx: number;
  readonly entryTypeIdx: number;
  readonly storage: FuncHandle;
}
/** Internal status/Boolean ABI: false=0,true=1,unready=2,unsupported=3.
 * Native storage has no proxy/accessor callbacks during own-key enumeration.
 * String virtual index descriptors are already non-writable/non-configurable.
 */
export function buildNativeIntegrityDefinition(
  d: NativeIntegrityOperands,
  mutate: boolean,
  frozen: boolean,
): MixedObjectDefinition {
  const bag = (): Instr[] => [get(1), { op: "ref.as_non_null" }];
  const entry = (): Instr[] => [get(5), { op: "ref.as_non_null" }];
  const readFlags = (): Instr[] => [...bag(), { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 4 }];
  const removeWritable: Instr[] = frozen
    ? [
        get(6),
        n(bits.accessor),
        { op: "i32.and" },
        { op: "i32.eqz" },
        when([get(6), n(~bits.writable), { op: "i32.and" }, set(6)]),
      ]
    : [];
  const writableData: Instr[] = frozen
    ? [
        get(6),
        n(bits.accessor),
        { op: "i32.and" },
        { op: "i32.eqz" },
        get(6),
        n(bits.writable),
        { op: "i32.and" },
        n(0),
        { op: "i32.ne" },
        { op: "i32.and" },
        { op: "i32.or" },
      ]
    : [];
  const update = (): Instr[] => [
    ...entry(),
    get(6),
    n(~bits.configurable),
    { op: "i32.and" },
    set(6),
    ...removeWritable,
    get(6),
    { op: "struct.set", typeIdx: d.entryTypeIdx, fieldIdx: 2 },
  ];
  const check = (): Instr[] => [
    get(6),
    n(bits.configurable),
    { op: "i32.and" },
    ...writableData,
    when([n(0), { op: "return" }]),
  ];
  const visit: Instr[] = [
    get(3),
    get(4),
    { op: "array.get", typeIdx: d.mapTypeIdx },
    set(5),
    get(5),
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    when([
      ...entry(),
      { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: 2 },
      set(6),
      get(6),
      n(bits.tombstone),
      { op: "i32.and" },
      { op: "i32.eqz" },
      when(mutate ? update() : check()),
    ]),
  ];
  return {
    locals: [
      { name: "bag", type: { kind: "ref_null", typeIdx: d.objectTypeIdx } },
      { name: "status", type: { kind: "i32" } },
      { name: "map", type: { kind: "ref", typeIdx: d.mapTypeIdx } },
      { name: "cursor", type: { kind: "i32" } },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "flags", type: { kind: "i32" } },
    ],
    body: [
      get(0),
      { op: "call", funcIdx: d.storage },
      set(1),
      set(2),
      get(2),
      n(1),
      { op: "i32.ne" },
      when([get(2), { op: "return" }]),
      ...(mutate
        ? [
            ...bag(),
            ...readFlags(),
            n(bits.nonExtensible),
            { op: "i32.or" } as Instr,
            { op: "struct.set", typeIdx: d.objectTypeIdx, fieldIdx: 4 } as Instr,
          ]
        : [
            ...readFlags(),
            n(bits.nonExtensible),
            { op: "i32.and" } as Instr,
            { op: "i32.eqz" } as Instr,
            when([n(0), { op: "return" }]),
          ]),
      ...bag(),
      { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 1 },
      set(3),
      n(0),
      set(4),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              get(4),
              get(3),
              { op: "array.len" },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              ...visit,
              get(4),
              n(1),
              { op: "i32.add" },
              set(4),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      ...(mutate
        ? [
            ...bag(),
            ...readFlags(),
            n(bits.sealed | (frozen ? bits.frozen : 0)),
            { op: "i32.or" } as Instr,
            { op: "struct.set", typeIdx: d.objectTypeIdx, fieldIdx: 4 } as Instr,
          ]
        : []),
      n(1),
    ],
  };
}
