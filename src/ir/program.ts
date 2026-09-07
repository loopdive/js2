// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBackendKind } from "./backend/legality.js";
import type { IrBindingId, IrSourceId, IrTerminalUnitRecord, IrUnitId, IrUnitInventory } from "./identity.js";
import {
  IR_CLASS_SHAPE_CELL,
  type IrClassShape,
  type IrFuncRef,
  type IrGlobalRef,
  type IrModule,
  type IrType,
  type IrTypeRef,
} from "./nodes.js";
import type { ProgramAbiCallableSignature, ProgramAbiDerivedUnitRecord, ProgramAbiPlanEntry } from "./program-abi.js";
import type { IrCanonicalPromiseAbi } from "./async-plan.js";
import type { PreparedIrRuntimeManifest } from "./intrinsic-support.js";
import type { IrModuleInitPlan } from "./module-init-plan.js";
import type { IrPreparationFailure } from "./outcomes.js";
import type { PreparedComponentAbiLookup } from "./prepared-component-dependencies.js";
import type { RuntimeManifestPolicy } from "./runtime-manifest.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import type { AllocRegistrySnapshot } from "./alloc-registry.js";
import type { WasmModule } from "./types.js";
import type { LinearOptions } from "../codegen-linear/index.js";

/** Semantic contracts enrich the existing ABI entries; there is no second binding authority. */
export type PreparedIrAbiContract =
  | {
      readonly kind: "callable";
      readonly ref: IrFuncRef;
      readonly params: readonly IrType[];
      readonly results: readonly IrType[];
      readonly promise?: IrCanonicalPromiseAbi;
    }
  | { readonly kind: "global"; readonly ref: IrGlobalRef; readonly type: IrType; readonly mutable: boolean }
  | { readonly kind: "type"; readonly ref: IrTypeRef; readonly type: IrType }
  | { readonly kind: "class"; readonly ref: IrTypeRef; readonly shape: IrClassShape }
  | { readonly kind: "export"; readonly externalName: string; readonly targetId: IrBindingId }
  | { readonly kind: "support"; readonly role: string };

export interface PreparedIrAbiEntry {
  readonly plan: ProgramAbiPlanEntry;
  readonly contract: PreparedIrAbiContract;
}

/** Data only. Lookup methods are reconstructed from these entries after decoding. */
export interface PreparedIrAbiSnapshot {
  readonly entries: readonly PreparedIrAbiEntry[];
}

/** One complete producer input while the frontend still owns preparation. */
export interface PreparedIrProgramProducerInput {
  readonly inventory: IrUnitInventory;
  readonly ir: IrModule;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly abi: PreparedComponentAbiLookup;
  readonly policy: RuntimeManifestPolicy;
}

export type PreparedIrProgramFailure = IrPreparationFailure & {
  readonly unitId: IrUnitId;
  readonly location: PreparedIrSourceLocation;
  readonly sourceFile: string;
};

/** Backend attachment phase, distinct from the semantic functions and async plans. */
export interface PreparedIrProgramRuntimeProjection {
  readonly backend: RuntimeManifestPolicy["backend"];
  readonly target: RuntimeManifestPolicy["target"];
  readonly prepared: PreparedIrRuntimeManifest;
}

/**
 * The single source-to-backend handoff. The original terminal inventory is the
 * complete denominator; pass-created bodies join it through derivedUnits.
 * declaredSignatures/declaredGlobals in ir remain partial pass tables, never
 * proof of complete call/global closure. The ABI entries provide that proof.
 *
 * Construct only through whole-program preparation. No source/checker objects,
 * emitter callbacks, direct-body alternatives, or mutable allocator handles
 * belong in this snapshot. Runtime attachments retain their exact plan/manifest
 * joins and must be revalidated by the runtime producer after codec replay.
 */
export interface PreparedIrProgram {
  readonly schema: "prepared-ir-program-v1";
  readonly inventory: IrUnitInventory;
  readonly units: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly ir: IrModule;
  readonly abi: PreparedIrAbiSnapshot;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  /** Includes empty sources and preserves semantic module evaluation order. */
  readonly startup: readonly IrModuleInitPlan[];
  readonly allocations: AllocRegistrySnapshot;
  readonly runtime: readonly PreparedIrProgramRuntimeProjection[];
  readonly reconciliation: "complete";
  readonly sealed: true;
}

