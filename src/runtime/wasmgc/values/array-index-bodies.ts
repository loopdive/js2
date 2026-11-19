// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7352 arrays) The index contracts `js.object.get-index` / `set-index`: [[Get]] and [[Set]] with a number key.
 * An array index of an `$Array` reaches the dense vector without a key string; every other case is the
 * string-keyed operation under the index's canonical string (`indexKey`).
 */
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import {
  ARRAY_DENSITY_BOUND,
  arrayDenseElement,
  arrayDenseLength,
  arrayElements,
  arrayHoleTest,
  arrayIndexOf,
  arrayLength,
  arraySetLength,
  arrayTest,
  type ArrayExoticOperands,
} from "./array-exotic-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { sourceObjectGet, type SourceObjectDefinition } from "./source-object-bodies.js";

export interface ArrayIndexOperands extends ArrayExoticOperands {
  /** ToString of a u32 (i32) -> String: the canonical string of an array index. */
  readonly indexKey: FuncHandle;
}
export interface ArrayGetIndexOperands extends ArrayIndexOperands {
  /** The kernel's string-keyed [[Get]]: (object, key, receiver) -> (status, value). */
  readonly get: FuncHandle;
}
export interface ArraySetIndexOperands extends ArrayIndexOperands {
  /** The shared vector grow/store helper over the element vector: (vector, index, value). */
  readonly elementStore: FuncHandle;
  /** The descriptor pack's public define: (object, key, value, descriptor word). */
  readonly defineData: FuncHandle;
}

const get = (index: number): Instr => ({ op: "local.get", index });
const empty = { kind: "empty" } as const;
/** The largest index the vector's i32 length can count. */
const MAX_DENSE_INDEX = 2147483646n;
/** A complete data descriptor: value, writable, enumerable and configurable, all present and true. */
const DATA_PROPERTY =
  flags.hasValue |
  flags.writable |
  flags.writableSpecified |
  flags.enumerable |
  flags.enumerableSpecified |
  flags.configurable |
  flags.configurableSpecified;

/**
 * Classifies the f64 key in `key` into the i64 local `index` (`arrayIndexOf`). A number that is no array index
 * (1.5, -1, 2^32-1) is an ordinary key under ToString of the number, and Number::toString is a program-level
 * resource (`native-number-format.ts`) the realm cannot call: such a key aborts here until the realm reaches it.
 */
const requireArrayIndex = (key: number, index: number): Instr[] => [
  ...arrayIndexOf(key),
  { op: "local.tee", index },
  { op: "i64.const", value: 0n },
  { op: "i64.lt_s" },
  { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
];
const wrapped = (index: number): Instr[] => [get(index), { op: "i32.wrap_i64" }];

/**
 * `js.object.get-index(object, index, receiver)`: [[Get]] with an array-index key. An element the vector of an
 * `$Array` holds is the answer; a hole, an index above the vector and a receiver that is no array take the
 * kernel's string-keyed [[Get]], which finds a map-held index and walks the prototype chain. A walk that ends at
 * the realm's partly populated Object.prototype (status 2) is absence here, `undefined`: no standard property of
 * %Array.prototype% or %Object.prototype% is an array index, so the unpopulated ones cannot answer this key.
 */
export function buildArrayGetIndexDefinition(d: ArrayGetIndexOperands): SourceObjectDefinition {
  return {
    locals: [
      { name: "index", type: { kind: "i64" } },
      { name: "value", type: { kind: "externref" } },
    ],
    body: [
      ...requireArrayIndex(1, 3),
      {
        op: "block",
        blockType: empty,
        body: [
          ...arrayTest(d, 0),
          { op: "i32.eqz" },
          { op: "br_if", depth: 0 },
          get(3),
          ...arrayDenseLength(d, 0),
          { op: "i64.extend_i32_u" },
          { op: "i64.ge_u" },
          { op: "br_if", depth: 0 },
          ...arrayDenseElement(d, 0, wrapped(3)),
          { op: "local.set", index: 4 },
          ...arrayHoleTest(d, 4),
          { op: "br_if", depth: 0 },
          get(4),
          { op: "return" },
        ],
      },
      get(0),
      ...wrapped(3),
      { op: "call", funcIdx: d.indexKey },
      get(2),
      ...sourceObjectGet(d.get, 4),
    ],
  };
}

/**
 * `js.object.set-index(object, index, value)`: [[Set]] with an array-index key on an `$Array`, as an own data
 * property (ArrayDefineOwnProperty, §10.4.2.1). An index below the vector's length plus the density bound is
 * stored in the vector, which grows by doubling and fills the gap with holes (`elementStore`); any other index is
 * a property of the map under its canonical string, so its size is never allocated. `length` follows the index.
 *
 * A receiver that is no array aborts: [[Set]] on an ordinary object is the object lane's `js.object.set`, which
 * does not exist yet. That operation also owns what this one leaves out, a setter or a read-only index inherited
 * from the prototype chain.
 */
export function buildArraySetIndexDefinition(d: ArraySetIndexOperands): SourceObjectDefinition {
  return {
    locals: [{ name: "index", type: { kind: "i64" } }],
    body: [
      ...arrayTest(d, 0),
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: [{ op: "unreachable" }] },
      ...requireArrayIndex(1, 3),
      get(3),
      ...arrayDenseLength(d, 0),
      { op: "i64.extend_i32_u" },
      { op: "i64.const", value: BigInt(ARRAY_DENSITY_BOUND) },
      { op: "i64.add" },
      { op: "i64.lt_u" },
      get(3),
      { op: "i64.const", value: MAX_DENSE_INDEX },
      { op: "i64.le_u" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: empty,
        then: [...arrayElements(d, 0), ...wrapped(3), get(2), { op: "call", funcIdx: d.elementStore }],
        else: [
          get(0),
          ...wrapped(3),
          { op: "call", funcIdx: d.indexKey },
          get(2),
          { op: "f64.const", value: DATA_PROPERTY },
          { op: "call", funcIdx: d.defineData },
        ],
      },
      ...wrapped(3),
      ...arrayLength(d, 0),
      { op: "i32.ge_u" },
      {
        op: "if",
        blockType: empty,
        then: arraySetLength(d, 0, [...wrapped(3), { op: "i32.const", value: 1 }, { op: "i32.add" }]),
      },
    ],
  };
}
