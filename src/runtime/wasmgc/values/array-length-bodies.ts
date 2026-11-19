// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** (#7352 arrays) `js.object.set-length`: ArraySetLength (ECMA-262 §10.4.2.4), the write of an Array's `length`. */
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import {
  arrayDenseLength,
  arrayElements,
  arrayHole,
  arrayLength,
  arrayRef,
  arraySetLength,
  arrayStore,
  arrayTest,
  type ArrayExoticOperands,
} from "./array-exotic-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import type { SourceObjectDefinition } from "./source-object-bodies.js";

export interface ArraySetLengthOperands extends ArrayExoticOperands {
  /** The kernel's classification of a string key: (key) -> array index as i64, or -1. */
  readonly arrayIndex: FuncHandle;
  /** Throws the RangeError of a length that is no u32. */
  readonly invalidLength: readonly Instr[];
}

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const empty = { kind: "empty" } as const;
const OBJECT = 0;
const NEW_LENGTH = 2;
const MAP = 3;
const CURSOR = 4;
const ENTRY = 5;

/** Cuts the vector to the new length and releases the elements above it. */
const cutVector = (d: ArraySetLengthOperands): Instr[] => [
  ...arrayStore(d, OBJECT),
  get(NEW_LENGTH),
  ...arrayHole(d),
  ...arrayDenseLength(d, OBJECT),
  get(NEW_LENGTH),
  { op: "i32.sub" },
  { op: "array.fill", typeIdx: d.vectorArrayTypeIdx },
  ...arrayElements(d, OBJECT),
  get(NEW_LENGTH),
  { op: "struct.set", typeIdx: d.vectorTypeIdx, fieldIdx: 0 },
];

/**
 * §10.4.2.4 step 17 deletes every index at or above the new length. The vector's are cut; an index the map holds
 * there aborts, uncatchably, until a slice deletes map indices (a wrong `length` is never left behind).
 */
const refuseMapIndices = (d: ArraySetLengthOperands): Instr[] => [
  ...arrayRef(d, OBJECT),
  { op: "struct.get", typeIdx: d.arrayTypeIdx, fieldIdx: 1 },
  set(MAP),
  {
    op: "block",
    blockType: empty,
    body: [
      {
        op: "loop",
        blockType: empty,
        body: [
          get(CURSOR),
          get(MAP),
          { op: "array.len" },
          { op: "i32.ge_u" },
          { op: "br_if", depth: 1 },
          get(MAP),
          get(CURSOR),
          { op: "array.get", typeIdx: d.propMapTypeIdx },
          { op: "local.tee", index: ENTRY },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: empty,
            then: [
              get(ENTRY),
              { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: 2 },
              { op: "i32.const", value: flags.tombstone },
              { op: "i32.and" },
              { op: "i32.eqz" },
              get(ENTRY),
              { op: "struct.get", typeIdx: d.entryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: d.arrayIndex },
              get(NEW_LENGTH),
              { op: "i64.extend_i32_u" },
              { op: "i64.ge_s" },
              { op: "i32.and" },
              { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
            ],
          },
          get(CURSOR),
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          set(CURSOR),
          { op: "br", depth: 0 },
        ],
      },
    ],
  },
];

/**
 * `js.object.set-length(object, length)`: ArraySetLength with `length` = ToNumber of the written value (its caller
 * converts). A length whose ToUint32 differs from it throws a RangeError; growing only sets `length`; shrinking
 * also removes the indices at or above it.
 *
 * A receiver that is no array aborts: `length` of an ordinary object is an ordinary property, written by the
 * object lane's `js.object.set`, which does not exist yet.
 */
export function buildArraySetLengthDefinition(d: ArraySetLengthOperands): SourceObjectDefinition {
  return {
    locals: [
      { name: "newLength", type: { kind: "i32" } },
      { name: "map", type: { kind: "ref_null", typeIdx: d.propMapTypeIdx } },
      { name: "cursor", type: { kind: "i32" } },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.entryTypeIdx } },
    ],
    body: [
      ...arrayTest(d, OBJECT),
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
      get(1),
      { op: "i32.trunc_sat_f64_u" },
      { op: "local.tee", index: NEW_LENGTH },
      { op: "f64.convert_i32_u" },
      get(1),
      { op: "f64.ne" },
      { op: "if", blockType: empty, then: structuredClone(d.invalidLength) as Instr[] },
      get(NEW_LENGTH),
      ...arrayLength(d, OBJECT),
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: empty,
        then: [
          get(NEW_LENGTH),
          ...arrayDenseLength(d, OBJECT),
          { op: "i32.lt_u" },
          { op: "if", blockType: empty, then: cutVector(d) },
          ...refuseMapIndices(d),
        ],
      },
      ...arraySetLength(d, OBJECT, [get(NEW_LENGTH)]),
    ],
  };
}
