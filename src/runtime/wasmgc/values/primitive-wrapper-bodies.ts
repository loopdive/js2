// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import {
  PRIMITIVE_WRAPPER_DATA_FIELD,
  PRIMITIVE_WRAPPER_KINDS,
  type PrimitiveWrapperKind,
} from "./primitive-wrapper-layouts.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "./ordinary-object-descriptor-common.js";

interface PrimitiveWrapperStorageTypes {
  readonly objectTypeIdx: number;
  readonly propMapTypeIdx: number;
  readonly wrapperTypeIdx: number;
  readonly initialCapacity: number;
  /** Exact state type and realm slot supplied by an authenticated layout owner. */
  readonly realmState?: { readonly stateTypeIdx: number; readonly realmGlobalIdx: number };
}

/** Construction data only: the caller must authenticate the issued layout owners. */
export type PrimitiveWrapperBodyBindings = PrimitiveWrapperStorageTypes &
  (
    | { readonly kind: "Boolean" | "Number" | "BigInt" }
    | { readonly kind: "String"; readonly anyStrTypeIdx: number }
    | { readonly kind: "Symbol"; readonly symbolTypeIdx: number }
  );

export interface PrimitiveWrapperBodyDefinition {
  readonly params: ValType[];
  readonly results: ValType[];
  readonly locals: LocalDef[];
  readonly body: Instr[];
}

function fail(detail: string): never {
  throw new Error("primitive wrapper body: " + detail);
}

function checkedBindings(input: PrimitiveWrapperBodyBindings) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("bindings must be a data record");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) fail("bindings must be a data record");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value = (key: string): unknown => {
    const field = Object.hasOwn(descriptors, key) ? descriptors[key as keyof typeof descriptors] : undefined;
    if (!field || !Object.hasOwn(field, "value")) fail("missing or non-data binding " + key);
    return field.value;
  };
  const kind = value("kind");
  if (typeof kind !== "string" || !PRIMITIVE_WRAPPER_KINDS.includes(kind as PrimitiveWrapperKind))
    fail("unknown wrapper kind");
  const coordinateKeys = ["objectTypeIdx", "propMapTypeIdx", "wrapperTypeIdx"];
  if (kind === "String") coordinateKeys.push("anyStrTypeIdx");
  if (kind === "Symbol") coordinateKeys.push("symbolTypeIdx");
  const allowed = ["kind", "initialCapacity", ...coordinateKeys, "realmState"];
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.includes(key)))
    fail("unknown binding");
  const coordinates = coordinateKeys.map((key) => {
    const index = value(key);
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff)
      fail("invalid type coordinate " + key);
    return index;
  });
  if (new Set(coordinates).size !== coordinates.length) fail("aliased type coordinates");
  const initialCapacity = value("initialCapacity");
  if (
    typeof initialCapacity !== "number" ||
    !Number.isInteger(initialCapacity) ||
    initialCapacity < 1 ||
    initialCapacity > 0x40000000 ||
    (initialCapacity & (initialCapacity - 1)) !== 0
  )
    fail("initial capacity must be a positive power of two");
  const payload: ValType =
    kind === "Boolean"
      ? { kind: "i32" }
      : kind === "Number"
        ? { kind: "f64" }
        : kind === "BigInt"
          ? { kind: "externref" }
          : { kind: "ref", typeIdx: coordinates[3]! };
  let realmState: PrimitiveWrapperStorageTypes["realmState"];
  if (Object.hasOwn(descriptors, "realmState")) {
    const state = value("realmState");
    if (!state || typeof state !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(state)))
      fail("realm state must be a data record");
    const fields = Object.getOwnPropertyDescriptors(state);
    if (Reflect.ownKeys(fields).length !== 2) fail("unknown realm state binding");
    const values = ["stateTypeIdx", "realmGlobalIdx"].map((role) => {
      const field = fields[role];
      if (
        !field ||
        !Object.hasOwn(field, "value") ||
        !field.enumerable ||
        typeof field.value !== "number" ||
        !Number.isSafeInteger(field.value) ||
        field.value < 0 ||
        field.value > 0xffffffff
      )
        fail("invalid realm state coordinate");
      return field.value as number;
    });
    if (coordinates.includes(values[0]!)) fail("aliased realm state type");
    realmState = { stateTypeIdx: values[0]!, realmGlobalIdx: values[1]! };
  }
  return {
    objectTypeIdx: coordinates[0]!,
    propMapTypeIdx: coordinates[1]!,
    wrapperTypeIdx: coordinates[2]!,
    initialCapacity,
    payload,
    realmState,
  };
}

/**
 * (actual ordinary-object prototype, native payload) -> fresh wrapper externref.
 * The prototype is mandatory and nonnull; no intrinsic/default prototype is chosen.
 * String exotic behavior, payload authority and ToObject are the caller's obligations.
 * Stateful callers authenticate mixed prototype values before this storage allocation;
 * the legacy prefix holds only explicit-null own storage in that mode.
 */
export function buildPrimitiveWrapperAllocationDefinition(
  bindings: PrimitiveWrapperBodyBindings,
): PrimitiveWrapperBodyDefinition {
  const d = checkedBindings(bindings);
  return {
    params: [{ kind: "externref" }, d.payload],
    results: [{ kind: "externref" }],
    locals: [],
    body: [
      ...(d.realmState
        ? [{ op: "ref.null", typeIdx: d.objectTypeIdx } as Instr]
        : ([
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: d.objectTypeIdx },
          ] as Instr[])),
      { op: "i32.const", value: d.initialCapacity },
      { op: "array.new_default", typeIdx: d.propMapTypeIdx },
      { op: "i32.const", value: 0 }, // count
      { op: "i32.const", value: 0 }, // tombstones
      { op: "i32.const", value: d.realmState ? ORDINARY_OBJECT_DESCRIPTOR_ENCODING.nullPrototype : 0 },
      { op: "i32.const", value: 0 }, // nextSeq
      { op: "local.get", index: 1 },
      ...(d.realmState
        ? ([
            { op: "local.get", index: 0 },
            { op: "global.get", index: d.realmState.realmGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "struct.new", typeIdx: d.realmState.stateTypeIdx },
          ] as Instr[])
        : []),
      { op: "struct.new", typeIdx: d.wrapperTypeIdx },
      { op: "extern.convert_any" },
    ],
  };
}

/** Read the immutable private slot in its exact native representation, without coercion. */
export function buildPrimitiveWrapperDataDefinition(
  bindings: PrimitiveWrapperBodyBindings,
): PrimitiveWrapperBodyDefinition {
  const d = checkedBindings(bindings);
  return {
    params: [{ kind: "externref" }],
    results: [d.payload],
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.wrapperTypeIdx },
      { op: "struct.get", typeIdx: d.wrapperTypeIdx, fieldIdx: PRIMITIVE_WRAPPER_DATA_FIELD },
    ],
  };
}
