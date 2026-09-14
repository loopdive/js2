// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../../../wasm/model/instructions.js";
import type { PhysicalModuleReservations, TypeReservation } from "../../../wasm/physical/module-reservations.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  createSignatureWrapperShape,
  createBuiltinFunctionMetadataShape,
  type ClosureAllocationMode,
} from "../../../runtime/wasmgc/values/closure-layouts.js";
import type {
  NativeDeclaredValType,
  NativeResourceRecipe,
  NativeStringValueDeclaration,
  NativeStringValueReservationStep,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  instantiateNativeDeclaredValType,
  instantiateNativeDeclaredType,
  instantiateNativeDeclaredSignature,
  type NativeDeclaredTypeTokens,
  type NativeDeclaredReservation,
} from "./native-resource-declarations.js";

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
export type NativeClosureDeclaredSignatureRequest = Omit<NativeClosureSignatureRequest, "params" | "results"> & {
  readonly params: readonly NativeDeclaredValType[];
  readonly results: readonly NativeDeclaredValType[];
};
export interface NativeClosureDeclarationRequirements {
  readonly key: string;
  readonly startingClosureCounter: number;
  readonly requests: readonly (NativeClosureDeclaredSignatureRequest | NativeClosureMetadataRequest)[];
  readonly referenceTypeKeys: readonly string[];
}
export interface NativeClosureDeclarationPlan extends NativeResourceRecipe {
  readonly requirements: NativeClosureDeclarationRequirements;
  readonly rootKey: string;
  readonly signatures: readonly {
    readonly requestId: string;
    readonly wrapperKey: string;
    readonly liftedSignatureKey: string;
  }[];
  readonly metadata: readonly {
    readonly requestId: string;
    readonly signatureRequestId: string;
    readonly typeKey: string;
  }[];
  readonly resultingClosureCounter: number;
}

