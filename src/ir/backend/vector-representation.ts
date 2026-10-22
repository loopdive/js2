// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #6920 — one backend-owned vector representation policy.
//
// A resolver returns a raw backend handle (`IrVecBackendLowering`). This module
// narrows it, rejects a handle that belongs to the other backend, and
// normalizes it into a discriminated representation whose value carrier, data
// carrier and construction scratch type all come from the same genuine handle.
// WasmGC keeps its registered struct/array indices; linear memory carries i32
// pointers and real layout/operation descriptors with no GC fields.
//
// Resolution is demand-specific. `carrier` answers a value-type question only
// and performs exactly the symbolic lookups the historical type-conversion arm
// performed (one carrier lookup for a layout-backed GC vec). `operation`
// returns the complete handle and preserves the historical operation order
// (carrier, carrier, data array). Folding the two would add GC type lookups
// to plain type conversion and could change registration/numbering.
//
// Pure DATA/contract module: no frontend, legacy context, runtime builder or
// host import dependencies.

import type { AllocSiteId, IrType, IrTypeRef } from "../nodes.js";
import type { ValType } from "../types.js";
import type { IrI32ValType, IrVecBackendLowering, IrVecLowering, LinearVecLowering } from "./handles.js";
import type { IrBackendKind } from "./legality.js";

export type IrVecRepresentationKind = "wasmgc" | "linear-memory";

/** Complete operation view of one resolved vector representation. */
export type IrVecRepresentation =
  | {
      readonly kind: "wasmgc";
      readonly valueType: ValType;
      /** Non-null ref to the genuine data array. */
      readonly dataType: ValType;
      /** Nullable ref to that same array — the `vec.new_fixed` data scratch. */
      readonly newFixedScratchType: ValType;
      readonly lowering: IrVecLowering;
    }
  | {
      readonly kind: "linear-memory";
      readonly valueType: IrI32ValType;
      readonly dataType: IrI32ValType;
      readonly newFixedScratchType: IrI32ValType;
      readonly lowering: LinearVecLowering;
    };

/** Carrier-only view: kind plus value carrier, never a partial operation handle. */
export type IrVecCarrier =
  | { readonly kind: "wasmgc"; readonly valueType: ValType }
  | { readonly kind: "linear-memory"; readonly valueType: IrI32ValType };

export type IrVecResolutionPurpose = "carrier" | "operation";

/** The resolver capabilities vector resolution may consult. */
export interface IrVecRepresentationResolver {
  resolveType(ref: IrTypeRef): number;
  resolveVec?(valType: ValType): IrVecBackendLowering | null;
  resolveVecForElement?(elementValType: ValType, alloc?: AllocSiteId): IrVecBackendLowering | null;
}

export interface IrVecResolutionInput {
  /** The active backend selected by the emitter/converter, never a target spelling. */
  readonly backend: IrBackendKind;
  readonly type: IrType;
  /** Already-converted element ValType for a logical `vec`; ignored otherwise. */
  readonly elementValType?: ValType;
  /** Construction allocation site (operation resolution only). */
  readonly alloc?: AllocSiteId;
  readonly resolver: IrVecRepresentationResolver;
  /** Function name used in diagnostics. */
  readonly where: string;
}

const i32 = (): IrI32ValType => ({ kind: "i32" });

/** Representation family of a backend; `null` when the backend has no vector representation. */
export function irVecRepresentationKindForBackend(backend: IrBackendKind): IrVecRepresentationKind | null {
  if (backend === "wasmgc") return "wasmgc";
  if (backend === "linear" || backend === "porffor") return "linear-memory";
  return null;
}

/** True for a genuine linear-memory handle (no WasmGC indices). */
export function isLinearVecLowering(handle: IrVecBackendLowering): handle is LinearVecLowering {
  return "linearMemory" in handle;
}

/** True for a genuine WasmGC handle (registered struct, no linear plan). */
export function isWasmGcVecLowering(handle: IrVecBackendLowering): handle is IrVecLowering {
  return !("linearMemory" in handle) && typeof handle.vecStructTypeIdx === "number";
}

