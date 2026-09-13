// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../../../wasm/model/instructions.js";
import type { PhysicalModuleReservations, TypeReservation } from "../../../wasm/physical/module-reservations.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  createSignatureWrapperType,
  createBuiltinFunctionMetadataType,
  type ClosureAllocationMode,
} from "../../../runtime/wasmgc/values/closure-layouts.js";

export interface NativeClosureSignatureRequest {
  readonly kind: "signature";
  readonly id: string;
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
  readonly allocationMode: ClosureAllocationMode;
  readonly minimumArgumentCount?: number;
}
export interface NativeClosureMetadataRequest {
  readonly kind: "metadata";
  readonly id: string;
  readonly signatureId: string;
  readonly key: string;
  readonly name: string;
  readonly length: number;
}
export interface NativeClosureRequirements {
  readonly key: string;
  readonly startingClosureCounter: number;
  /** Ordered, including interleaved metadata and later signature cache hits. */
  readonly requests: readonly (NativeClosureSignatureRequest | NativeClosureMetadataRequest)[];
  /** Exact same-ledger prerequisites for every concrete user parameter/result. */
  readonly referenceTypes: readonly TypeReservation[];
}
export interface NativeClosureInfo {
  readonly structTypeIdx: number;
  readonly funcTypeIdx: number;
  readonly returnType: ValType | null;
  readonly paramTypes: readonly ValType[];
  readonly minimumArgumentCount: number | undefined;
  readonly hostOneShotOnly?: boolean;
}
export interface NativeClosureWrapperBinding {
  readonly type: TypeReservation;
  readonly liftedFuncTypeIndex: number;
  readonly liftedSelfTypeIndex: number;
  readonly info: NativeClosureInfo;
}
export interface NativeClosureMetadataBinding {
  readonly type: TypeReservation;
  readonly signature: NativeClosureWrapperBinding;
  readonly info: NativeClosureInfo;
  readonly metadata: { readonly key: string; readonly name: string; readonly length: number; readonly id: number };
}
export type NativeClosureRegistration =
  | { readonly kind: "counter"; readonly value: number }
  | { readonly kind: "type" | "root"; readonly type: TypeReservation }
  | { readonly kind: "signature"; readonly typeIndex: number; readonly selfTypeIndex: number }
  | { readonly kind: "closure-info"; readonly info: NativeClosureInfo }
  | { readonly kind: "wrapper-cache"; readonly key: string; readonly binding: NativeClosureWrapperBinding }
  | { readonly kind: "metadata"; readonly binding: NativeClosureMetadataBinding }
  | { readonly kind: "metadata-cache"; readonly key: string; readonly type: TypeReservation };
export interface NativeClosureReservations {
  readonly root: TypeReservation;
  /** One row per request; cache hits retain the SAME binding object. */
  readonly signatures: readonly { readonly id: string; readonly binding: NativeClosureWrapperBinding }[];
  readonly metadata: readonly { readonly id: string; readonly binding: NativeClosureMetadataBinding }[];
  readonly resultingClosureCounter: number;
  readonly registrations: readonly NativeClosureRegistration[];
}
type MutableInfo = { -readonly [K in keyof NativeClosureInfo]: NativeClosureInfo[K] };
const owners = new WeakMap<
  NativeClosureReservations,
  {
    tx: PhysicalModuleReservations;
    requirements: NativeClosureRequirements;
    snapshot: unknown;
    external: readonly TypeReservation[];
  }
>();
function fail(detail: string): never {
  throw new Error(`native closures: ${detail}`);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}