export function declareNativeClosureResources(
  requirements: NativeClosureDeclarationRequirements,
): NativeClosureDeclarationPlan {
  return walkClosureDeclarations(requirements).plan;
}
function walkClosureDeclarations(requirements: NativeClosureDeclarationRequirements) {
  const stepEnds: number[] = [];
  if (
    !requirements.key ||
    !Number.isSafeInteger(requirements.startingClosureCounter) ||
    requirements.startingClosureCounter < 0
  )
    fail("invalid declaration key/counter");
  const declarations: NativeStringValueDeclaration[] = [],
    reservationSteps: NativeStringValueReservationStep[] = [];
  const signatures: { requestId: string; wrapperKey: string; liftedSignatureKey: string }[] = [];
  const metadata: { requestId: string; signatureRequestId: string; typeKey: string }[] = [];
  const external = new Set(requirements.referenceTypeKeys),
    used = new Set<string>(),
    ids = new Set<string>();
  if (external.size !== requirements.referenceTypeKeys.length || [...external].some((key) => !key))
    fail("invalid declaration prerequisites");
  const cache = new Map<string, { wrapperKey: string; liftedSignatureKey: string }>();
  const cacheRequests = new Map<string, NativeClosureDeclaredSignatureRequest>();
  const byId = new Map<
    string,
    { request: NativeClosureDeclaredSignatureRequest; cacheKey: string; wrapperKey: string }
  >();
  const metaCache = new Map<string, { request: NativeClosureMetadataRequest; signatureKey: string; typeKey: string }>();
  let counter = requirements.startingClosureCounter,
    rootKey = "";
  const add = (row: NativeStringValueDeclaration) => {
    declarations.push(row);
    reservationSteps.push({ phase: "resources", kind: "reserve", resourceKey: row.key });
  };
  for (const request of requirements.requests) {
    if (!request || !request.id || ids.has(request.id)) fail("missing or duplicate request identity");
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
        if ("typeIdx" in type) fail("numeric reference in declaration");
        if (type.kind === "ref" || type.kind === "ref_null") {
          if (!external.has(type.typeKey)) fail("missing concrete reference type prerequisite");
          used.add(type.typeKey);
        }
      }
      const valueKey = (type: NativeDeclaredValType) =>
        type.kind === "ref" || type.kind === "ref_null" ? [type.kind, type.typeKey] : [type.kind];
      const cacheKey = JSON.stringify([request.params.map(valueKey), request.results.map(valueKey)]);
      let binding = cache.get(cacheKey);
      const cachedRequest = cacheRequests.get(cacheKey);
      if (cachedRequest)
        same(
          { params: request.params, results: request.results },
          { params: cachedRequest.params, results: cachedRequest.results },
          "signature cache collision loses physical metadata",
        );
      if (!binding) {
        const name = `__fn_wrap_${counter++}`,
          wrapperKey = `${requirements.key}:wrapper:${request.id}`,
          liftedSignatureKey = `${requirements.key}:lifted:${request.id}`;
        add({
          key: wrapperKey,
          role: ["closure-wrapper", request.id],
          space: "type",
          shape: createSignatureWrapperShape(
            name + "_struct",
            rootKey ? { kind: "resource", typeKey: rootKey } : { kind: "root" },
          ),
        });
        rootKey ||= wrapperKey;
        reservationSteps.push({
          phase: "resources",
          kind: "intern-signature",
          key: liftedSignatureKey,
          name: name + "_type",
          signature: { params: [{ kind: "ref", typeKey: rootKey }, ...request.params], results: request.results },
        });
        binding = { wrapperKey, liftedSignatureKey };
        cache.set(cacheKey, binding);
        cacheRequests.set(cacheKey, request);
      }
      signatures.push({ requestId: request.id, ...binding });
      byId.set(request.id, { request, cacheKey, wrapperKey: binding.wrapperKey });
    } else if (request.kind === "metadata") {
      const signature = byId.get(request.signatureId);
      if (!signature) fail("metadata must refer to an earlier genuine signature request");
      if (!request.key || typeof request.name !== "string" || !Number.isInteger(request.length) || request.length < 0)
        fail("invalid metadata identity/name/length");
      if (request.key === "promise:settle")
        same(
          {
            params: signature.request.params,
            results: signature.request.results,
            name: request.name,
            length: request.length,
          },
          { params: [{ kind: "externref" }], results: [], name: "", length: 1 },
          "noncanonical promise:settle request",
        );
      let binding = metaCache.get(request.key);
      if (binding)
        same(
          { signature: signature.cacheKey, name: request.name, length: request.length },
          { signature: binding.signatureKey, name: binding.request.name, length: binding.request.length },
          "contradictory metadata cache request",
        );
      else {
        const typeKey = `${requirements.key}:metadata:${request.id}`;
        add({
          key: typeKey,
          role: ["closure-metadata", request.id],
          space: "type",
          shape: createBuiltinFunctionMetadataShape(
            { kind: "builtin-function-metadata-index", typeKey },
            { kind: "resource", typeKey: signature.wrapperKey },
          ),
        });
        binding = { request, signatureKey: signature.cacheKey, typeKey };
        metaCache.set(request.key, binding);
      }
      metadata.push({ requestId: request.id, signatureRequestId: request.signatureId, typeKey: binding.typeKey });
    } else fail("unknown closure request kind");
    stepEnds.push(reservationSteps.length);
  }
  if (!rootKey) fail("missing first signature/root");
  if (used.size !== external.size) fail("unused concrete reference prerequisite");
  if (!Number.isSafeInteger(counter)) fail("closure counter overflow");
  const plan = {
    requirements,
    rootKey,
    signatures,
    metadata,
    resultingClosureCounter: counter,
    declarations,
    reservationSteps,
  };
  preflightNativeResourceRecipe(plan, requirements.referenceTypeKeys);
  return { plan: freezeNativeResourceRecipe(plan), stepEnds: Object.freeze(stepEnds) };
}
function validateCut(plan: NativeClosureDeclarationPlan, end: number): void {
  const requests = plan.requirements.requests;
  if (!Number.isSafeInteger(end) || end < 1 || end > requests.length) fail("invalid closure request cut");
  if (end < requests.length && requests.slice(end).some((request) => request.kind === "metadata"))
    fail("metadata cannot remain after a closure pause");
}
export function nativeClosureReservationStepEnd(
  plan: NativeClosureDeclarationPlan,
  endRequestExclusive: number,
): number {
  const canonical = walkClosureDeclarations(plan.requirements);
  same(plan, canonical.plan, "substituted closure declaration plan");
  validateCut(plan, endRequestExclusive);
  return canonical.stepEnds[endRequestExclusive - 1]!;
}