export type IrProgramPreparationResult =
  | { readonly kind: "prepared"; readonly program: PreparedIrProgram }
  | PreparedIrProgramFailure;

/** Resolved physical setup only; no source, policy callback or frontend option bag. */
export interface PreparedIrBackendOptions {
  readonly backend: RuntimeManifestPolicy["backend"];
  readonly target: RuntimeManifestPolicy["target"];
  readonly sharedExceptionTag: boolean;
  readonly utf8Storage: boolean;
  readonly sourceMap: boolean;
  readonly moduleName: string;
  readonly linear?: Readonly<
    Pick<
      LinearOptions,
      "exposeArenaReset" | "allocationPolicy" | "externImports" | "importMemory" | "linkedHeap" | "heapAllocator"
    >
  >;
}

declare const acceptedPreparedIrProgramBrand: unique symbol;

/** C owns token authentication; emitting a structurally forged acceptance must fail. */
export interface AcceptedPreparedIrProgram {
  readonly kind: "accepted";
  readonly [acceptedPreparedIrProgramBrand]: true;
  readonly program: PreparedIrProgram;
  readonly options: PreparedIrBackendOptions;
  readonly runtime: PreparedIrProgramRuntimeProjection;
}

export type PreparedIrBackendAcceptance = AcceptedPreparedIrProgram | PreparedIrProgramFailure;

/** Exact physical body receipts, returned by C's actual emission loop. */
export interface EmittedPreparedIrProgram {
  readonly module: WasmModule;
  readonly emittedUnitIds: readonly IrUnitId[];
}

export interface PreparedIrProgramOwner {
  readonly unitId: IrUnitId;
  readonly location: PreparedIrSourceLocation;
  readonly sourceFile: string;
}

/** Resolve diagnostics through the existing original/derived ownership records. */
export function preparedIrProgramOwner(
  input: Pick<PreparedIrProgramProducerInput, "inventory" | "derivedUnits">,
  unitId: IrUnitId,
): PreparedIrProgramOwner | undefined {
  const derived = input.derivedUnits.find((record) => record.id === unitId);
  const source = input.inventory.allUnits.find((record) => record.id === unitId);
  const ownerId = derived?.terminalOwnerId ?? source?.terminalOwnerId ?? unitId;
  const owner = input.inventory.terminalUnits.find((record) => record.id === ownerId);
  if (!owner) return undefined;
  const sourceRecord = input.inventory.sources.find((record) => record.id === owner.sourceId);
  if (!sourceRecord) return undefined;
  return Object.freeze({
    unitId: owner.id,
    sourceFile: sourceRecord.sourceKey,
    location: Object.freeze({
      sourceId: owner.sourceId,
      line: owner.line,
      column: owner.column,
      declarationStart: owner.declarationStart,
      declarationEnd: owner.declarationEnd,
    }),
  });
}

/** Reconstructed read surface over the one owned ABI entry vector. */
export function preparedIrProgramAbiLookup(program: PreparedIrProgram): PreparedComponentAbiLookup {
  assertPreparedIrProgram(program);
  const entries = Object.freeze(program.abi.entries.map(({ plan }) => plan));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", "program ABI contains duplicate binding IDs");
  }
  return Object.freeze({
    get: (id: IrBindingId) => byId.get(id),
    entries: () => entries,
    bindingIdsForStructuralReference: (key: string) =>
      Object.freeze(entries.filter((entry) => entry.structuralReferenceKey === key).map((entry) => entry.id)),
  });
}

export type PreparedIrCandidateRoute = "ir" | "direct" | "neither";
export type PreparedIrEmitter = Exclude<PreparedIrCandidateRoute, "neither">;

export type PreparedIrProgramInvariantCode =
  | "abi-not-sealed"
  | "program-sealed"
  | "program-seal-failed"
  | "duplicate-unit"
  | "missing-unit"
  | "unknown-unit"
  | "duplicate-component-candidate"
  | "empty-component-candidate"
  | "duplicate-support-intent-candidate"
  | "late-support-intent"
  | "unknown-support-owner"
  | "unknown-support-binding"
  | "duplicate-allocation-candidate"
  | "allocation-not-ir-candidate-owned"
  | "duplicate-provenance-candidate"
  | "provenance-not-ir-candidate-owned"
  | "invalid-prepared-data"
  | "program-has-invariant-candidate"
  | "invalid-transaction-capability"
  | "emission-already-started"
  | "transaction-closed"
  | "wrong-emitter"
  | "duplicate-emission"
  | "unknown-emission-unit"
  | "partial-publication"
  | "emission-failed";