/** Every field that exists only on the WasmGC handle; a linear handle carries none of them. */
const GC_ONLY_FIELDS = ["vecStructTypeIdx", "arrayTypeIdx", "lengthFieldIdx", "dataFieldIdx"] as const;

function mismatch(where: string, detail: string): never {
  throw new Error(`ir/lower: vec representation mismatch: ${detail} (${where})`);
}

function requireGc(handle: IrVecBackendLowering, where: string): IrVecLowering {
  if (!isWasmGcVecLowering(handle)) mismatch(where, "wasmgc backend received a non-WasmGC vector handle");
  return handle;
}

function requireLinear(
  handle: IrVecBackendLowering,
  where: string,
  element: ValType | undefined,
  alloc: AllocSiteId | undefined,
): LinearVecLowering {
  if (!isLinearVecLowering(handle)) mismatch(where, "linear-memory backend received a non-linear vector handle");
  for (const gcField of GC_ONLY_FIELDS) {
    if (gcField in handle) mismatch(where, `linear-memory vector handle carries WasmGC field '${gcField}'`);
  }
  if (handle.valueType?.kind !== "i32") mismatch(where, "linear-memory vector handle has no i32 carrier");
  const memory = handle.linearMemory;
  if (memory.layout.kind !== "vector") mismatch(where, `linear-memory vector handle has ${memory.layout.kind} layout`);
  if (element !== undefined && element.kind !== handle.elementValType.kind) {
    mismatch(where, `linear-memory vector element ${handle.elementValType.kind} does not match ${element.kind}`);
  }
  const storage = memory.layout.elementStorage;
  if (storage !== handle.elementValType.kind) {
    mismatch(where, `linear-memory vector layout stores ${storage}, handle element is ${handle.elementValType.kind}`);
  }
  const allocation = memory.allocation;
  if (allocation !== undefined) {
    if (allocation.layoutId !== memory.layout.id) {
      mismatch(where, `allocation site ${allocation.id as number} belongs to '${allocation.layoutId}'`);
    }
    if (alloc !== undefined && allocation.id !== alloc) {
      mismatch(where, `allocation site ${allocation.id as number} was bound for requested site ${alloc as number}`);
    }
  }
  return handle;
}

/** WasmGC carrier of a GC handle: its explicit carrier, else the historical struct-ref default. */
function gcCarrier(handle: IrVecLowering, nullable: boolean): ValType {
  return handle.valueType ?? { kind: nullable ? "ref_null" : "ref", typeIdx: handle.vecStructTypeIdx };
}

function gcRepresentation(lowering: IrVecLowering, valueType: ValType): IrVecRepresentation {
  return {
    kind: "wasmgc",
    valueType,
    dataType: { kind: "ref", typeIdx: lowering.arrayTypeIdx },
    newFixedScratchType: { kind: "ref_null", typeIdx: lowering.arrayTypeIdx },
    lowering,
  };
}

function linearRepresentation(lowering: LinearVecLowering): IrVecRepresentation {
  return { kind: "linear-memory", valueType: i32(), dataType: i32(), newFixedScratchType: i32(), lowering };
}

/**
 * Value carrier of a raw handle for frontend consumers. Linear handles return
 * their own i32 carrier and never evaluate the GC default; GC handles keep the
 * historical `handle.valueType ?? (ref|ref_null $vec)` rule.
 */
export function irVecHandleCarrier(handle: IrVecBackendLowering, nullable: boolean): ValType {
  if (isLinearVecLowering(handle)) return handle.valueType;
  return gcCarrier(handle, nullable);
}

/** Data-region carrier of a raw handle: GC `(ref $array)`, linear i32 element base. */
export function irVecHandleDataType(handle: IrVecBackendLowering): ValType {
  if (isLinearVecLowering(handle)) return i32();
  return { kind: "ref", typeIdx: handle.arrayTypeIdx };
}

/** Narrow a raw handle to the genuine WasmGC handle, or `null` for a linear handle. */
export function irVecGcLowering(handle: IrVecBackendLowering): IrVecLowering | null {
  return isWasmGcVecLowering(handle) ? handle : null;
}