export function instantiateNativeClosureRequirements(
  tx: PhysicalModuleReservations,
  plan: NativeClosureDeclarationPlan,
  types: NativeDeclaredTypeTokens,
): NativeClosureRequirements {
  same(plan, declareNativeClosureResources(plan.requirements), "substituted closure declaration plan");
  if (types.size !== plan.requirements.referenceTypeKeys.length) fail("extra declaration prerequisite");
  const referenceTypes = plan.requirements.referenceTypeKeys.map((key) => {
    const token = types.get(key);
    if (!token || token.key !== key) fail("missing concrete reference type prerequisite");
    tx.assertTypeReservation(token);
    return token;
  });
  const requests = plan.requirements.requests.map((request) =>
    request.kind === "metadata"
      ? request
      : {
          ...request,
          params: request.params.map((type) => instantiateNativeDeclaredValType(tx, type, types)),
          results: request.results.map((type) => instantiateNativeDeclaredValType(tx, type, types)),
        },
  );
  const result = {
    key: plan.requirements.key,
    startingClosureCounter: plan.requirements.startingClosureCounter,
    requests,
    referenceTypes,
  };
  validateRequests(tx, result);
  return result;
}

function symbolicRequirements(requirements: NativeClosureRequirements): NativeClosureDeclarationRequirements {
  const value = (type: ValType): NativeDeclaredValType => {
    if (type.kind !== "ref" && type.kind !== "ref_null") return { ...type };
    const token = requirements.referenceTypes.find((row) => row.typeIndex === type.typeIdx);
    if (!token) fail("missing concrete reference type prerequisite");
    return { kind: type.kind, typeKey: token.key };
  };
  return {
    key: requirements.key,
    startingClosureCounter: requirements.startingClosureCounter,
    requests: requirements.requests.map((request) =>
      request.kind === "metadata"
        ? request
        : { ...request, params: request.params.map(value), results: request.results.map(value) },
    ),
    referenceTypeKeys: requirements.referenceTypes.map((token) => token.key),
  };
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
interface ClosureOwner {
  tx: PhysicalModuleReservations;
  requirements: NativeClosureRequirements;
  snapshot: unknown;
  external: readonly TypeReservation[];
  plan: NativeClosureDeclarationPlan;
  stepEnds: readonly number[];
  requestCursor: number;
  operationCursor: number;
  complete: boolean;
  failed: boolean;
  engine: Generator<NativeClosureReservations, NativeClosureReservations, void>;
  evidence: readonly PrefixEvidence[];
}
interface PrefixEvidence {
  object: object;
  keys: readonly PropertyKey[];
  descriptors: PropertyDescriptorMap;
}
const owners = new WeakMap<NativeClosureReservations, ClosureOwner>();
function prefixEvidence(pack: NativeClosureReservations): readonly PrefixEvidence[] {
  const result: PrefixEvidence[] = [],
    seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const keys = Reflect.ownKeys(value),
      descriptors = Object.getOwnPropertyDescriptors(value);
    result.push({ object: value, keys, descriptors });
    for (const key of keys) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (!Object.hasOwn(descriptor, "value")) fail("closure prefix contains an accessor");
      visit(descriptor.value);
    }
  };
  visit(pack);
  return result;
}
function assertPrefixEvidence(owner: ClosureOwner): void {
  for (const row of owner.evidence) {
    const keys = Reflect.ownKeys(row.object);
    if (keys.length !== row.keys.length || keys.some((key, index) => key !== row.keys[index]))
      fail("changed issued closure prefix keys");
    for (const key of keys) {
      const expected = Reflect.get(row.descriptors, key) as PropertyDescriptor;
      const actual = Object.getOwnPropertyDescriptor(row.object, key)!;
      if (
        !Object.hasOwn(actual, "value") ||
        !Object.is(actual.value, expected.value) ||
        actual.writable !== expected.writable ||
        actual.enumerable !== expected.enumerable ||
        actual.configurable !== expected.configurable
      )
        fail("changed issued closure prefix identity/value");
    }
  }
}
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

