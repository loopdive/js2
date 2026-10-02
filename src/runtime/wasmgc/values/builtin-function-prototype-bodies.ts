// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, FuncHandle } from "../../../wasm/model/instructions.js";
import { builtinUndefined, builtinFailure, type BuiltinFunctionDefinition } from "./builtin-function-bodies.js";
import {
  buildBuiltinFunctionEntryGet,
  type BuiltinFunctionPropertyOperands,
} from "./builtin-function-property-bodies.js";
import { BUILTIN_FUNCTION_PROTOTYPE_FIELD } from "./builtin-function-layouts.js";

export interface BuiltinFunctionPrototypeOperands extends BuiltinFunctionPropertyOperands {
  readonly getPrototypeOf: FuncHandle;
  readonly lookup: FuncHandle;
  readonly isExtensible: FuncHandle;
  readonly sameValue: FuncHandle;
}
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const empty = { kind: "empty" } as const;
const object = (d: BuiltinFunctionPrototypeOperands, local: number): Instr[] => [
  get(local),
  { op: "any.convert_extern" },
  { op: "ref.cast", typeIdx: d.objectTypeIdx },
];
/** Returns actual parent, or an explicit gap. Null on the incomplete anchor is not public absence. */
function ordinaryParent(d: BuiltinFunctionPrototypeOperands, cursor: number, next: number, gap: Instr[]): Instr[] {
  return [
    ...object(d, cursor),
    { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 0 },
    { op: "extern.convert_any" },
    { op: "local.tee", index: next },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: empty,
      then: [
        get(cursor),
        { op: "global.get", index: d.objectPrototype },
        call(d.sameValue),
        ...object(d, cursor),
        { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
        n(128),
        { op: "i32.and" },
        { op: "i32.eqz" },
        { op: "i32.or" },
        { op: "if", blockType: empty, then: gap },
      ],
    },
  ];
}
/**
 * Native bounded lookup: 0 absent, 1 present, 2 missing realm parent/population,
 * 3 unknown carrier. The owner admits only an effectively final ordinary type;
 * extensible roots need an authenticated heterogeneous own-property dispatcher.
 */
export function buildBuiltinFunctionLookup(d: BuiltinFunctionPrototypeOperands): BuiltinFunctionDefinition {
  const missing = (status: number): Instr[] => [
    n(status),
    { op: "ref.null", typeIdx: d.entryTypeIdx },
    { op: "return" },
  ];
  return {
    locals: [
      { name: "cursor", type: { kind: "externref" } },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "next", type: { kind: "externref" } },
    ],
    body: [
      call(d.initializer),
      get(0),
      set(2),
      {
        op: "loop",
        blockType: empty,
        body: [
          get(2),
          { op: "ref.is_null" },
          { op: "if", blockType: empty, then: missing(0) },
          get(2),
          call(d.match),
          {
            op: "if",
            blockType: empty,
            then: [get(2), get(1), call(d.findOwn), set(3), get(2), call(d.getPrototypeOf), set(4)],
            else: [
              get(2),
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: d.objectTypeIdx },
              { op: "i32.eqz" },
              { op: "if", blockType: empty, then: missing(3) },
              ...object(d, 2),
              get(1),
              call(d.findOrdinary),
              set(3),
              // Do not follow a parent or report its incompleteness until the own entry misses.
              get(3),
              { op: "ref.is_null" },
              { op: "if", blockType: empty, then: ordinaryParent(d, 2, 4, missing(2)) },
            ],
          },
          get(3),
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          { op: "if", blockType: empty, then: [n(1), get(3), { op: "return" }] },
          get(4),
          set(2),
          { op: "br", depth: 0 },
        ],
      },
      { op: "unreachable" },
    ],
  };
}
export function buildBuiltinFunctionGet(d: BuiltinFunctionPrototypeOperands): BuiltinFunctionDefinition {
  return {
    locals: [
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
      { name: "getter", type: { kind: "externref" } },
      { name: "status", type: { kind: "i32" } },
    ],
    body: [
      get(0),
      get(1),
      call(d.lookup),
      set(3),
      { op: "local.tee", index: 5 },
      n(1),
      { op: "i32.ne" },
      { op: "if", blockType: empty, then: [get(5), ...builtinUndefined(d), { op: "return" }] },
      ...buildBuiltinFunctionEntryGet(d, 3, 2, 4),
    ],
  };
}
export function buildBuiltinFunctionHas(d: BuiltinFunctionPrototypeOperands): BuiltinFunctionDefinition {
  return { locals: [], body: [get(0), get(1), call(d.lookup), { op: "drop" }] };
}
/**
 * Bounded SetPrototypeOf on owned builtin targets. An unresolved or unknown walk
 * returns 2/3 before mutation. Ordinary objects cannot acquire function links here.
 */
export function buildBuiltinFunctionSetPrototype(d: BuiltinFunctionPrototypeOperands): BuiltinFunctionDefinition {
  return {
    locals: [
      { name: "cursor", type: { kind: "externref" } },
      { name: "next", type: { kind: "externref" } },
      { name: "targetOrdinal", type: { kind: "i32" } },
    ],
    body: [
      get(0),
      call(d.match),
      { op: "local.tee", index: 4 },
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: builtinFailure(d) },
      get(0),
      call(d.getPrototypeOf),
      get(1),
      call(d.sameValue),
      { op: "if", blockType: empty, then: [n(1), { op: "return" }] },
      get(0),
      call(d.isExtensible),
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: [n(0), { op: "return" }] },
      get(1),
      set(2),
      {
        op: "block",
        blockType: empty,
        body: [
          {
            op: "loop",
            blockType: empty,
            body: [
              get(2),
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              get(2),
              get(0),
              call(d.sameValue),
              { op: "if", blockType: empty, then: [n(0), { op: "return" }] },
              get(2),
              call(d.match),
              {
                op: "if",
                blockType: empty,
                then: [get(2), call(d.getPrototypeOf), set(3)],
                else: [
                  get(2),
                  { op: "any.convert_extern" },
                  { op: "ref.test", typeIdx: d.objectTypeIdx },
                  { op: "i32.eqz" },
                  { op: "if", blockType: empty, then: [n(3), { op: "return" }] },
                  // Prototype population is irrelevant to the cycle check; the actual
                  // Object.prototype null link is known, while an implicit parent is unresolved.
                  ...object(d, 2),
                  { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 0 },
                  { op: "extern.convert_any" },
                  { op: "local.tee", index: 3 },
                  { op: "ref.is_null" },
                  {
                    op: "if",
                    blockType: empty,
                    then: [
                      ...object(d, 2),
                      { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 4 },
                      n(128),
                      { op: "i32.and" },
                      { op: "i32.eqz" },
                      { op: "if", blockType: empty, then: [n(2), { op: "return" }] },
                    ],
                  },
                ],
              },
              get(3),
              set(2),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      ...d.entries.flatMap((entry, ordinal): Instr[] => [
        get(4),
        n(ordinal + 1),
        { op: "i32.eq" },
        {
          op: "if",
          blockType: empty,
          then: [
            get(0),
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: entry.typeIdx },
            get(1),
            { op: "struct.set", typeIdx: entry.typeIdx, fieldIdx: BUILTIN_FUNCTION_PROTOTYPE_FIELD },
            n(1),
            { op: "return" },
          ],
        },
      ]),
      { op: "unreachable" },
    ],
  };
}