function signatureKey(request: NativeClosureSignatureRequest): string {
  const key = (types: readonly ValType[]) =>
    types.map((type) => type.kind + ("typeIdx" in type ? type.typeIdx : "")).join(",");
  return `${key(request.params)}->${key(request.results)}`;
}
function requestData(requirements: NativeClosureRequirements) {
  return {
    key: requirements.key,
    startingClosureCounter: requirements.startingClosureCounter,
    requests: requirements.requests,
  };
}
function validateRequests(tx: PhysicalModuleReservations, requirements: NativeClosureRequirements): void {
  if (
    tx.state !== "reserving" ||
    !requirements.key ||
    !Number.isSafeInteger(requirements.startingClosureCounter) ||
    requirements.startingClosureCounter < 0
  )
    fail("invalid reservation phase/key/counter");
  const external = new Map<number, TypeReservation>();
  for (const token of requirements.referenceTypes) {
    tx.assertTypeReservation(token);
    if (external.has(token.typeIndex)) fail("duplicate external type prerequisite");
    external.set(token.typeIndex, token);
  }
  const used = new Set<number>();
  const ids = new Set<string>();
  const signatures = new Map<string, NativeClosureSignatureRequest>();
  const cache = new Map<string, NativeClosureSignatureRequest>();
  const metadata = new Map<
    string,
    { request: NativeClosureMetadataRequest; signature: NativeClosureSignatureRequest }
  >();
  for (const request of requirements.requests) {
    if (!request.id || ids.has(request.id)) fail("missing or duplicate request identity");
    ids.add(request.id);
    if (request.kind === "signature") {
      if (!["support", "ordinary", "host-one-shot"].includes(request.allocationMode)) fail("invalid allocation mode");
      if (
        request.minimumArgumentCount !== undefined &&
        (!Number.isInteger(request.minimumArgumentCount) ||
          request.minimumArgumentCount < 0 ||
          request.minimumArgumentCount > request.params.length)
      )
        fail("invalid observed minimum arity");
      for (const type of [...request.params, ...request.results]) {
        if (["i8", "i16"].includes(type.kind)) fail("packed storage is not a function value type");
        if (type.kind === "ref" || type.kind === "ref_null") {
          if (!external.has(type.typeIdx)) fail("missing concrete reference type prerequisite");
          used.add(type.typeIdx);
        }
      }
      const key = signatureKey(request),
        cached = cache.get(key);
      if (cached)
        same(
          { params: request.params, results: request.results },
          { params: cached.params, results: cached.results },
          "signature cache collision loses physical metadata",
        );
      else cache.set(key, request);
      signatures.set(request.id, request);
    } else if (request.kind === "metadata") {
      const signature = signatures.get(request.signatureId);
      if (!signature) fail("metadata must refer to an earlier genuine signature request");
      if (!request.key || typeof request.name !== "string" || !Number.isInteger(request.length) || request.length < 0)
        fail("invalid metadata identity/name/length");
      if (request.key === "promise:settle")
        same(
          { params: signature.params, results: signature.results, name: request.name, length: request.length },
          { params: [{ kind: "externref" }], results: [], name: "", length: 1 },
          "noncanonical promise:settle request",
        );
      const cached = metadata.get(request.key);
      if (cached)
        same(
          { signature: signatureKey(signature), name: request.name, length: request.length },
          { signature: signatureKey(cached.signature), name: cached.request.name, length: cached.request.length },
          "contradictory metadata cache request",
        );
      else metadata.set(request.key, { request, signature });
    } else fail("unknown closure request kind");
  }
  if (!signatures.size) fail("missing first signature/root");
  if (used.size !== external.size) fail("unused concrete reference prerequisite");
  if (!Number.isSafeInteger(requirements.startingClosureCounter + cache.size)) fail("closure counter overflow");
}

