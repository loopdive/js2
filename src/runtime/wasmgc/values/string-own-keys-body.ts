// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { PRIMITIVE_WRAPPER_DATA_FIELD } from "./primitive-wrapper-layouts.js";

export interface StringKeyOrderBindings {
  readonly propEntryType: number;
  readonly symbolType: number;
  readonly arrayIndex: number;
}
export interface StringOwnKeysBindings extends StringKeyOrderBindings {
  readonly objectType: number;
  readonly stringType: number;
  readonly propMapType: number;
  readonly anyStringType: number;
  readonly listType: number;
  readonly indexKey: number;
  readonly entryBefore: number;
}
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const empty = { kind: "empty" } as const;
function checked<T extends object>(input: T, keys: readonly (keyof T)[]): T {
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).some((key) => !keys.includes(key as keyof T)))
    throw Error("String keys: unknown binding");
  return Object.fromEntries(
    keys.map((key) => {
      const field = fields[key as string];
      const v: unknown = field && Object.hasOwn(field, "value") ? field.value : undefined;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff)
        throw Error("String keys: invalid/non-data binding " + String(key));
      return [key, v];
    }),
  ) as T;
}
const orderKeys = ["propEntryType", "symbolType", "arrayIndex"] as const;
const seqLess = (d: StringKeyOrderBindings): Instr[] => [
  get(0),
  { op: "struct.get", typeIdx: d.propEntryType, fieldIdx: 3 },
  get(1),
  { op: "struct.get", typeIdx: d.propEntryType, fieldIdx: 3 },
  { op: "i32.lt_u" },
];
/** Array indices first, then other strings, then symbols; creation sequence breaks non-index ties. */
export function buildStringKeyOrderDefinition(input: StringKeyOrderBindings): { locals: LocalDef[]; body: Instr[] } {
  const d = checked(input, orderKeys);
  return {
    locals: [
      ...["leftKey", "rightKey"].map((name): LocalDef => ({ name, type: { kind: "anyref" } })),
      ...["leftSymbol", "rightSymbol"].map((name): LocalDef => ({ name, type: { kind: "i32" } })),
      ...["leftIndex", "rightIndex"].map((name): LocalDef => ({ name, type: { kind: "i64" } })),
    ],
    body: [
      get(0),
      { op: "struct.get", typeIdx: d.propEntryType, fieldIdx: 0 },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: d.symbolType },
      set(4),
      get(1),
      { op: "struct.get", typeIdx: d.propEntryType, fieldIdx: 0 },
      { op: "local.tee", index: 3 },
      { op: "ref.test", typeIdx: d.symbolType },
      set(5),
      get(4),
      get(5),
      { op: "i32.ne" },
      { op: "if", blockType: empty, then: [get(5), { op: "return" }] },
      get(4),
      { op: "if", blockType: empty, then: [...seqLess(d), { op: "return" }] },
      get(2),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: d.arrayIndex },
      set(6),
      get(3),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: d.arrayIndex },
      set(7),
      get(6),
      { op: "i64.const", value: 0n },
      { op: "i64.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          get(7),
          { op: "i64.const", value: 0n },
          { op: "i64.ge_s" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [get(6), get(7), { op: "i64.lt_u" }],
            else: [n(1)],
          },
        ],
        else: [
          get(7),
          { op: "i64.const", value: 0n },
          { op: "i64.ge_s" },
          { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: [n(0)], else: seqLess(d) },
        ],
      },
    ],
  };
}
function collect(d: StringOwnKeysBindings): Instr[] {
  return [
    get(0),
    { op: "struct.get", typeIdx: d.objectType, fieldIdx: 1 },
    { op: "local.tee", index: 1 },
    { op: "array.len" },
    { op: "local.tee", index: 2 },
    { op: "array.new_default", typeIdx: d.propMapType },
    set(6),
    n(0),
    set(7),
    n(0),
    set(8),
    {
      op: "block",
      blockType: empty,
      body: [
        {
          op: "loop",
          blockType: empty,
          body: [
            get(8),
            get(2),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            get(1),
            get(8),
            { op: "array.get", typeIdx: d.propMapType },
            { op: "local.tee", index: 3 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: empty,
              then: [
                get(3),
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: d.propEntryType, fieldIdx: 2 },
                n(128),
                { op: "i32.and" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: empty,
                  then: [
                    get(3),
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: d.propEntryType, fieldIdx: 0 },
                    { op: "extern.convert_any" },
                    { op: "call", funcIdx: d.arrayIndex },
                    { op: "local.tee", index: 4 },
                    { op: "i64.const", value: -1n },
                    { op: "i64.eq" },
                    get(4),
                    get(5),
                    { op: "i64.extend_i32_u" },
                    { op: "i64.ge_u" },
                    { op: "i32.or" },
                    {
                      op: "if",
                      blockType: empty,
                      then: [
                        get(6),
                        get(7),
                        get(3),
                        { op: "array.set", typeIdx: d.propMapType },
                        get(7),
                        n(1),
                        { op: "i32.add" },
                        set(7),
                      ],
                    },
                  ],
                },
              ],
            },
            get(8),
            n(1),
            { op: "i32.add" },
            set(8),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}
function sort(d: StringOwnKeysBindings): Instr[] {
  return [
    n(1),
    set(8),
    {
      op: "block",
      blockType: empty,
      body: [
        {
          op: "loop",
          blockType: empty,
          body: [
            get(8),
            get(7),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            get(6),
            get(8),
            { op: "array.get", typeIdx: d.propMapType },
            set(9),
            get(8),
            set(10),
            {
              op: "block",
              blockType: empty,
              body: [
                {
                  op: "loop",
                  blockType: empty,
                  body: [
                    get(10),
                    { op: "i32.eqz" },
                    { op: "br_if", depth: 1 },
                    get(6),
                    get(10),
                    n(1),
                    { op: "i32.sub" },
                    { op: "array.get", typeIdx: d.propMapType },
                    set(11),
                    get(9),
                    { op: "ref.as_non_null" },
                    get(11),
                    { op: "ref.as_non_null" },
                    { op: "call", funcIdx: d.entryBefore },
                    { op: "i32.eqz" },
                    { op: "br_if", depth: 1 },
                    get(6),
                    get(10),
                    get(11),
                    { op: "array.set", typeIdx: d.propMapType },
                    get(10),
                    n(1),
                    { op: "i32.sub" },
                    set(10),
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            get(6),
            get(10),
            get(9),
            { op: "array.set", typeIdx: d.propMapType },
            get(8),
            n(1),
            { op: "i32.add" },
            set(8),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}
function append(d: StringOwnKeysBindings): Instr[] {
  return [
    get(5),
    { op: "i64.extend_i32_u" },
    get(7),
    { op: "i64.extend_i32_u" },
    { op: "i64.add" },
    { op: "local.tee", index: 13 },
    { op: "i64.const", value: 0xffffffffn },
    { op: "i64.gt_u" },
    { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
    get(13),
    { op: "i32.wrap_i64" },
    { op: "array.new_default", typeIdx: d.listType },
    set(12),
    n(0),
    set(8),
    {
      op: "block",
      blockType: empty,
      body: [
        {
          op: "loop",
          blockType: empty,
          body: [
            get(8),
            get(5),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            get(12),
            get(8),
            get(8),
            { op: "call", funcIdx: d.indexKey },
            { op: "array.set", typeIdx: d.listType },
            get(8),
            n(1),
            { op: "i32.add" },
            set(8),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    n(0),
    set(8),
    {
      op: "block",
      blockType: empty,
      body: [
        {
          op: "loop",
          blockType: empty,
          body: [
            get(8),
            get(7),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            get(12),
            get(5),
            get(8),
            { op: "i32.add" },
            get(6),
            get(8),
            { op: "array.get", typeIdx: d.propMapType },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: d.propEntryType, fieldIdx: 0 },
            { op: "extern.convert_any" },
            { op: "array.set", typeIdx: d.listType },
            get(8),
            n(1),
            { op: "i32.add" },
            set(8),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    get(12),
  ];
}
/** Complete String [[OwnPropertyKeys]]; only the newly allocated scratch/list are written. */
export function buildStringOwnKeysDefinition(input: StringOwnKeysBindings): { locals: LocalDef[]; body: Instr[] } {
  const d = checked(input, [
    ...orderKeys,
    "objectType",
    "stringType",
    "propMapType",
    "anyStringType",
    "listType",
    "indexKey",
    "entryBefore",
  ]);
  const local = (name: string, type: LocalDef["type"]): LocalDef => ({ name, type });
  return {
    locals: [
      local("source", { kind: "ref", typeIdx: d.propMapType }),
      local("capacity", { kind: "i32" }),
      local("entry", { kind: "ref_null", typeIdx: d.propEntryType }),
      local("index", { kind: "i64" }),
      local("length", { kind: "i32" }),
      local("scratch", { kind: "ref", typeIdx: d.propMapType }),
      local("count", { kind: "i32" }),
      local("cursor", { kind: "i32" }),
      local("candidate", { kind: "ref_null", typeIdx: d.propEntryType }),
      local("position", { kind: "i32" }),
      local("previous", { kind: "ref_null", typeIdx: d.propEntryType }),
      local("result", { kind: "ref", typeIdx: d.listType }),
      local("total", { kind: "i64" }),
    ],
    body: [
      get(0),
      { op: "struct.get", typeIdx: d.stringType, fieldIdx: PRIMITIVE_WRAPPER_DATA_FIELD },
      { op: "struct.get", typeIdx: d.anyStringType, fieldIdx: 0 },
      set(5),
      ...collect(d),
      ...sort(d),
      ...append(d),
    ],
  };
}