export class PreparedIrProgramInvariantError extends Error {
  constructor(
    readonly code: PreparedIrProgramInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "PreparedIrProgramInvariantError";
  }
}

export interface PreparedIrSourceLocation {
  readonly sourceId: IrSourceId;
  readonly line: number;
  readonly column: number;
  readonly declarationStart: number;
  readonly declarationEnd: number;
}

export interface PreparedIrAssertedOptimizationEvidence {
  readonly inlineSmall: "applied" | "not-applicable";
  readonly monomorphization: "applied" | "not-applicable";
  readonly allocationProvenance: "verified";
}

export interface PreparedIrAssertedBackendLegality {
  readonly backend: IrBackendKind;
  readonly target: "gc" | "linear" | "standalone" | "wasi";
  readonly verified: true;
}

interface PreparedIrCandidateBase {
  readonly unitId: IrUnitId;
  readonly location: PreparedIrSourceLocation;
  /** This structural slice does not make the record production-authoritative. */
  readonly evidenceStatus: "unvalidated-candidate";
}

export interface PreparedIrIrCandidate extends PreparedIrCandidateBase {
  readonly kind: "ir-candidate";
  readonly route: "ir";
  readonly assertedSignature: ProgramAbiCallableSignature;
  readonly assertedExportIntents: readonly IrBindingId[];
  readonly assertedBackendLegality: PreparedIrAssertedBackendLegality;
  readonly assertedOptimization: PreparedIrAssertedOptimizationEvidence;
  readonly irCandidate: unknown;
}

export interface PreparedIrDirectCandidate extends PreparedIrCandidateBase {
  readonly kind: "direct-candidate";
  readonly route: "direct";
  readonly code: string;
  readonly stage: string;
  readonly detail: string;
}

export interface PreparedIrInvariantCandidate extends PreparedIrCandidateBase {
  readonly kind: "invariant-candidate";
  readonly route: "neither";
  readonly code: string;
  readonly stage: string;
  readonly detail: string;
}

export type PreparedIrUnitCandidate = PreparedIrIrCandidate | PreparedIrDirectCandidate | PreparedIrInvariantCandidate;

/**
 * Caller-supplied grouping hint only. Production wiring must rebuild and
 * reconcile components from authoritative IR call/ABI edges.
 */
export interface PreparedIrComponentCandidate {
  readonly id: string;
  readonly unitIds: readonly IrUnitId[];
  readonly candidateRoutes: readonly PreparedIrCandidateRoute[];
  readonly evidenceStatus: "unvalidated-component-candidate";
}

export type PreparedIrSupportIntentKind =
  | "import"
  | "global"
  | "type"
  | "literal"
  | "helper"
  | "lifted-closure"
  | "host-callback"
  | "runtime-entry"
  | "export"
  | "monomorphized-clone";

/** Unvalidated symbolic discovery retained for later production reconciliation. */
export interface PreparedIrSupportIntentCandidate {
  readonly key: string;
  readonly kind: PreparedIrSupportIntentKind;
  readonly ownerUnitId?: IrUnitId;
  readonly bindingId?: IrBindingId;
  readonly detail?: string;
  readonly evidenceStatus: "unvalidated-candidate";
}

export type PreparedIrAllocationKind = "function" | "global" | "type" | "literal" | "helper";

/** Unvalidated allocation request; this slice neither reserves nor allocates a concrete index. */
export interface PreparedIrAllocationCandidate {
  readonly key: string;
  readonly kind: PreparedIrAllocationKind;
  readonly ownerUnitId: IrUnitId;
  readonly bindingId?: IrBindingId;
  readonly ordinal: number;
  readonly evidenceStatus: "unvalidated-candidate";
}

export type PreparedIrProvenanceRole = "source" | "lifted-closure" | "monomorphization-clone";

/** Unvalidated source/pass provenance assertion retained for later reconciliation. */
export interface PreparedIrProvenanceCandidate {
  readonly artifactUnitId: IrUnitId;
  readonly ownerUnitId: IrUnitId;
  readonly role: PreparedIrProvenanceRole;
  readonly parentUnitId?: IrUnitId;
  readonly ordinal: number;
  readonly evidenceStatus: "unvalidated-candidate";
}