/** No trampoline/body/fill API: these are actual type and lifted-signature resources. */
export function reserveNativeClosureResources(
  tx: PhysicalModuleReservations,
  requirements: NativeClosureRequirements,
): NativeClosureReservations {
  validateRequests(tx, requirements); // Entire population and all foreign tokens checked BEFORE allocation.
  const snapshot = structuredClone(requestData(requirements));
  const cache = new Map<string, NativeClosureWrapperBinding>();
  const byId = new Map<string, NativeClosureWrapperBinding>();
  const metaCache = new Map<string, NativeClosureMetadataBinding>();
  const signatures: { id: string; binding: NativeClosureWrapperBinding }[] = [];
  const metadata: { id: string; binding: NativeClosureMetadataBinding }[] = [];
  const registrations: NativeClosureRegistration[] = [];
  // These are the issued records only, not another public population authority.
  const infos: MutableInfo[] = [];
  const minima = new Map<number, number>();
  // The legacy observer indexes existing records ONCE on its first observation.
  // Later observations add the current wrapper, not every subsequently-created
  // metadata copy. Keep this separate from the full issued-record population.
  let minimumObserverInfos: Set<MutableInfo> | undefined;
  let root: TypeReservation | undefined;
  let counter = requirements.startingClosureCounter;
  // The first wrapper's returned index establishes the append frontier. Each
  // subsequent ledger operation either appends here or interns an older type.
  // No external allocator/callback runs inside this synchronous reservation.
  let nextTypeIndex = -1;
  for (const request of requirements.requests) {
    if (request.kind === "signature") {
      const key = signatureKey(request);
      let binding = cache.get(key);
      if (!binding) {
        const name = `__fn_wrap_${counter++}`;
        registrations.push({ kind: "counter", value: counter });
        const type = tx.reserveType(
          `${requirements.key}:wrapper:${request.id}`,
          createSignatureWrapperType(`${name}_struct`, root?.typeIndex ?? -1),
        );
        registrations.push({ kind: "type", type });
        if (!root) {
          root = type;
          registrations.push({ kind: "root", type });
        }
        const params = request.params.map((type) => Object.freeze({ ...type }));
        const results = request.results.map((type) => Object.freeze({ ...type }));
        const liftedFuncTypeIndex = tx.internFunctionType(
          [{ kind: "ref", typeIdx: root.typeIndex }, ...params],
          results,
          `${name}_type`,
        );
        nextTypeIndex = Math.max(type.typeIndex, liftedFuncTypeIndex) + 1;
        registrations.push({ kind: "signature", typeIndex: liftedFuncTypeIndex, selfTypeIndex: root.typeIndex });
        const info: MutableInfo = {
          structTypeIdx: type.typeIndex,
          funcTypeIdx: liftedFuncTypeIndex,
          returnType: results[0] ?? null,
          paramTypes: Object.freeze(params),
          minimumArgumentCount: undefined,
        };
        infos.push(info);
        binding = { type, liftedFuncTypeIndex, liftedSelfTypeIndex: root.typeIndex, info };
        // Observe flags/minimum before publication, matching the legacy adapters.
        observe(binding, request);
        registrations.push({ kind: "closure-info", info });
        cache.set(key, binding);
        registrations.push({ kind: "wrapper-cache", key, binding });
      } else observe(binding, request);
      byId.set(request.id, binding);
      signatures.push(Object.freeze({ id: request.id, binding }));
    } else {
      let binding = metaCache.get(request.key);
      if (!binding) {
        const signature = byId.get(request.signatureId)!;
        // Preserve the donor's index-bearing name without allocating a dummy
        // type or mutating a descriptor already authenticated by the ledger.
        const typeIndex = nextTypeIndex;
        const type = tx.reserveType(
          `${requirements.key}:metadata:${request.id}`,
          createBuiltinFunctionMetadataType(typeIndex, signature.type.typeIndex),
        );
        if (type.typeIndex !== typeIndex) fail("unexpected metadata type coordinate");
        nextTypeIndex = type.typeIndex + 1;
        registrations.push({ kind: "type", type });
        const info: MutableInfo = { ...signature.info, structTypeIdx: type.typeIndex };
        infos.push(info);
        registrations.push({ kind: "closure-info", info });
        binding = {
          type,
          signature,
          info,
          metadata: Object.freeze({ key: request.key, name: request.name, length: request.length, id: type.typeIndex }),
        };
        registrations.push({ kind: "metadata", binding });
        metaCache.set(request.key, binding);
        registrations.push({ kind: "metadata-cache", key: request.key, type });
      }
      metadata.push(Object.freeze({ id: request.id, binding }));
    }
  }
  function observe(binding: NativeClosureWrapperBinding, request: NativeClosureSignatureRequest): void {
    const info = binding.info as MutableInfo;
    if (request.minimumArgumentCount !== undefined) {
      const minimum = Math.min(minima.get(info.funcTypeIdx) ?? info.paramTypes.length, request.minimumArgumentCount);
      minima.set(info.funcTypeIdx, minimum);
      // Match ensureLiveClosureInfoIndex's lazy snapshot plus explicit wrapper
      // indexing. Metadata copied after that snapshot retains its copied minimum;
      // metadata already present at the first observation is synchronized.
      // There are no wrapper-record replacements in this pack. The legacy
      // constructible/cache/closureMap records remain with their current owner.
      minimumObserverInfos ??= new Set(infos);
      minimumObserverInfos.add(info);
      for (const record of minimumObserverInfos)
        if (record.funcTypeIdx === info.funcTypeIdx)
          record.minimumArgumentCount = Math.min(record.minimumArgumentCount ?? record.paramTypes.length, minimum);
    }
    if (request.allocationMode === "ordinary") info.hostOneShotOnly = false;
    else if (request.allocationMode === "host-one-shot" && info.hostOneShotOnly === undefined)
      info.hostOneShotOnly = true;
  }
  for (const info of infos) Object.freeze(info);
  for (const binding of cache.values()) Object.freeze(binding);
  for (const binding of metaCache.values()) Object.freeze(binding);
  const pack = Object.freeze({
    root: root!,
    signatures: Object.freeze(signatures),
    metadata: Object.freeze(metadata),
    resultingClosureCounter: counter,
    registrations: Object.freeze(registrations.map((record) => Object.freeze(record))),
  });
  owners.set(pack, { tx, requirements, snapshot, external: Object.freeze([...requirements.referenceTypes]) });
  return pack;
}

/** Authenticate the exact issued pack at reserve time or after the shared freeze. */
export function requireNativeClosureReservations(
  tx: PhysicalModuleReservations,
  pack: NativeClosureReservations,
): NativeClosureReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied closure pack");
  same(requestData(owner.requirements), owner.snapshot, "stale closure request sequence");
  if (
    owner.requirements.referenceTypes.length !== owner.external.length ||
    owner.external.some((token, index) => token !== owner.requirements.referenceTypes[index])
  )
    fail("stale external type tokens");
  const tokens = new Set([
    ...owner.external,
    pack.root,
    ...pack.signatures.map((row) => row.binding.type),
    ...pack.metadata.map((row) => row.binding.type),
  ]);
  for (const token of tokens) {
    if (tx.state === "reserving") tx.assertTypeReservation(token);
    else if (tx.physicalIndex(token) !== token.typeIndex) fail("closure type coordinate mismatch");
  }
  return pack;
}