/** Atomic compatibility entry point; the same owner consumes the complete cut. */
export function reserveNativeClosureResources(
  tx: PhysicalModuleReservations,
  requirements: NativeClosureRequirements,
  expectedPlan?: NativeClosureDeclarationPlan,
): NativeClosureReservations {
  validateRequests(tx, requirements);
  const plan = expectedPlan ?? declareNativeClosureResources(symbolicRequirements(requirements));
  return reserveNativeClosureResourcesPrefix(tx, requirements, plan, requirements.requests.length);
}
export function reserveNativeClosureResourcesPrefix(
  tx: PhysicalModuleReservations,
  requirements: NativeClosureRequirements,
  expectedPlan: NativeClosureDeclarationPlan,
  endRequestExclusive: number,
): NativeClosureReservations {
  validateRequests(tx, requirements);
  const canonical = walkClosureDeclarations(symbolicRequirements(requirements));
  same(canonical.plan, expectedPlan, "substituted closure declaration plan");
  validateCut(expectedPlan, endRequestExclusive);
  const owner: ClosureOwner = {
    tx,
    requirements,
    snapshot: structuredClone(requestData(requirements)),
    external: Object.freeze([...requirements.referenceTypes]),
    plan: expectedPlan,
    stepEnds: canonical.stepEnds,
    requestCursor: 0,
    operationCursor: 0,
    complete: false,
    failed: false,
    evidence: [],
    engine: reserveClosureEngine(tx, requirements, expectedPlan, canonical.stepEnds),
  };
  return advanceClosureOwner(owner, endRequestExclusive);
}
function advanceClosureOwner(owner: ClosureOwner, end: number): NativeClosureReservations {
  try {
    let pack: NativeClosureReservations | undefined;
    while (owner.requestCursor < end) {
      const result = owner.engine.next();
      pack = result.value;
      owner.requestCursor++;
      owner.operationCursor = owner.stepEnds[owner.requestCursor - 1]!;
      owner.complete = result.done === true;
      if (owner.complete !== (owner.requestCursor === owner.requirements.requests.length))
        fail("closure engine completion mismatch");
    }
    if (!pack) fail("closure request cursor did not advance");
    owners.set(pack, owner);
    owner.evidence = prefixEvidence(pack);
    return pack;
  } catch (error) {
    owner.failed = true;
    throw error;
  }
}
export function resumeNativeClosureResources(
  tx: PhysicalModuleReservations,
  pack: NativeClosureReservations,
  endRequestExclusive: number,
): NativeClosureReservations {
  const owner = requireClosureOwner(tx, pack);
  if (owner.complete) fail("closure pack already complete");
  validateCut(owner.plan, endRequestExclusive);
  if (endRequestExclusive <= owner.requestCursor) fail("closure resume must advance");
  return advanceClosureOwner(owner, endRequestExclusive);
}
function* reserveClosureEngine(
  tx: PhysicalModuleReservations,
  requirements: NativeClosureRequirements,
  plan: NativeClosureDeclarationPlan,
  stepEnds: readonly number[],
): Generator<NativeClosureReservations, NativeClosureReservations, void> {
  const types = new Map(requirements.referenceTypes.map((token) => [token.key, token]));
  let cursor = 0;
  const reserve = (key: string, self?: number): TypeReservation => {
    const step = plan.reservationSteps[cursor++];
    if (step?.kind !== "reserve" || step.resourceKey !== key) fail("closure recipe operation mismatch");
    const row = plan.declarations.find((entry) => entry.key === key);
    if (row?.space !== "type") fail("missing closure type declaration");
    const token = tx.reserveType(
      key,
      instantiateNativeDeclaredType(tx, row.shape, types, self === undefined ? undefined : { key, typeIndex: self }),
    );
    types.set(key, token);
    return token;
  };
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
  let pack: { -readonly [K in keyof NativeClosureReservations]: NativeClosureReservations[K] } | undefined;
  let requestCursor = 0;
  for (const request of requirements.requests) {
    if (request.kind === "signature") {
      const key = signatureKey(request);
      let binding = cache.get(key);
      if (!binding) {
        const name = `__fn_wrap_${counter++}`;
        registrations.push({ kind: "counter", value: counter });
        const type = reserve(`${requirements.key}:wrapper:${request.id}`);
        registrations.push({ kind: "type", type });
        if (!root) {
          root = type;
          registrations.push({ kind: "root", type });
        }
        const params = request.params.map((type) => Object.freeze({ ...type }));
        const results = request.results.map((type) => Object.freeze({ ...type }));
        const step = plan.reservationSteps[cursor++];
        if (step?.kind !== "intern-signature" || step.name !== `${name}_type`)
          fail("closure signature operation mismatch");
        const signature = instantiateNativeDeclaredSignature(tx, step.signature, types);
        same(
          signature,
          { params: [{ kind: "ref", typeIdx: root.typeIndex }, ...params], results },
          "closure lifted signature mismatch",
        );
        const liftedFuncTypeIndex = tx.internFunctionType(signature.params, signature.results, step.name);
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
        const type = reserve(`${requirements.key}:metadata:${request.id}`, typeIndex);
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
    requestCursor++;
    if (cursor !== stepEnds[requestCursor - 1]) fail("closure recipe operation boundary mismatch");
    pack ??= { root: root!, signatures, metadata, resultingClosureCounter: counter, registrations };
    pack.resultingClosureCounter = counter;
    if (requestCursor < requirements.requests.length) yield pack;
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
  if (cursor !== plan.reservationSteps.length || counter !== plan.resultingClosureCounter)
    fail("unconsumed closure recipe operations");
  for (const binding of cache.values()) Object.freeze(binding);
  for (const binding of metaCache.values()) Object.freeze(binding);
  Object.freeze(signatures);
  Object.freeze(metadata);
  for (const record of registrations) Object.freeze(record);
  Object.freeze(registrations);
  return Object.freeze(pack!);
}

/** Authenticate the exact issued pack at reserve time or after the shared freeze. */
function requireClosureOwner(tx: PhysicalModuleReservations, pack: NativeClosureReservations): ClosureOwner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied closure pack");
  if (owner.failed) fail("failed closure reservation owner");
  if (!owner.complete && tx.state !== "reserving") fail("unfinished closure pack requires reserving phase");
  assertPrefixEvidence(owner);
  same(requestData(owner.requirements), owner.snapshot, "stale closure request sequence");
  same(
    declareNativeClosureResources(symbolicRequirements(owner.requirements)),
    owner.plan,
    "stale closure declaration plan",
  );
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
  return owner;
}
export function requireNativeClosureReservations(
  tx: PhysicalModuleReservations,
  pack: NativeClosureReservations,
): NativeClosureReservations {
  const owner = requireClosureOwner(tx, pack);
  if (!owner.complete) fail("incomplete closure reservation population");
  return pack;
}
export function requireNativeClosureReservationPrefix(
  tx: PhysicalModuleReservations,
  pack: NativeClosureReservations,
  requestId: string,
): NativeClosureReservations {
  const owner = requireClosureOwner(tx, pack);
  const index = owner.requirements.requests.findIndex((request) => request.id === requestId);
  if (index < 0 || index >= owner.requestCursor) fail("missing or future closure request");
  if (owner.complete) return requireNativeClosureReservations(tx, pack);
  return pack;
}

export function nativeClosureReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeClosureReservations,
  expectedPlan: NativeClosureDeclarationPlan,
): readonly NativeDeclaredReservation[] {
  const owner = owners.get(pack);
  if (!owner || owner.plan !== expectedPlan) fail("foreign or substituted closure declaration plan");
  requireNativeClosureReservations(tx, pack);
  const tokens = new Map(
    [...pack.signatures.map((row) => row.binding.type), ...pack.metadata.map((row) => row.binding.type)].map(
      (token) => [token.key, token],
    ),
  );
  return Object.freeze(
    expectedPlan.declarations.map((row) => {
      const token = tokens.get(row.key);
      if (!token) fail("missing owned closure declaration");
      return token;
    }),
  );
}
