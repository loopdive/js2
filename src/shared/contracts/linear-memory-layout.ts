// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Storage vocabulary independent of a machine instruction set. */
export type LinearStorageKind = "i8" | "i16" | "i32" | "i64" | "f32" | "f64" | "bytes16" | "pointer";

export type LinearSizePlan =
  | { readonly kind: "constant"; readonly bytes: number }
  | {
      readonly kind: "elements";
      readonly baseBytes: number;
      readonly strideBytes: number;
      readonly minimumElements: number;
    }
  | { readonly kind: "runtime"; readonly minimumBytes: number };

export interface LinearFieldPlan {
  readonly name: string;
  readonly offset: number;
  readonly storage: LinearStorageKind;
  /** Reserved bytes in the containing record, which can exceed storage width. */
  readonly slotBytes: number;
  readonly alignment: number;
  readonly containsPointer: boolean;
}

export type LinearPointerMap =
  | { readonly kind: "none" }
  | { readonly kind: "fixed"; readonly offsets: readonly number[] }
  | {
      readonly kind: "elements";
      readonly fixedOffsets: readonly number[];
      readonly elementsOffset: number;
      readonly elementStride: number;
      readonly elementsContainPointers: boolean;
    };

export interface LinearLayoutBase {
  /** Stable semantic identity; never a module/type-table index. */
  readonly id: string;
  readonly alignment: number;
  readonly size: LinearSizePlan;
  readonly pointerMap: LinearPointerMap;
}

export interface LinearRecordLayoutPlan extends LinearLayoutBase {
  readonly kind: "record";
  readonly headerBytes: number;
  readonly typeTagOffset: number;
  readonly payloadSizeOffset: number;
  readonly fields: readonly LinearFieldPlan[];
}

export interface LinearVectorLayoutPlan extends LinearLayoutBase {
  readonly kind: "vector";
  readonly lengthOffset: number;
  readonly capacityOffset: number;
  readonly elementsOffset: number;
  readonly elementStorage: LinearStorageKind;
  readonly elementStride: number;
  readonly minimumCapacity: number;
}

export interface LinearStringLayoutPlan extends LinearLayoutBase {
  readonly kind: "string";
  readonly payloadSizeOffset: number;
  readonly payloadPrefixBytes: number;
  readonly lengthOffset: number;
  readonly elementsOffset: number;
  readonly elementStorage: "i8" | "i16";
  readonly elementStride: 1 | 2;
}

/** JS2's current linear address width. Kept here rather than in an emitter. */
export const LINEAR_POINTER_BYTES = 4;

export const LINEAR_RECORD_ALIGNMENT = 8;

export const LINEAR_RECORD_HEADER_BYTES = 8;

export const LINEAR_RECORD_FIELD_SLOT_BYTES = 8;

export const LINEAR_RECORD_TAG_OFFSET = 0;

export const LINEAR_RECORD_PAYLOAD_SIZE_OFFSET = 4;

/**
 * Shared forwarding-record representation for relocated linear arrays.
 *
 * A grown array rewrites its old record header to this tag plus the pointer
 * to the replacement record. Keep this contract beside the canonical linear
 * layout offsets so every artifact adapter and the direct linear runtime read
 * and write the same representation.
 */
export const LINEAR_ARRAY_FORWARDING = Object.freeze({
  tag: 0x06,
  tagOffset: LINEAR_RECORD_TAG_OFFSET,
  pointerOffset: LINEAR_RECORD_PAYLOAD_SIZE_OFFSET,
  pointerBytes: LINEAR_POINTER_BYTES,
});

export const LINEAR_VECTOR_LENGTH_OFFSET = 8;

export const LINEAR_VECTOR_CAPACITY_OFFSET = 12;

export const LINEAR_VECTOR_ELEMENTS_OFFSET = 16;

export const LINEAR_VECTOR_MINIMUM_CAPACITY = 16;

export const LINEAR_STRING_LENGTH_OFFSET = 8;

export const LINEAR_STRING_ELEMENTS_OFFSET = 12;

export const LINEAR_STRING_PAYLOAD_SIZE_OFFSET = LINEAR_RECORD_PAYLOAD_SIZE_OFFSET;

/** Bytes between the record header and the first string element (the length field). */
export const LINEAR_STRING_PAYLOAD_PREFIX_BYTES = LINEAR_STRING_ELEMENTS_OFFSET - LINEAR_RECORD_HEADER_BYTES;