export interface PreparedIrCandidateAbiSnapshot {
  readonly planningSealed: true;
  readonly entries: readonly ProgramAbiPlanEntry[];
  get(id: IrBindingId): ProgramAbiPlanEntry | undefined;
}

export interface PreparedIrEmissionLedgerEntry {
  readonly unitId: IrUnitId;
  readonly candidateRoute: PreparedIrCandidateRoute;
  readonly prepareAttempts: 1;
  readonly directBodyEmissions: number;
  readonly irBodyEmissions: number;
  readonly legacyBodyEmitted: boolean;
  readonly irBodyEmitted: boolean;
}

export interface PreparedIrStagedBody {
  readonly unitId: IrUnitId;
  readonly emitter: PreparedIrEmitter;
  readonly body: unknown;
}

/** Structural candidate publication only; never a production ownership proof. */
export interface PreparedIrCandidatePublication {
  readonly evidenceStatus: "unvalidated-candidate-publication";
  readonly bodies: ReadonlyMap<IrUnitId, PreparedIrStagedBody>;
  readonly ledger: ReadonlyMap<IrUnitId, PreparedIrEmissionLedgerEntry>;
}

export interface PreparedIrCandidateProgram {
  readonly abi: PreparedIrCandidateAbiSnapshot;
  /** Exact authoritative R2 denominator; every value remains an unvalidated candidate. */
  readonly units: ReadonlyMap<IrUnitId, PreparedIrUnitCandidate>;
  readonly irCandidates: ReadonlyMap<IrUnitId, PreparedIrIrCandidate>;
  readonly directCandidates: ReadonlyMap<IrUnitId, PreparedIrDirectCandidate>;
  readonly invariantCandidates: ReadonlyMap<IrUnitId, PreparedIrInvariantCandidate>;
  readonly componentCandidates: readonly PreparedIrComponentCandidate[];
  readonly supportIntentCandidates: readonly PreparedIrSupportIntentCandidate[];
  readonly allocationCandidates: readonly PreparedIrAllocationCandidate[];
  readonly provenanceCandidates: readonly PreparedIrProvenanceCandidate[];
  readonly reconciliation: "pending-production-wiring";
  readonly sealed: true;
  beginEmission(): PreparedIrEmissionTransaction;
}

class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }
  has(key: K): boolean {
    return this.#map.has(key);
  }
  get(key: K): V | undefined {
    return this.#map.get(key);
  }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#map) callbackfn.call(thisArg, value, key, this);
  }
  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }
  keys(): MapIterator<K> {
    return this.#map.keys();
  }
  values(): MapIterator<V> {
    return this.#map.values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#map[Symbol.iterator]();
  }
  get [Symbol.toStringTag](): string {
    return "FrozenMap";
  }
}

class FrozenSet<T> implements ReadonlySet<T> {
  readonly #set: Set<T>;

  constructor(values: Iterable<T>) {
    this.#set = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#set.size;
  }
  has(value: T): boolean {
    return this.#set.has(value);
  }
  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#set) callbackfn.call(thisArg, value, value, this);
  }
  entries(): SetIterator<[T, T]> {
    return this.#set.entries();
  }
  keys(): SetIterator<T> {
    return this.#set.keys();
  }
  values(): SetIterator<T> {
    return this.#set.values();
  }
  [Symbol.iterator](): SetIterator<T> {
    return this.#set[Symbol.iterator]();
  }
  get [Symbol.toStringTag](): string {
    return "FrozenSet";
  }
}

Object.freeze(FrozenMap.prototype);
Object.freeze(FrozenMap);
Object.freeze(FrozenSet.prototype);
Object.freeze(FrozenSet);

export function preparedIrReadonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new FrozenMap(entries);
}

