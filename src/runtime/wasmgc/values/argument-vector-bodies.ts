// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { ArrayTypeDef, StructTypeDef } from "../../../wasm/model/module-records.js";

/** Fresh descriptors and instructions; allocation and caching remain with callers. */
export interface ArgumentVectorLayout {
  readonly objVecArrTypeIdx: number;
  readonly objVecTypeIdx: number;
}

export function createArgumentVectorArrayType(): ArrayTypeDef {
  return {
    kind: "array",
    name: "$ObjVecArr",
    element: { kind: "externref" },
    mutable: true,
  };
}

export function createArgumentVectorType(objVecBaseTypeIdx: number, objVecArrTypeIdx: number): StructTypeDef {
  const { parent, ...shape } = createArgumentVectorShape(
    { kind: "ref" as const, typeIdx: objVecArrTypeIdx },
    objVecBaseTypeIdx,
  );
  return { kind: shape.kind, name: shape.name, superTypeIdx: parent, fields: shape.fields };
}

export function createArgumentVectorShape<D, P>(data: D, parent: P) {
  return {
    kind: "struct" as const,
    name: "$ObjVec",
    parent,
    fields: [
      { name: "length", type: { kind: "i32" as const }, mutable: true },
      { name: "data", type: data, mutable: true },
    ],
  };
}

export function buildArgumentVectorNewBody({ objVecArrTypeIdx, objVecTypeIdx }: ArgumentVectorLayout): Instr[] {
  const INITIAL_CAP = 8;
  return [
    { op: "i32.const", value: 0 }, // len
    { op: "i32.const", value: INITIAL_CAP }, // data: array.new_default count
    { op: "array.new_default", typeIdx: objVecArrTypeIdx },
    { op: "struct.new", typeIdx: objVecTypeIdx },
    { op: "extern.convert_any" },
  ];
}

export function buildArgumentVectorPushLocals({ objVecArrTypeIdx, objVecTypeIdx }: ArgumentVectorLayout): LocalDef[] {
  return [
    { name: "any", type: { kind: "anyref" } },
    { name: "v", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
    { name: "arr", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
    { name: "len", type: { kind: "i32" } },
    { name: "cap", type: { kind: "i32" } },
    { name: "narr", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
    { name: "i", type: { kind: "i32" } },
  ];
}

export function buildArgumentVectorPushBody({ objVecArrTypeIdx, objVecTypeIdx }: ArgumentVectorLayout): Instr[] {
  return [
    // any = any.convert_extern(vec); if !$ObjVec → return
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 2 },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    // v = cast<$ObjVec>(any)
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: objVecTypeIdx },
    { op: "local.set", index: 3 },
    // arr = v.data ; len = v.len ; cap = arr.len
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
    { op: "local.tee", index: 4 },
    { op: "array.len" },
    { op: "local.set", index: 6 },
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 5 },
    // if len >= cap → grow: narr = new[cap*2]; copy 0..len; v.data = narr; arr = narr
    { op: "local.get", index: 5 },
    { op: "local.get", index: 6 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // narr = array.new_default(cap*2)  (cap is always >=1)
        { op: "local.get", index: 6 },
        { op: "i32.const", value: 2 },
        { op: "i32.mul" },
        { op: "array.new_default", typeIdx: objVecArrTypeIdx },
        { op: "local.set", index: 7 },
        // i = 0; while i < len: narr[i] = arr[i]; i++
        { op: "i32.const", value: 0 },
        { op: "local.set", index: 8 },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 8 },
                { op: "local.get", index: 5 },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // narr[i] = arr[i]
                { op: "local.get", index: 7 },
                { op: "ref.as_non_null" },
                { op: "local.get", index: 8 },
                { op: "local.get", index: 4 },
                { op: "ref.as_non_null" },
                { op: "local.get", index: 8 },
                { op: "array.get", typeIdx: objVecArrTypeIdx },
                { op: "array.set", typeIdx: objVecArrTypeIdx },
                // i++
                { op: "local.get", index: 8 },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: 8 },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // v.data = narr ; arr = narr
        { op: "local.get", index: 3 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 7 },
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx: objVecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 7 },
        { op: "local.set", index: 4 },
      ],
    },
    // arr[len] = elem ; v.len = len + 1
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 5 },
    { op: "local.get", index: 1 },
    { op: "array.set", typeIdx: objVecArrTypeIdx },
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 5 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "struct.set", typeIdx: objVecTypeIdx, fieldIdx: 0 },
  ];
}

/** (#7377) The vector's struct and array types, as the realm's operand records name them. */
export interface ArgumentVectorTypes {
  readonly vectorTypeIdx: number;
  readonly vectorArrayTypeIdx: number;
}

function argumentVector(d: ArgumentVectorTypes, vector: readonly Instr[]): Instr[] {
  return [...vector, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: d.vectorTypeIdx }];
}

/** (#7377) The length of the vector whose externref `vector` leaves. */
export function argumentVectorLength(d: ArgumentVectorTypes, vector: readonly Instr[]): Instr[] {
  return [...argumentVector(d, vector), { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 0 }];
}

/** (#7377) The element at the i32 `index` leaves of the vector whose externref `vector` leaves. */
export function argumentVectorElement(
  d: ArgumentVectorTypes,
  vector: readonly Instr[],
  index: readonly Instr[],
): Instr[] {
  return [
    ...argumentVector(d, vector),
    { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 1 },
    ...index,
    { op: "array.get", typeIdx: d.vectorArrayTypeIdx },
  ];
}

/**
 * (#7377) `body` at every `step`-th position of a vector, the position in the i32 local `index`. The length is read
 * before every pass, so `body` may push onto the vector it walks.
 */
export function argumentVectorEach(
  d: ArgumentVectorTypes,
  vector: readonly Instr[],
  index: number,
  step: number,
  body: readonly Instr[],
): Instr[] {
  return [
    { op: "i32.const", value: 0 },
    { op: "local.set", index },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index },
            ...argumentVectorLength(d, vector),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...body,
            { op: "local.get", index },
            { op: "i32.const", value: step },
            { op: "i32.add" },
            { op: "local.set", index },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}
