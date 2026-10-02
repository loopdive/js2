// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, FuncHandle } from "../../../wasm/model/instructions.js";
import {
  builtinFailure,
  builtinUndefined,
  type BuiltinFunctionBodyOperands,
  type BuiltinFunctionDefinition,
} from "./builtin-function-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";

export interface BuiltinFunctionPropertyOperands extends BuiltinFunctionBodyOperands {
  readonly entryTypeIdx: number;
  readonly mapTypeIdx: number;
  readonly findOrdinary: FuncHandle;
  readonly findOwn: FuncHandle;
  readonly defineData: FuncHandle;
  readonly defineAccessor: FuncHandle;
  readonly keyBefore: FuncHandle;
  readonly writeOwn: FuncHandle;
}
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const empty = { kind: "empty" } as const;
const nonnull = (index: number): Instr[] => [get(index), { op: "ref.as_non_null" }];
function bag(d: BuiltinFunctionPropertyOperands): Instr[] {
  return [get(0), call(d.bag), { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: d.objectTypeIdx }];
}
function entryField(d: BuiltinFunctionPropertyOperands, local: number, fieldIdx: number): Instr[] {
  return [...nonnull(local), { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx }];
}
export function buildBuiltinFunctionFindOwn(d: BuiltinFunctionPropertyOperands): BuiltinFunctionDefinition {
  return { locals: [], body: [...bag(d), get(1), call(d.findOrdinary)] };
}
export function buildBuiltinFunctionHasOwn(d: BuiltinFunctionPropertyOperands): BuiltinFunctionDefinition {
  return { locals: [], body: [get(0), get(1), call(d.findOwn), { op: "ref.is_null" }, { op: "i32.eqz" }] };
}
/** Returns the logical target, never its implementation bag. */
export function buildBuiltinFunctionDefine(
  d: BuiltinFunctionPropertyOperands,
  kind: "data" | "accessor" | "attributes",
): BuiltinFunctionDefinition {
  const count = kind === "accessor" ? 5 : kind === "data" ? 4 : 3;
  return {
    locals: [],
    body: [
      get(0),
      call(d.bag),
      ...Array.from({ length: count - 1 }, (_, index) => get(index + 1)),
      call(kind === "data" ? d.defineData : kind === "accessor" ? d.defineAccessor : d.defineAttributes),
      get(0),
    ],
  };
}
/** Internal status/value ABI: 3 explicitly means a getter needs a mixed callable owner. */
export function buildBuiltinFunctionGetOwn(d: BuiltinFunctionPropertyOperands): BuiltinFunctionDefinition {
  return {
    locals: [
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "getter", type: { kind: "externref" } },
    ],
    body: [
      get(0),
      get(1),
      call(d.findOwn),
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      { op: "if", blockType: empty, then: [n(0), ...builtinUndefined(d), { op: "return" }] },
      ...buildBuiltinFunctionEntryGet(d, 3, 2, 4),
    ],
  };
}
/** A live entry stops the search, even for undefined data or a getter-less accessor. */
export function buildBuiltinFunctionEntryGet(
  d: BuiltinFunctionPropertyOperands,
  entry: number,
  receiver: number,
  getter: number,
): Instr[] {
  return [
    ...entryField(d, entry, 2),
    n(flags.accessor),
    { op: "i32.and" },
    {
      op: "if",
      blockType: empty,
      then: [
        ...entryField(d, entry, 4),
        { op: "extern.convert_any" },
        { op: "local.tee", index: getter },
        { op: "ref.is_null" },
        { op: "if", blockType: empty, then: [n(1), ...builtinUndefined(d), { op: "return" }] },
        get(getter),
        call(d.match),
        { op: "i32.eqz" },
        { op: "if", blockType: empty, then: [n(3), ...builtinUndefined(d), { op: "return" }] },
        n(1),
        get(getter),
        get(receiver),
        call(d.newVector),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: d.vectorTypeIdx },
        call(d.callVector),
        { op: "return" },
      ],
    },
    n(1),
    ...entryField(d, entry, 1),
    { op: "extern.convert_any" },
  ];
}
/** Presence is returned independently from data undefined/null and absent accessor halves. */
export function buildBuiltinFunctionOwnDescriptor(d: BuiltinFunctionPropertyOperands): BuiltinFunctionDefinition {
  return {
    locals: [{ name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } }],
    body: [
      get(0),
      get(1),
      call(d.findOwn),
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: empty,
        then: [n(0), n(0), ...builtinUndefined(d), ...builtinUndefined(d), ...builtinUndefined(d), { op: "return" }],
      },
      n(1),
      ...entryField(d, 2, 2),
      ...[1, 4, 5].flatMap((field): Instr[] => [...entryField(d, 2, field), { op: "extern.convert_any" }]),
    ],
  };
}
export function buildBuiltinFunctionDeleteOwn(d: BuiltinFunctionPropertyOperands): BuiltinFunctionDefinition {
  return {
    locals: [
      { name: "bag", type: { kind: "ref_null", typeIdx: d.objectTypeIdx } },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
    ],
    body: [
      ...bag(d),
      { op: "local.tee", index: 2 },
      { op: "ref.as_non_null" },
      get(1),
      call(d.findOrdinary),
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      { op: "if", blockType: empty, then: [n(1), { op: "return" }] },
      ...nonnull(2),
      { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
      n(flags.sealed),
      { op: "i32.and" },
      ...entryField(d, 3, 2),
      n(flags.configurable),
      { op: "i32.and" },
      { op: "i32.eqz" },
      { op: "i32.or" },
      { op: "if", blockType: empty, then: [n(0), { op: "return" }] },
      ...nonnull(3),
      ...entryField(d, 3, 2),
      n(flags.tombstone),
      { op: "i32.or" },
      { op: "struct.set", typeIdx: d.entryTypeIdx, fieldIdx: 2 },
      ...[1, 4, 5].flatMap((fieldIdx): Instr[] => [
        ...nonnull(3),
        { op: "ref.null", typeIdx: flags.noneHeap },
        { op: "struct.set", typeIdx: d.entryTypeIdx, fieldIdx },
      ]),
      ...nonnull(2),
      ...nonnull(2),
      { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 2 },
      n(1),
      { op: "i32.sub" },
      { op: "struct.set", typeIdx: d.objectTypeIdx, fieldIdx: 2 },
      ...nonnull(2),
      ...nonnull(2),
      { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 3 },
      n(1),
      { op: "i32.add" },
      { op: "struct.set", typeIdx: d.objectTypeIdx, fieldIdx: 3 },
      n(1),
    ],
  };
}
export function buildBuiltinFunctionExtensibility(
  d: BuiltinFunctionPropertyOperands,
  prevent: boolean,
): BuiltinFunctionDefinition {
  return {
    locals: [],
    body: prevent
      ? [
          ...bag(d),
          ...bag(d),
          { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
          n(flags.nonExtensible),
          { op: "i32.or" },
          { op: "struct.set", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
          n(1),
        ]
      : [
          ...bag(d),
          { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
          n(flags.nonExtensible),
          { op: "i32.and" },
          { op: "i32.eqz" },
        ],
  };
}
/** Own data assignment only: 2 needs prototype [[Set]], 3 needs accessor invocation. */
export function buildBuiltinFunctionWriteOwn(d: BuiltinFunctionPropertyOperands): BuiltinFunctionDefinition {
  return {
    locals: [{ name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } }],
    body: [
      get(0),
      get(1),
      call(d.findOwn),
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      { op: "if", blockType: empty, then: [n(2), { op: "return" }] },
      ...entryField(d, 3, 2),
      n(flags.accessor),
      { op: "i32.and" },
      {
        op: "if",
        blockType: empty,
        then: [
          ...entryField(d, 3, 5),
          { op: "ref.is_null" },
          { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: [n(0)], else: [n(3)] },
          { op: "return" },
        ],
      },
      ...entryField(d, 3, 2),
      n(flags.writable),
      { op: "i32.and" },
      { op: "i32.eqz" },
      ...bag(d),
      { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
      n(flags.frozen),
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "if", blockType: empty, then: [n(0), { op: "return" }] },
      ...nonnull(3),
      get(2),
      { op: "any.convert_extern" },
      { op: "struct.set", typeIdx: d.entryTypeIdx, fieldIdx: 1 },
      n(1),
    ],
  };
}
export function buildBuiltinFunctionWriteOwnStrict(d: BuiltinFunctionPropertyOperands): BuiltinFunctionDefinition {
  return {
    locals: [{ name: "status", type: { kind: "i32" } }],
    body: [
      get(0),
      get(1),
      get(2),
      call(d.writeOwn),
      { op: "local.tee", index: 3 },
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: builtinFailure(d, 4) },
      get(3),
    ],
  };
}
/** Complete ordinary own-key order, including the full unsigned array-index domain and Symbols. */
export function buildBuiltinFunctionOwnKeys(d: BuiltinFunctionPropertyOperands): BuiltinFunctionDefinition {
  const order = (left: number, right: number): Instr[] => [...nonnull(left), ...nonnull(right), call(d.keyBefore)];
  return {
    locals: [
      { name: "map", type: { kind: "ref_null", typeIdx: d.mapTypeIdx } },
      { name: "previous", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "candidate", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "best", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "cursor", type: { kind: "i32" } },
      { name: "result", type: { kind: "externref" } },
    ],
    body: [
      ...bag(d),
      { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 1 },
      set(1),
      call(d.newVector),
      set(6),
      {
        op: "block",
        blockType: empty,
        body: [
          {
            op: "loop",
            blockType: empty,
            body: [
              { op: "ref.null", typeIdx: d.entryTypeIdx },
              set(4),
              n(0),
              set(5),
              {
                op: "block",
                blockType: empty,
                body: [
                  {
                    op: "loop",
                    blockType: empty,
                    body: [
                      get(5),
                      ...nonnull(1),
                      { op: "array.len" },
                      { op: "i32.ge_u" },
                      { op: "br_if", depth: 1 },
                      ...nonnull(1),
                      get(5),
                      { op: "array.get", typeIdx: d.mapTypeIdx },
                      { op: "local.tee", index: 3 },
                      { op: "ref.is_null" },
                      { op: "i32.eqz" },
                      {
                        op: "if",
                        blockType: empty,
                        then: [
                          ...entryField(d, 3, 2),
                          n(flags.tombstone),
                          { op: "i32.and" },
                          { op: "i32.eqz" },
                          {
                            op: "if",
                            blockType: empty,
                            then: [
                              get(2),
                              { op: "ref.is_null" },
                              {
                                op: "if",
                                blockType: { kind: "val", type: { kind: "i32" } },
                                then: [n(1)],
                                else: order(2, 3),
                              },
                              {
                                op: "if",
                                blockType: empty,
                                then: [
                                  get(4),
                                  { op: "ref.is_null" },
                                  {
                                    op: "if",
                                    blockType: { kind: "val", type: { kind: "i32" } },
                                    then: [n(1)],
                                    else: order(3, 4),
                                  },
                                  { op: "if", blockType: empty, then: [get(3), set(4)] },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      get(5),
                      n(1),
                      { op: "i32.add" },
                      set(5),
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              get(4),
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              get(6),
              ...entryField(d, 4, 0),
              { op: "extern.convert_any" },
              call(d.push),
              get(4),
              set(2),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      get(6),
    ],
  };
}
