// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "./ordinary-object-descriptor-common.js";

/** Construction coordinates only; issued backend owners supply their authority. */
export interface StringCreateBindings {
  readonly objectTypeIdx: number;
  readonly stringObjectTypeIdx: number;
  readonly propMapTypeIdx: number;
  readonly anyStringTypeIdx: number;
  readonly insertIdx: number;
  readonly boxNumberIdx: number;
  readonly initialCapacity: number;
  readonly lengthKey: { readonly kind: "global" | "function"; readonly index: number };
}
function fail(detail: string): never {
  throw Error("StringCreate body: " + detail);
}
function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("data bindings required");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) fail("plain data bindings required");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).some((key) => typeof key !== "string" || !keys.includes(key))) fail("unknown binding");
  return Object.fromEntries(
    keys.map((key) => {
      const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!field || !Object.hasOwn(field, "value")) fail("missing/non-data binding " + key);
      return [key, field.value];
    }),
  );
}
function coordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    fail("invalid coordinate");
  return value;
}
export function checkedStringCreateCapacity(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 2 ||
    value > 0x40000000 ||
    (value & (value - 1)) !== 0
  )
    fail("capacity must be a power of two with room after length insertion");
  return value;
}

/**
 * (explicit ordinary-object-or-null prototype, native AnyString payload) -> String object.
 * The immutable private payload is retained. Length is an ordinary nonwritable,
 * nonenumerable, nonconfigurable data property; indexed characters remain virtual.
 */
export function buildStringCreateDefinition(input: StringCreateBindings): { locals: LocalDef[]; body: Instr[] } {
  const keys = [
    "objectTypeIdx",
    "stringObjectTypeIdx",
    "propMapTypeIdx",
    "anyStringTypeIdx",
    "insertIdx",
    "boxNumberIdx",
    "initialCapacity",
    "lengthKey",
  ] as const;
  const raw = data(input, keys);
  const typeKeys = ["objectTypeIdx", "stringObjectTypeIdx", "propMapTypeIdx", "anyStringTypeIdx"] as const;
  const types = typeKeys.map((key) => coordinate(raw[key]));
  if (new Set(types).size !== types.length) fail("aliased type coordinates");
  const [objectTypeIdx, stringObjectTypeIdx, propMapTypeIdx, anyStringTypeIdx] = types;
  const insertIdx = coordinate(raw.insertIdx),
    boxNumberIdx = coordinate(raw.boxNumberIdx);
  const initialCapacity = checkedStringCreateCapacity(raw.initialCapacity);
  const key = data(raw.lengthKey, ["kind", "index"]),
    keyIndex = coordinate(key.index);
  if (key.kind !== "global" && key.kind !== "function") fail("invalid length-key binding");
  const readKey: Instr =
    key.kind === "global" ? { op: "global.get", index: keyIndex } : { op: "call", funcIdx: keyIndex };
  return {
    locals: [{ name: "object", type: { kind: "ref", typeIdx: stringObjectTypeIdx! } }],
    body: [
      // Cast before allocating. Null is an explicit prototype, not a default marker.
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast_null", typeIdx: objectTypeIdx! },
      { op: "i32.const", value: initialCapacity },
      { op: "array.new_default", typeIdx: propMapTypeIdx! },
      { op: "i32.const", value: 0 }, // count
      { op: "i32.const", value: 0 }, // tombstones
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: ORDINARY_OBJECT_DESCRIPTOR_ENCODING.nullPrototype }],
        else: [{ op: "i32.const", value: 0 }],
      }, // explicit null must never request an implicit realm prototype
      { op: "i32.const", value: 0 }, // nextSeq
      { op: "local.get", index: 1 },
      { op: "struct.new", typeIdx: stringObjectTypeIdx! },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      readKey,
      { op: "extern.convert_any" },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyStringTypeIdx!, fieldIdx: 0 },
      { op: "f64.convert_i32_u" },
      { op: "call", funcIdx: boxNumberIdx },
      { op: "any.convert_extern" },
      { op: "i32.const", value: 0 }, // length attributes all false
      { op: "i32.const", value: 0 }, // length is the first ordinary own string key
      { op: "call", funcIdx: insertIdx },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 1 },
      { op: "struct.set", typeIdx: objectTypeIdx!, fieldIdx: 5 },
      { op: "local.get", index: 2 },
      { op: "extern.convert_any" },
    ],
  };
}