/** Exact data comparison for replay/projection evidence, including recursive layouts and collection entries. */
export function preparedIrDataMismatch(left: unknown, right: unknown): string | undefined {
  const visited = new WeakMap<object, WeakSet<object>>();
  const compare = (expected: unknown, actual: unknown, path: string): string | undefined => {
    if (typeof expected === "function" || typeof actual === "function") return `${path} (executable function)`;
    if (expected === null || actual === null || typeof expected !== "object" || typeof actual !== "object") {
      return Object.is(expected, actual) ? undefined : path;
    }
    const prior = visited.get(expected);
    if (prior?.has(actual)) return undefined;
    if (prior) prior.add(actual);
    else visited.set(expected, new WeakSet([actual]));
    const expectedMap = expected instanceof FrozenMap || expected instanceof Map;
    const actualMap = actual instanceof FrozenMap || actual instanceof Map;
    if (expectedMap || actualMap) {
      if (!expectedMap || !actualMap) return `${path} (map kind)`;
      return compare([...expected], [...actual], `${path}.entries`);
    }
    const expectedSet = expected instanceof FrozenSet || expected instanceof Set;
    const actualSet = actual instanceof FrozenSet || actual instanceof Set;
    if (expectedSet || actualSet) {
      if (!expectedSet || !actualSet) return `${path} (set kind)`;
      return compare([...expected], [...actual], `${path}.values`);
    }
    if (Array.isArray(expected) !== Array.isArray(actual)) return `${path} (array kind)`;
    for (const value of [expected, actual]) {
      const prototype = Object.getPrototypeOf(value);
      if (
        hasNativeCollectionState(value) ||
        (!Array.isArray(value) && prototype !== null && prototype !== Object.prototype)
      ) {
        return `${path} (non-data object)`;
      }
    }
    const expectedKeys = Reflect.ownKeys(expected);
    const actualKeys = Reflect.ownKeys(actual);
    if (expectedKeys.length !== actualKeys.length) return `${path} (field population)`;
    for (const key of expectedKeys) {
      const before = Object.getOwnPropertyDescriptor(expected, key);
      const after = Object.getOwnPropertyDescriptor(actual, key);
      const field = `${path}.${String(key)}`;
      if (!before || !after || !("value" in before) || !("value" in after)) return field;
      const mismatch = compare(before.value, after.value, field);
      if (mismatch !== undefined) return mismatch;
    }
    return undefined;
  };
  return compare(left, right, "$root");
}

function invalidPreparedData(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", detail);
}

function isRecursiveIrClassShape(value: object): boolean {
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    candidate[IR_CLASS_SHAPE_CELL] === true &&
    typeof candidate.classId === "string" &&
    candidate.classId.startsWith("ir-class:v1:") &&
    typeof candidate.className === "string" &&
    Array.isArray(candidate.fields) &&
    Array.isArray(candidate.methods) &&
    Array.isArray(candidate.constructorParams)
  );
}

function immutableCopy(
  value: unknown,
  ancestors = new Set<object>(),
  activeCopies = new Map<object, unknown>(),
): unknown {
  if (typeof value === "function") invalidPreparedData("prepared data cannot contain executable functions");
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) {
    const recursiveShapeCopy = activeCopies.get(value);
    if (recursiveShapeCopy !== undefined && isRecursiveIrClassShape(value)) return recursiveShapeCopy;
    invalidPreparedData("prepared data must be acyclic outside exact IR class shapes");
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (value instanceof FrozenMap) {
    return preparedIrReadonlyMap(
      [...value].map(
        ([key, item]) =>
          [immutableCopy(key, nextAncestors, activeCopies), immutableCopy(item, nextAncestors, activeCopies)] as const,
      ),
    );
  }
  if (value instanceof FrozenSet) {
    return new FrozenSet([...value].map((item) => immutableCopy(item, nextAncestors, activeCopies)));
  }
  if (Array.isArray(value)) return Object.freeze(value.map((item) => immutableCopy(item, nextAncestors, activeCopies)));
  if (value instanceof Map) {
    return preparedIrReadonlyMap(
      [...value].map(
        ([key, item]) =>
          [immutableCopy(key, nextAncestors, activeCopies), immutableCopy(item, nextAncestors, activeCopies)] as const,
      ),
    );
  }
  if (value instanceof Set) {
    return new FrozenSet([...value].map((item) => immutableCopy(item, nextAncestors, activeCopies)));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidPreparedData(`prepared data contains unsupported mutable ${prototype?.constructor?.name ?? "object"}`);
  }
  const copy = Object.create(null) as Record<PropertyKey, unknown>;
  activeCopies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      invalidPreparedData(`prepared data property ${String(key)} must be a non-executable data property`);
    }
    Object.defineProperty(copy, key, {
      value: immutableCopy(descriptor.value, nextAncestors, activeCopies),
      enumerable: descriptor.enumerable,
      configurable: false,
      writable: false,
    });
  }
  activeCopies.delete(value);
  return Object.freeze(copy);
}