/**
 * Outer representation preflight, shared by every vector resolution path. It
 * rejects an incompatible outer representation (a WasmGC-prepared layout on a
 * linear-memory backend) BEFORE the caller converts the element type, so no
 * element or GC symbolic lookup runs for a vector that cannot be represented.
 * Returns `null` when the backend has no vector representation at all.
 */
export function preflightIrVecRepresentation(
  backend: IrBackendKind,
  type: IrType,
  where: string,
): IrVecRepresentationKind | null {
  const kind = irVecRepresentationKindForBackend(backend);
  if (kind === null) return null;
  // Rule 4: a prepared GC layout cannot be adapted onto linear memory.
  if (type.kind === "vec" && type.layout && kind !== "wasmgc") {
    mismatch(where, `${backend} backend received a WasmGC-prepared vector layout`);
  }
  return kind;
}

export function resolveIrVecRepresentation(
  input: IrVecResolutionInput,
  purpose: "operation",
): IrVecRepresentation | null;
export function resolveIrVecRepresentation(input: IrVecResolutionInput, purpose: "carrier"): IrVecCarrier | null;
/**
 * The single vector resolution algorithm (#6920 rules 1–6). Returns `null`
 * when the active resolver has no representation for the type (callers keep
 * their established "resolver cannot lower" failures) and throws on a backend
 * mismatch before any vector primitive or GC symbolic lookup is attempted.
 */
export function resolveIrVecRepresentation(
  input: IrVecResolutionInput,
  purpose: IrVecResolutionPurpose,
): IrVecRepresentation | IrVecCarrier | null {
  const { backend, type, resolver, where } = input;
  const kind = preflightIrVecRepresentation(backend, type, where);
  if (kind === null) return null;
  if (type.kind === "vec") {
    const element = input.elementValType;
    if (!element) return null;
    if (type.layout) {
      // Rule 1 (the preflight already proved the backend is WasmGC): symbolic lookups in their historical order.
      const refKind = type.nullable ? "ref_null" : "ref";
      if (purpose === "carrier") {
        return { kind: "wasmgc", valueType: { kind: refKind, typeIdx: resolver.resolveType(type.layout.carrierType) } };
      }
      const valueType: ValType = { kind: refKind, typeIdx: resolver.resolveType(type.layout.carrierType) };
      const lowering: IrVecLowering = {
        valueType,
        vecStructTypeIdx: resolver.resolveType(type.layout.carrierType),
        lengthFieldIdx: type.layout.lengthFieldIndex,
        dataFieldIdx: type.layout.dataFieldIndex,
        arrayTypeIdx: resolver.resolveType(type.layout.dataType),
        elementValType: element,
      };
      return gcRepresentation(lowering, valueType);
    }
    // Rules 2/3: layout-free logical vec through the genuine element resolver.
    const alloc = purpose === "operation" ? input.alloc : undefined;
    const raw = resolver.resolveVecForElement?.(element, alloc) ?? null;
    if (!raw) return null;
    if (kind === "wasmgc") {
      const gc = requireGc(raw, where);
      const valueType = gcCarrier(gc, type.nullable === true);
      return purpose === "carrier" ? { kind, valueType } : gcRepresentation(gc, valueType);
    }
    const linear = requireLinear(raw, where, element, alloc);
    return purpose === "carrier" ? { kind, valueType: i32() } : linearRepresentation(linear);
  }
  // Rule 5: physical compatibility route.
  // (Inline `asVal`: this module stays a value-graph leaf with type-only imports.)
  if (type.kind !== "val") return null;
  const valType = type.val;
  const raw = resolver.resolveVec?.(valType) ?? null;
  if (!raw) return null;
  if (kind === "wasmgc") {
    const gc = requireGc(raw, where);
    return purpose === "carrier" ? { kind, valueType: valType } : gcRepresentation(gc, valType);
  }
  const linear = requireLinear(raw, where, undefined, undefined);
  if (valType.kind !== "i32") mismatch(where, `linear-memory vector carried by ${valType.kind}`);
  return purpose === "carrier" ? { kind, valueType: i32() } : linearRepresentation(linear);
}