export function storageBytes(storage: LinearStorageKind): number {
  switch (storage) {
    case "i8":
      return 1;
    case "i16":
      return 2;
    case "i32":
    case "f32":
    case "pointer":
      return 4;
    case "i64":
    case "f64":
      return 8;
    case "bytes16":
      return 16;
  }
}

export function storageAlignment(storage: LinearStorageKind): number {
  return storageBytes(storage);
}

/** Shared record-layout primitive consumed by IR and direct linear-Wasm paths. */
export function planLinearRecordLayout(
  id: string,
  fields: readonly { readonly name: string; readonly storage: LinearStorageKind }[],
): LinearRecordLayoutPlan {
  const plannedFields = fields.map((field, index): LinearFieldPlan => {
    const containsPointer = field.storage === "pointer";
    return {
      name: field.name,
      offset: LINEAR_RECORD_HEADER_BYTES + index * LINEAR_RECORD_FIELD_SLOT_BYTES,
      storage: field.storage,
      slotBytes: LINEAR_RECORD_FIELD_SLOT_BYTES,
      alignment: storageAlignment(field.storage),
      containsPointer,
    };
  });
  const pointerOffsets = plannedFields.filter((field) => field.containsPointer).map((field) => field.offset);
  return {
    id,
    kind: "record",
    alignment: LINEAR_RECORD_ALIGNMENT,
    size: {
      kind: "constant",
      bytes: LINEAR_RECORD_HEADER_BYTES + plannedFields.length * LINEAR_RECORD_FIELD_SLOT_BYTES,
    },
    pointerMap: pointerOffsets.length === 0 ? { kind: "none" } : { kind: "fixed", offsets: pointerOffsets },
    headerBytes: LINEAR_RECORD_HEADER_BYTES,
    typeTagOffset: LINEAR_RECORD_TAG_OFFSET,
    payloadSizeOffset: LINEAR_RECORD_PAYLOAD_SIZE_OFFSET,
    fields: plannedFields,
  };
}

export function linearStringLayoutId(): string {
  return "string:utf8-bytes-v1";
}

export function planLinearStringLayout(): LinearStringLayoutPlan {
  return {
    id: linearStringLayoutId(),
    kind: "string",
    alignment: LINEAR_RECORD_ALIGNMENT,
    size: { kind: "elements", baseBytes: LINEAR_STRING_ELEMENTS_OFFSET, strideBytes: 1, minimumElements: 0 },
    pointerMap: { kind: "none" },
    payloadSizeOffset: LINEAR_STRING_PAYLOAD_SIZE_OFFSET,
    payloadPrefixBytes: LINEAR_STRING_PAYLOAD_PREFIX_BYTES,
    lengthOffset: LINEAR_STRING_LENGTH_OFFSET,
    elementsOffset: LINEAR_STRING_ELEMENTS_OFFSET,
    elementStorage: "i8",
    elementStride: 1,
  };
}

export function linearScalarStorageKey(storage: LinearStorageKind): string {
  return `scalar:${storage}`;
}

export function linearVectorLayoutIdForElementKey(elementKey: string): string {
  return `vector:${elementKey}`;
}

export function planLinearVectorStorageLayout(elementKey: string, storage: LinearStorageKind): LinearVectorLayoutPlan {
  const stride = storageBytes(storage);
  return {
    id: linearVectorLayoutIdForElementKey(elementKey),
    kind: "vector",
    alignment: Math.max(LINEAR_RECORD_ALIGNMENT, storageAlignment(storage)),
    size: {
      kind: "elements",
      baseBytes: LINEAR_VECTOR_ELEMENTS_OFFSET,
      strideBytes: stride,
      minimumElements: LINEAR_VECTOR_MINIMUM_CAPACITY,
    },
    pointerMap: {
      kind: "elements",
      fixedOffsets: [],
      elementsOffset: LINEAR_VECTOR_ELEMENTS_OFFSET,
      elementStride: stride,
      elementsContainPointers: storage === "pointer",
    },
    lengthOffset: LINEAR_VECTOR_LENGTH_OFFSET,
    capacityOffset: LINEAR_VECTOR_CAPACITY_OFFSET,
    elementsOffset: LINEAR_VECTOR_ELEMENTS_OFFSET,
    elementStorage: storage,
    elementStride: stride,
    minimumCapacity: LINEAR_VECTOR_MINIMUM_CAPACITY,
  };
}

export function planLinearScalarVectorLayout(storage: LinearStorageKind): LinearVectorLayoutPlan {
  return planLinearVectorStorageLayout(linearScalarStorageKey(storage), storage);
}