export function freezePreparedIrValue(value: unknown): unknown {
  return immutableCopy(value);
}

function hasNativeCollectionState(value: object): boolean {
  for (const has of [Map.prototype.has, Set.prototype.has, WeakMap.prototype.has, WeakSet.prototype.has]) {
    try {
      Reflect.apply(has, value, [value]);
      return true;
    } catch {
      // Native methods authenticate internal slots even when the prototype was erased.
    }
  }
  return false;
}

/** Freeze producer-owned attachments without replacing authenticated plan/manifest identities. */
export function freezePreparedIrRuntimeValue<T>(value: T): T {
  const visited = new Set<object>();
  const active = new Set<object>();
  const freeze = (item: unknown): void => {
    if (typeof item === "function") invalidPreparedData("runtime data cannot contain executable functions");
    if (item === null || typeof item !== "object") return;
    if (active.has(item)) {
      if (!isRecursiveIrClassShape(item))
        invalidPreparedData("runtime data must be acyclic outside exact IR class shapes");
      return;
    }
    if (visited.has(item)) return;
    active.add(item);
    if (item instanceof FrozenMap) {
      for (const [key, entry] of item) {
        freeze(key);
        freeze(entry);
      }
    } else if (item instanceof FrozenSet) {
      for (const entry of item) freeze(entry);
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (
        hasNativeCollectionState(item) ||
        (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      )
        invalidPreparedData("runtime data contains mutable or executable context state");
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor))
          invalidPreparedData(`runtime property ${String(key)} must be non-executable data`);
        freeze(descriptor.value);
      }
    }
    active.delete(item);
    Object.freeze(item);
    visited.add(item);
  };
  freeze(value);
  return value;
}

interface MutableLedgerEntry {
  readonly unitId: IrUnitId;
  readonly candidateRoute: PreparedIrCandidateRoute;
  directBodyEmissions: number;
  irBodyEmissions: number;
}

const EMISSION_TRANSACTION_CAPABILITY = Symbol("PreparedIrProgram.beginEmission");

export class PreparedIrEmissionTransaction {
  readonly #program: PreparedIrCandidateProgram;
  readonly #staged = new Map<IrUnitId, PreparedIrStagedBody>();
  readonly #ledger = new Map<IrUnitId, MutableLedgerEntry>();
  #state: "open" | "published" | "aborted" = "open";
  #publication?: PreparedIrCandidatePublication;

