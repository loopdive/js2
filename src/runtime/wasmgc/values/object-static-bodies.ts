// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The realm's half of `Object.defineProperty`, `Object.defineProperties` (and `Object.create`'s second
 * argument) and `Object.getOwnPropertyDescriptor`. The caller has already tested the target's kind (a TypeError for a
 * primitive, the run-time abort for a kind the kernel does not serve) and taken ToPropertyKey, in the specification's
 * order; these bodies continue from there over the Property Descriptor record (`descriptor-record-bodies.ts`).
 */
import type { FuncHandle, Instr, TypeHandle } from "../../../wasm/model/instructions.js";
import {
  definePropertyOrThrow,
  descriptorRecordLocals,
  fromPropertyDescriptor,
  getOrAbort,
  storeDescriptorRecord,
  type DescriptorRecordOperands,
} from "./descriptor-record-bodies.js";
import { CREATE_DATA_PROPERTY, type SourceObjectDefinition } from "./source-object-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { I31_HEAP_TYPE } from "./prototype-receiver-bodies.js";

export interface ObjectStaticOperands extends DescriptorRecordOperands {
  readonly ownKeys: FuncHandle;
  readonly ownDescriptor: FuncHandle;
  readonly newVector: FuncHandle;
  readonly push: FuncHandle;
  readonly vectorTypeIdx: TypeHandle;
  readonly vectorArrayTypeIdx: TypeHandle;
}

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const EXTERNREF = { kind: "externref" } as const;

/** `js.object.descriptor-define(object, key, attributes)`: ToPropertyDescriptor, then DefinePropertyOrThrow. */
export function buildDescriptorDefineDefinition(
  d: ObjectStaticOperands,
  toPropertyDescriptor: FuncHandle,
): SourceObjectDefinition {
  const record = descriptorRecordLocals(3);
  return {
    locals: record.locals,
    body: [
      get(2),
      call(toPropertyDescriptor),
      ...storeDescriptorRecord(record.slots),
      ...definePropertyOrThrow(d, [get(0)], [get(1)], record.slots),
    ],
  };
}

/**
 * `js.object.descriptors-define(object, properties)`: ObjectDefineProperties (§20.1.2.3.1). Every own enumerable
 * property of `properties` is read and converted (in own-key order) before the first define, so a TypeError in a later
 * descriptor defines nothing; the records wait in an argument vector, five entries each (key, value, getter, setter,
 * the word as an i31).
 */
export function buildDescriptorsDefineDefinition(
  d: ObjectStaticOperands,
  toPropertyDescriptor: FuncHandle,
): SourceObjectDefinition {
  const [keys, list, index, key, field] = [2, 3, 4, 5, 6];
  const record = descriptorRecordLocals(7);
  const [word, value, getter, setter] = record.slots as [number, number, number, number];
  const vector = (local: number): Instr[] => [
    get(local),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.vectorTypeIdx },
  ];
  const element = (local: number, offset: number): Instr[] => [
    ...vector(local),
    { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 1 },
    get(index),
    ...(offset ? [n(offset), { op: "i32.add" } as Instr] : []),
    { op: "array.get", typeIdx: d.vectorArrayTypeIdx },
  ];
  const each = (local: number, step: number, body: Instr[]): Instr[] => [
    n(0),
    set(index),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(index),
            ...vector(local),
            { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 0 },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...body,
            get(index),
            n(step),
            { op: "i32.add" },
            set(index),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
  const push = (value: Instr[]): Instr[] => [get(list), ...value, call(d.push)];
  const collect: Instr[] = [
    ...element(keys, 0),
    set(key),
    // Only the attribute word of [[GetOwnProperty]] decides: an absent key's word is 0, not enumerable.
    get(1),
    get(key),
    call(d.ownDescriptor),
    { op: "drop" },
    { op: "drop" },
    { op: "drop" },
    set(word),
    { op: "drop" },
    get(word),
    n(flags.enumerable),
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getOrAbort(d, 1, [get(key)], field),
        get(field),
        call(toPropertyDescriptor),
        ...storeDescriptorRecord(record.slots),
        ...push([get(key)]),
        ...push([get(value)]),
        ...push([get(getter)]),
        ...push([get(setter)]),
        ...push([get(word), { op: "ref.i31" }, { op: "extern.convert_any" }]),
      ],
    },
  ];
  const apply: Instr[] = [
    ...element(list, 0),
    set(key),
    ...element(list, 1),
    set(value),
    ...element(list, 2),
    set(getter),
    ...element(list, 3),
    set(setter),
    ...element(list, 4),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: I31_HEAP_TYPE },
    { op: "i31.get_s" },
    set(word),
    ...definePropertyOrThrow(d, [get(0)], [get(key)], record.slots),
  ];
  return {
    locals: [
      ...["keys", "list"].map((name) => ({ name, type: EXTERNREF })),
      { name: "index", type: { kind: "i32" } },
      ...["key", "field"].map((name) => ({ name, type: EXTERNREF })),
      ...record.locals,
    ],
    body: [
      get(1),
      call(d.ownKeys),
      set(keys),
      call(d.newVector),
      set(list),
      ...each(keys, 1, collect),
      ...each(list, 5, apply),
    ],
  };
}

/**
 * `js.object.own-descriptor(object, key)`: [[GetOwnProperty]], then FromPropertyDescriptor onto a new ordinary object
 * (`create`, the realm's `create-default`), or `undefined` for an absent key. Each field is CreateDataProperty through
 * the descriptor pack's public define, `defineOwn`.
 */
export function buildOwnDescriptorDefinition(
  d: ObjectStaticOperands,
  create: readonly Instr[],
  defineOwn: FuncHandle,
): SourceObjectDefinition {
  const [entryFlags, value, getter, setter, result] = [2, 3, 4, 5, 6];
  const defineField = (name: string, fieldValue: Instr[]): Instr[] => [
    get(result),
    ...d.key(name),
    ...fieldValue,
    { op: "f64.const", value: CREATE_DATA_PROPERTY },
    call(defineOwn),
  ];
  return {
    locals: [
      { name: "flags", type: { kind: "i32" } },
      ...["value", "getter", "setter", "result"].map((name) => ({ name, type: EXTERNREF })),
    ],
    body: [
      get(0),
      get(1),
      call(d.ownDescriptor),
      set(setter),
      set(getter),
      set(value),
      set(entryFlags),
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [...d.undefinedValue, { op: "return" }] },
      ...create,
      set(result),
      ...fromPropertyDescriptor(d, defineField, [entryFlags, value, getter, setter]),
      get(result),
    ],
  };
}