  private constructor(program: PreparedIrCandidateProgram, capability: symbol) {
    if (capability !== EMISSION_TRANSACTION_CAPABILITY) {
      throw new PreparedIrProgramInvariantError(
        "invalid-transaction-capability",
        "emission transactions can only be created by PreparedIrProgram.beginEmission()",
      );
    }
    this.#program = program;
    for (const [unitId, candidate] of program.units) {
      this.#ledger.set(unitId, {
        unitId,
        candidateRoute: candidate.route,
        directBodyEmissions: 0,
        irBodyEmissions: 0,
      });
    }
  }

  /** @internal Runtime capability remains module-private. */
  static open(program: PreparedIrCandidateProgram, capability: symbol): PreparedIrEmissionTransaction {
    return new PreparedIrEmissionTransaction(program, capability);
  }

  get publication(): PreparedIrCandidatePublication | undefined {
    return this.#publication;
  }

  get ledger(): ReadonlyMap<IrUnitId, PreparedIrEmissionLedgerEntry> {
    return this.#ledgerSnapshot();
  }

  emitIr(unitId: IrUnitId, body: unknown): void {
    this.#stage(unitId, "ir", body);
  }

  emitDirect(unitId: IrUnitId, body: unknown): void {
    this.#stage(unitId, "direct", body);
  }

  failEmission(unitId: IrUnitId, emitter: PreparedIrEmitter, detail: string): never {
    this.#assertOpen();
    try {
      this.#assertDirection(unitId, emitter);
      throw new PreparedIrProgramInvariantError(
        "emission-failed",
        `${emitter} emission for ${unitId} failed: ${detail}`,
      );
    } catch (error) {
      return this.#abort(error);
    }
  }

  publish(): PreparedIrCandidatePublication {
    this.#assertOpen();
    try {
      const missing = [...this.#program.units].filter(
        ([unitId, candidate]) => candidate.route !== "neither" && !this.#staged.has(unitId),
      );
      if (missing.length > 0) {
        throw new PreparedIrProgramInvariantError(
          "partial-publication",
          `cannot publish ${this.#staged.size}/${this.#program.irCandidates.size + this.#program.directCandidates.size} candidate bodies; missing ${missing
            .map(([unitId]) => unitId)
            .join(", ")}`,
        );
      }
      const publication = Object.freeze({
        evidenceStatus: "unvalidated-candidate-publication" as const,
        bodies: preparedIrReadonlyMap(this.#staged),
        ledger: this.#ledgerSnapshot(),
      });
      this.#publication = publication;
      this.#state = "published";
      return publication;
    } catch (error) {
      return this.#abort(error);
    }
  }

  #stage(unitId: IrUnitId, emitter: PreparedIrEmitter, body: unknown): void {
    this.#assertOpen();
    try {
      this.#assertDirection(unitId, emitter);
      if (this.#staged.has(unitId)) {
        throw new PreparedIrProgramInvariantError("duplicate-emission", `${unitId} was emitted more than once`);
      }
      const staged = Object.freeze({ unitId, emitter, body: freezePreparedIrValue(body) });
      const ledger = this.#ledger.get(unitId)!;
      if (emitter === "ir") ledger.irBodyEmissions = 1;
      else ledger.directBodyEmissions = 1;
      this.#staged.set(unitId, staged);
    } catch (error) {
      this.#abort(error);
    }
  }

  #assertDirection(unitId: IrUnitId, emitter: PreparedIrEmitter): void {
    const candidate = this.#program.units.get(unitId);
    if (!candidate) {
      throw new PreparedIrProgramInvariantError("unknown-emission-unit", `${unitId} is outside the prepared program`);
    }
    if (emitter !== candidate.route) {
      throw new PreparedIrProgramInvariantError(
        "wrong-emitter",
        `${unitId} has ${candidate.kind}; expected ${candidate.route} emission, received ${emitter}`,
      );
    }
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new PreparedIrProgramInvariantError("transaction-closed", `emission transaction is ${this.#state}`);
    }
  }

  #abort(error: unknown): never {
    this.#state = "aborted";
    throw error;
  }

  #ledgerSnapshot(): ReadonlyMap<IrUnitId, PreparedIrEmissionLedgerEntry> {
    return preparedIrReadonlyMap(
      [...this.#ledger].map(([unitId, entry]) => [
        unitId,
        Object.freeze({
          ...entry,
          prepareAttempts: 1 as const,
          legacyBodyEmitted: entry.directBodyEmissions === 1,
          irBodyEmitted: entry.irBodyEmissions === 1,
        }),
      ]),
    );
  }
}

Object.freeze(PreparedIrEmissionTransaction.prototype);
Object.freeze(PreparedIrEmissionTransaction);

export interface PreparedIrCandidateProgramInput {
  readonly abiEntries: readonly ProgramAbiPlanEntry[];
  readonly units: ReadonlyMap<IrUnitId, PreparedIrUnitCandidate>;
  readonly componentCandidates: readonly { readonly id: string; readonly unitIds: readonly IrUnitId[] }[];
  readonly supportIntentCandidates: readonly Omit<PreparedIrSupportIntentCandidate, "evidenceStatus">[];
  readonly allocationCandidates: readonly Omit<PreparedIrAllocationCandidate, "evidenceStatus">[];
  readonly provenanceCandidates: readonly Omit<PreparedIrProvenanceCandidate, "evidenceStatus">[];
}

function ownCandidate<T>(value: T): T {
  return freezePreparedIrValue(value) as T;
}

function expectedCandidateRoute(candidate: PreparedIrUnitCandidate): PreparedIrCandidateRoute {
  switch (candidate.kind) {
    case "ir-candidate":
      return "ir";
    case "direct-candidate":
      return "direct";
    case "invariant-candidate":
      return "neither";
    default:
      return invalidPreparedData(
        `candidate has unknown kind ${String((candidate as unknown as { kind?: unknown }).kind)}`,
      );
  }
}

/**
 * @internal Defensively owns every input. prepare.ts is the supported caller;
 * the output remains explicitly pending production reconciliation.
 */
export function createPreparedIrCandidateProgram(input: PreparedIrCandidateProgramInput): PreparedIrCandidateProgram {
  const ownedInput = ownCandidate(input);
  const entries = Object.freeze(ownedInput.abiEntries.map((entry) => ownCandidate(entry)));
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  const abi: PreparedIrCandidateAbiSnapshot = Object.freeze({
    planningSealed: true as const,
    entries,
    get: (id: IrBindingId) => entryMap.get(id),
  });
  const units = preparedIrReadonlyMap(
    [...ownedInput.units].map(([unitId, candidate]) => {
      const ownedCandidate = ownCandidate(candidate);
      if (
        ownedCandidate.unitId !== unitId ||
        ownedCandidate.route !== expectedCandidateRoute(ownedCandidate) ||
        ownedCandidate.evidenceStatus !== "unvalidated-candidate"
      ) {
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          `candidate ${unitId} has inconsistent identity, kind, route, or evidence status`,
        );
      }
      return [unitId, ownedCandidate] as const;
    }),
  );
  const irCandidates = preparedIrReadonlyMap(
    [...units].filter((entry): entry is [IrUnitId, PreparedIrIrCandidate] => entry[1].kind === "ir-candidate"),
  );
  const directCandidates = preparedIrReadonlyMap(
    [...units].filter((entry): entry is [IrUnitId, PreparedIrDirectCandidate] => entry[1].kind === "direct-candidate"),
  );
  const invariantCandidates = preparedIrReadonlyMap(
    [...units].filter(
      (entry): entry is [IrUnitId, PreparedIrInvariantCandidate] => entry[1].kind === "invariant-candidate",
    ),
  );
  const componentCandidates = Object.freeze(
    ownedInput.componentCandidates.map((component) => {
      const unitIds = Object.freeze([...component.unitIds]);
      const unknownUnitIds = unitIds.filter((unitId) => !units.has(unitId));
      if (unknownUnitIds.length > 0) {
        throw new PreparedIrProgramInvariantError(
          "unknown-unit",
          `component candidate ${component.id} includes unknown units: ${unknownUnitIds.join(", ")}`,
        );
      }
      return Object.freeze({
        id: component.id,
        unitIds,
        candidateRoutes: Object.freeze([...new Set(unitIds.map((unitId) => units.get(unitId)!.route))]),
        evidenceStatus: "unvalidated-component-candidate" as const,
      }) as PreparedIrComponentCandidate;
    }),
  );
  const supportIntentCandidates = Object.freeze(
    ownedInput.supportIntentCandidates.map((candidate) =>
      ownCandidate({
        key: candidate.key,
        kind: candidate.kind,
        ownerUnitId: candidate.ownerUnitId,
        bindingId: candidate.bindingId,
        detail: candidate.detail,
        evidenceStatus: "unvalidated-candidate" as const,
      }),
    ),
  );
  const allocationCandidates = Object.freeze(
    ownedInput.allocationCandidates.map((candidate) =>
      ownCandidate({
        key: candidate.key,
        kind: candidate.kind,
        ownerUnitId: candidate.ownerUnitId,
        bindingId: candidate.bindingId,
        ordinal: candidate.ordinal,
        evidenceStatus: "unvalidated-candidate" as const,
      }),
    ),
  );
  const provenanceCandidates = Object.freeze(
    ownedInput.provenanceCandidates.map((candidate) =>
      ownCandidate({
        artifactUnitId: candidate.artifactUnitId,
        ownerUnitId: candidate.ownerUnitId,
        role: candidate.role,
        parentUnitId: candidate.parentUnitId,
        ordinal: candidate.ordinal,
        evidenceStatus: "unvalidated-candidate" as const,
      }),
    ),
  );
  let emissionStarted = false;
  const program: PreparedIrCandidateProgram = Object.freeze({
    abi,
    units,
    irCandidates,
    directCandidates,
    invariantCandidates,
    componentCandidates,
    supportIntentCandidates,
    allocationCandidates,
    provenanceCandidates,
    reconciliation: "pending-production-wiring" as const,
    sealed: true as const,
    beginEmission(): PreparedIrEmissionTransaction {
      if (program.invariantCandidates.size > 0) {
        throw new PreparedIrProgramInvariantError(
          "program-has-invariant-candidate",
          `prepared program contains ${program.invariantCandidates.size} invariant candidate(s)`,
        );
      }
      if (emissionStarted) {
        throw new PreparedIrProgramInvariantError("emission-already-started", "prepared program emission is one-shot");
      }
      emissionStarted = true;
      return PreparedIrEmissionTransaction.open(program, EMISSION_TRANSACTION_CAPABILITY);
    },
  });
  return program;
}
