// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3528 L0-P1 — the immutable executable-body handoff.
//
// This artifact is deliberately narrower than PreparedIrProgram: it freezes
// the actual IR module produced by the linear front-end together with the
// analysis evidence that the linear backend is allowed to consume. It does
// not contain a checker, AST, resolver, allocator, codegen context, or source
// selection callback. Backends authenticate the object by identity and digest;
// the digest is useful evidence, never authority for a foreign object.

import { effectsOf, type IrEffects } from "./effects.js";
import { freezePreparedIrValue } from "./program.js";
import { irImportFuncRef, irIntrinsicFuncRef, irRuntimeFuncRef, sameIrCallableBinding } from "./callable-bindings.js";
import {
  forEachInstrDeep,
  forEachNestedBuffer,
  irTypeEquals,
  type IrIntrinsicProvider,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrType,
} from "./nodes.js";
import type { IrUnitId } from "./identity.js";
import {
  RUNTIME_PROVIDERS,
  type FrozenRuntimeManifest,
  type RuntimeProviderDefinition,
  type RuntimeProviderPlan,
} from "./runtime-manifest.js";
import { INTRINSIC_DEFINITIONS } from "./intrinsics.js";
import { resolveRuntimeHostCapabilityFuncRecord } from "./runtime-host-capabilities.js";
import type { LinearPreparedAllocationFacts } from "./analysis/linear-memory-plan.js";
import { sameDetachedValue, verifyLinearPreparedAllocationFacts } from "./analysis/linear-memory-plan.js";
import { irModuleDeclarations } from "./declared-types.js";
import { verifyIrFunction } from "./verify.js";

export const FROZEN_IR_BODY_BATCH_SCHEMA = "frozen-ir-body-batch-v1" as const;

export interface FrozenIrBodyOwnerRejection {
  readonly reason: string;
  readonly detail?: string;
}

/** AST-free projection of one source/terminal owner. */
export interface FrozenIrBodyOwner {
  readonly ownerUnitId: IrUnitId;
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly legacyName: string;
  readonly terminalKind: string;
  readonly observedKind: string;
  readonly outcome: "built" | "rejected" | "not-attempted";
  readonly rejection?: FrozenIrBodyOwnerRejection;
}

export interface FrozenIrBodySource {
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly fileName: string;
}

export interface FrozenIrBodyProducerFacts {
  readonly backend: "linear";
  readonly policy: string;
  readonly source: FrozenIrBodySource;
  readonly version: "l0-p1-v1";
  /** Explicitly names the unresolved boundary instead of implying neutrality. */
  readonly representation: "linear-ir";
  readonly boundaries: readonly string[];
}

export interface FrozenIrBodyRuntimeFacts {
  readonly manifest?: FrozenRuntimeManifest;
  /** FrozenMap after capture; callers only receive a read-only key/value view. */
  readonly providers: ReadonlyMap<string, RuntimeProviderPlan>;
}

/** AST-free counted-string evidence retained beside the upper sidecar plan. */
export interface FrozenIrCountedStringReceipt {
  readonly siteId: string;
  readonly ownerUnitId: IrUnitId;
  readonly sourceId: string;
  readonly finalInstructionDigest: string;
}

export interface FrozenIrEffectFact {
  readonly ownerUnitId: IrUnitId;
  /** Stable structural path, e.g. `block:0/instr:2/buffer:0/instr:1`. */
  readonly path: string;
  readonly kind: IrInstr["kind"];
  readonly effects: {
    readonly readsHeap: boolean;
    readonly writesHeap: boolean;
    readonly control: boolean;
    readonly allSlots: boolean;
    readonly readSlots: readonly number[];
    readonly writeSlots: readonly number[];
  };
}

export interface FrozenIrBodyBatch {
  readonly schema: typeof FROZEN_IR_BODY_BATCH_SCHEMA;
  /** Ordered executable module captured by the linear producer. */
  readonly module: IrModule;
  readonly functions: readonly IrFunction[];
  readonly owners: readonly FrozenIrBodyOwner[];
  /** Logical ABI projection, retained independently of backend physical slots. */
  readonly signatures: readonly {
    readonly ownerUnitId: IrUnitId;
    readonly params: readonly IrType[];
    readonly results: readonly IrType[];
  }[];
  readonly effects: readonly FrozenIrEffectFact[];
  readonly allocationFacts: LinearPreparedAllocationFacts;
  readonly runtime: FrozenIrBodyRuntimeFacts;
  readonly countedStringReceipts: readonly FrozenIrCountedStringReceipt[];
  readonly producer: FrozenIrBodyProducerFacts;
  readonly digest: string;
}

export interface FrozenIrBodyBatchInput {
  readonly module: IrModule;
  readonly owners: readonly FrozenIrBodyOwner[];
  readonly allocationFacts: LinearPreparedAllocationFacts;
  readonly runtime?: {
    readonly manifest?: FrozenRuntimeManifest;
    readonly providers?: ReadonlyMap<string, RuntimeProviderPlan> | readonly (readonly [string, RuntimeProviderPlan])[];
  };
  readonly countedStringReceipts?: readonly FrozenIrCountedStringReceipt[];
  readonly producer: FrozenIrBodyProducerFacts;
}

/** AST-free owner projection used by the linear producer before capture. */
export interface FrozenIrBodyOwnerCensusRow {
  readonly ownerUnitId: IrUnitId;
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly legacyName: string;
  readonly terminalKind: string;
  readonly observedKind: string;
}

export interface FrozenIrBodyOwnerCensusInput {
  readonly rows: readonly FrozenIrBodyOwnerCensusRow[];
  readonly builtOwnerIds: ReadonlySet<IrUnitId>;
  readonly rejections: ReadonlyMap<IrUnitId, FrozenIrBodyOwnerRejection>;
}

/** Join source/terminal rows to the producer's exact built/rejected set. */
export function projectFrozenIrBodyOwnerCensus(input: FrozenIrBodyOwnerCensusInput): readonly FrozenIrBodyOwner[] {
  return Object.freeze(
    input.rows.map((row) => {
      if (input.builtOwnerIds.has(row.ownerUnitId)) {
        return { ...row, outcome: "built" as const };
      }
      const rejection = input.rejections.get(row.ownerUnitId);
      return {
        ...row,
        outcome: rejection ? ("rejected" as const) : ("not-attempted" as const),
        rejection: rejection ?? { reason: "not-attempted" },
      };
    }),
  );
}

const authenticatedBatches = new WeakSet<object>();

function bodyBatchInvariant(detail: string): never {
  throw new FrozenIrBodyBatchInvariantError(detail);
}

export class FrozenIrBodyBatchInvariantError extends Error {
  readonly kind = "invariant" as const;
  readonly stage = "prepare" as const;

  constructor(detail: string) {
    super(`frozen IR body batch: ${detail}`);
    this.name = "FrozenIrBodyBatchInvariantError";
  }
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) bodyBatchInvariant(`${label} must be a non-empty string`);
}

function validateOwners(module: IrModule, owners: readonly FrozenIrBodyOwner[], source: FrozenIrBodySource): void {
  const byId = new Map<IrUnitId, FrozenIrBodyOwner>();
  for (const owner of owners) {
    if (!owner || typeof owner !== "object") bodyBatchInvariant("owner census contains a malformed row");
    requireNonEmptyString(owner.ownerUnitId, "owner unit id");
    requireNonEmptyString(owner.sourceId, `source ${owner.ownerUnitId}`);
    requireNonEmptyString(owner.sourceKey, `source key ${owner.ownerUnitId}`);
    if (owner.sourceId !== source.sourceId || owner.sourceKey !== source.sourceKey) {
      bodyBatchInvariant(`owner ${owner.ownerUnitId} does not join the producer source`);
    }
    requireNonEmptyString(owner.legacyName, `owner name ${owner.ownerUnitId}`);
    requireNonEmptyString(owner.terminalKind, `terminal kind ${owner.ownerUnitId}`);
    requireNonEmptyString(owner.observedKind, `observed kind ${owner.ownerUnitId}`);
    if (byId.has(owner.ownerUnitId)) bodyBatchInvariant(`duplicate owner ${owner.ownerUnitId}`);
    if (owner.outcome === "rejected" || owner.outcome === "not-attempted") {
      requireNonEmptyString(owner.rejection?.reason, `rejection reason ${owner.ownerUnitId}`);
    } else if (owner.outcome !== "built") {
      bodyBatchInvariant(`owner ${owner.ownerUnitId} has an unknown outcome`);
    }
    byId.set(owner.ownerUnitId, owner);
  }
  const seenFunctions = new Set<IrUnitId>();
  for (const fn of module.functions) {
    if (!fn || typeof fn !== "object") bodyBatchInvariant("module functions contain a malformed row");
    if (seenFunctions.has(fn.unitId)) bodyBatchInvariant(`duplicate executable owner ${fn.unitId}`);
    seenFunctions.add(fn.unitId);
    const owner = byId.get(fn.unitId);
    if (!owner) bodyBatchInvariant(`executable owner ${fn.unitId} has no source census row`);
    if (owner.outcome !== "built") bodyBatchInvariant(`executable owner ${fn.unitId} is not marked built`);
  }
  for (const owner of owners) {
    if (owner.outcome === "built" && !seenFunctions.has(owner.ownerUnitId)) {
      bodyBatchInvariant(`built owner ${owner.ownerUnitId} has no executable function`);
    }
  }
}

function projectEffects(fn: IrFunction): FrozenIrEffectFact[] {
  const cache = new Map<IrInstr, IrEffects>();
  const effects: FrozenIrEffectFact[] = [];
  const walkBuffer = (buffer: readonly IrInstr[], prefix: string): void => {
    buffer.forEach((instr, index) => {
      const path = `${prefix}/instr:${index}`;
      const effect = effectsOf(instr, cache);
      effects.push({
        ownerUnitId: fn.unitId,
        path,
        kind: instr.kind,
        effects: {
          readsHeap: effect.readsHeap,
          writesHeap: effect.writesHeap,
          control: effect.control,
          allSlots: effect.allSlots,
          readSlots: [...effect.readSlots].sort((left, right) => left - right),
          writeSlots: [...effect.writeSlots].sort((left, right) => left - right),
        },
      });
      let bufferIndex = 0;
      forEachNestedBuffer(instr, (nested) => {
        walkBuffer(nested, `${path}/buffer:${bufferIndex}`);
        bufferIndex++;
      });
    });
  };
  fn.blocks.forEach((block) => walkBuffer(block.instrs, `block:${block.id as number}`));
  for (const state of fn.asyncPlan?.states ?? []) {
    walkBuffer(state.body, `async-state:${state.id as number}`);
  }
  return effects;
}

function projectSignatures(module: IrModule): FrozenIrBodyBatch["signatures"] {
  return module.functions.map((fn) => ({
    ownerUnitId: fn.unitId,
    params: fn.params.map((param) => param.type),
    results: fn.resultTypes,
  }));
}

function providerEntries(
  providers: ReadonlyMap<string, RuntimeProviderPlan> | readonly (readonly [string, RuntimeProviderPlan])[] | undefined,
): readonly (readonly [string, RuntimeProviderPlan])[] {
  if (!providers) return [];
  return providers instanceof Map ? [...providers.entries()] : [...providers];
}

function validateProviderEntries(entries: readonly (readonly [string, RuntimeProviderPlan])[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) bodyBatchInvariant("runtime provider row is malformed");
    const [id, provider] = entry;
    requireNonEmptyString(id, "runtime provider key");
    if (seen.has(id)) bodyBatchInvariant(`duplicate runtime provider ${id}`);
    seen.add(id);
    if (!provider || typeof provider !== "object") bodyBatchInvariant(`runtime provider ${id} is absent`);
    requireNonEmptyString(provider.id, `runtime provider ${id} id`);
    requireNonEmptyString(provider.feature, `runtime provider ${id} feature`);
  }
}

function sameProviderDefinition(left: RuntimeProviderDefinition, right: RuntimeProviderDefinition): boolean {
  return sameDetachedValue(left, right);
}

function providerAttachmentForBatch(
  intrinsicId: string,
  provider: RuntimeProviderPlan,
  manifest: FrozenRuntimeManifest,
): IrIntrinsicProvider {
  switch (provider.implementation.kind) {
    case "backend-op":
      return { kind: "backend-op", opcode: provider.implementation.opcode };
    case "backend-sequence":
      return { kind: "backend-sequence", sequence: provider.implementation.sequence };
    case "backend-composite":
      return { kind: "backend-composite", operation: provider.implementation.operation };
    case "host-callable": {
      let record;
      try {
        record = resolveRuntimeHostCapabilityFuncRecord(
          manifest.hostCapabilityRecords,
          provider.implementation.capability,
        );
      } catch (error) {
        bodyBatchInvariant(
          `runtime provider ${provider.id} has no canonical host callable record: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return { kind: "callable", target: irImportFuncRef(record.module, record.field, record.field) };
    }
    case "runtime-callable":
      return { kind: "callable", target: irRuntimeFuncRef(provider.implementation.symbol) };
    case "self-hosted":
      return { kind: "callable", target: irIntrinsicFuncRef(intrinsicId, provider.implementation.symbol) };
    default:
      bodyBatchInvariant(`runtime provider ${provider.id} has no supported intrinsic attachment kind`);
  }
}

function sameProviderAttachment(left: IrIntrinsicProvider, right: IrIntrinsicProvider): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "backend-op":
      return right.kind === "backend-op" && left.opcode === right.opcode;
    case "backend-sequence":
      return right.kind === "backend-sequence" && left.sequence === right.sequence;
    case "backend-composite":
      return right.kind === "backend-composite" && left.operation === right.operation;
    case "callable":
      return (
        right.kind === "callable" &&
        sameIrCallableBinding(left.target.binding, right.target.binding) &&
        left.target.name === right.target.name
      );
  }
}

function validateRuntimeProviderJoins(
  module: IrModule,
  providers: readonly (readonly [string, RuntimeProviderPlan])[],
  manifest: FrozenRuntimeManifest | undefined,
): void {
  if (providers.length > 0 && !manifest) {
    bodyBatchInvariant("runtime provider demand has no frozen runtime manifest");
  }
  const providerById = new Map(providers);
  const intrinsicIds = new Set<string>();
  const inspect = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) {
      forEachInstrDeep(root, (instr) => {
        if (instr.kind !== "intrinsic") return;
        intrinsicIds.add(instr.id);
        const attached = instr.provider;
        const selected = providerById.get(instr.id);
        if (!attached && selected) bodyBatchInvariant(`runtime provider ${instr.id} has no attached IR provider`);
        if (attached && !selected) bodyBatchInvariant(`intrinsic ${instr.id} has no selected runtime provider`);
        if (attached && selected && manifest) {
          const definition = INTRINSIC_DEFINITIONS[instr.id];
          const canonical = RUNTIME_PROVIDERS.find((candidate) => candidate.id === selected.id);
          if (
            !definition ||
            selected.feature !== definition.feature ||
            !canonical ||
            !sameProviderDefinition(selected, canonical)
          ) {
            bodyBatchInvariant(`intrinsic ${instr.id} provider is not the canonical runtime catalogue row`);
          }
          const manifestUse = manifest.intrinsicUses.find((use) => use.id === instr.id);
          const manifestProvider = manifest.providers.find((candidate) => candidate.id === selected.id);
          if (
            !manifestUse ||
            !manifestProvider ||
            !sameProviderDefinition(manifestProvider, selected) ||
            manifestUse.version !== instr.version ||
            !irTypeEquals(manifestUse.resultType, definition.signature.result) ||
            manifestUse.argumentTypes.length !== definition.signature.params.length ||
            manifestUse.argumentTypes.some((type, index) => !irTypeEquals(type, definition.signature.params[index]!))
          ) {
            bodyBatchInvariant(`intrinsic ${instr.id} provider does not join the frozen runtime manifest`);
          }
          const expected = providerAttachmentForBatch(instr.id, selected, manifest);
          if (!sameProviderAttachment(attached, expected)) {
            bodyBatchInvariant(`intrinsic ${instr.id} has an attachment outside its selected runtime provider`);
          }
        }
      });
    }
  };
  for (const fn of module.functions) {
    for (const block of fn.blocks) inspect(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) inspect(state.body);
  }
  for (const [id, selected] of providers) {
    if (!intrinsicIds.has(id)) bodyBatchInvariant(`runtime provider ${id} has no executable intrinsic use`);
    if (manifest) {
      const manifestProvider = manifest.providers.find((provider) => provider.id === selected.id);
      const canonical = RUNTIME_PROVIDERS.find((provider) => provider.id === selected.id);
      if (
        !manifestProvider ||
        !canonical ||
        !sameProviderDefinition(selected, canonical) ||
        !sameProviderDefinition(manifestProvider, selected)
      ) {
        bodyBatchInvariant(`runtime provider ${id} is absent from the frozen runtime manifest`);
      }
    }
  }
}

function requireArray(value: unknown, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) bodyBatchInvariant(`${label} must be an array`);
}

function validateReceipts(
  receipts: readonly FrozenIrCountedStringReceipt[],
  owners: readonly FrozenIrBodyOwner[],
): void {
  const ownerById = new Map(
    owners.filter((owner) => owner.outcome === "built").map((owner) => [owner.ownerUnitId, owner] as const),
  );
  const siteIds = new Set<string>();
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object") bodyBatchInvariant("counted-string receipt is malformed");
    requireNonEmptyString(receipt.siteId, "counted-string site id");
    requireNonEmptyString(receipt.sourceId, `counted-string source ${receipt.siteId}`);
    requireNonEmptyString(receipt.finalInstructionDigest, `counted-string digest ${receipt.siteId}`);
    if (siteIds.has(receipt.siteId)) bodyBatchInvariant(`duplicate counted-string site ${receipt.siteId}`);
    const owner = ownerById.get(receipt.ownerUnitId);
    if (!owner) {
      bodyBatchInvariant(`counted-string site ${receipt.siteId} has no built owner`);
    }
    if (receipt.sourceId !== owner.sourceId) {
      bodyBatchInvariant(`counted-string site ${receipt.siteId} does not join its owner source`);
    }
    siteIds.add(receipt.siteId);
  }
}

function stableKey(key: PropertyKey): string {
  if (typeof key === "symbol") return `symbol:${Symbol.keyFor(key) ?? key.description ?? ""}`;
  return `string:${key}`;
}

/** Deterministic structural encoding that preserves edge primitives and refs. */
function stableEncode(value: unknown, seen = new Map<object, number>()): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  switch (typeof value) {
    case "boolean":
      return value ? "b1" : "b0";
    case "string":
      return `s${JSON.stringify(value)}`;
    case "number":
      if (Number.isNaN(value)) return "dNaN";
      if (Object.is(value, -0)) return "d-0";
      if (value === Infinity) return "d+Inf";
      if (value === -Infinity) return "d-Inf";
      return `d${String(value)}`;
    case "bigint":
      return `i${value.toString()}`;
    case "symbol":
      return `y${stableKey(value)}`;
    case "function":
      bodyBatchInvariant("digest input contains an executable function");
  }
  const object = value as object;
  const prior = seen.get(object);
  if (prior !== undefined) return `r${prior}`;
  const id = seen.size;
  seen.set(object, id);
  const tag = Object.prototype.toString.call(value);
  if (Array.isArray(value)) return `a${id}[${value.map((item) => stableEncode(item, seen)).join(",")}]`;
  if (tag === "[object Map]" || tag === "[object FrozenMap]") {
    const entries = [...(value as ReadonlyMap<unknown, unknown>)].map(
      ([key, item]) => `${stableEncode(key, seen)}=>${stableEncode(item, seen)}`,
    );
    return `m${id}{${entries.join(",")}}`;
  }
  if (tag === "[object Set]" || tag === "[object FrozenSet]") {
    return `t${id}{${[...(value as ReadonlySet<unknown>)].map((item) => stableEncode(item, seen)).join(",")}}`;
  }
  const keys = Reflect.ownKeys(value).sort((left, right) => (stableKey(left) < stableKey(right) ? -1 : 1));
  const fields = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) bodyBatchInvariant(`digest field ${String(key)} is executable`);
    return `${stableKey(key)}=${stableEncode(descriptor.value, seen)}`;
  });
  return `o${id}{${fields.join(",")}}`;
}

function digest(value: unknown): string {
  let hash = 14695981039346656037n;
  for (const char of stableEncode(value)) {
    hash ^= BigInt(char.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Create the authenticated, AST-free executable-body artifact. */
export function prepareLinearIrBodyBatch(input: FrozenIrBodyBatchInput): FrozenIrBodyBatch {
  if (!input || typeof input !== "object") bodyBatchInvariant("input is absent");
  if (!input.module || typeof input.module !== "object") bodyBatchInvariant("module is absent");
  requireArray(input.module.functions, "module functions");
  requireArray(input.owners, "owner census");
  if (!input.allocationFacts || typeof input.allocationFacts !== "object") {
    bodyBatchInvariant("allocation facts are absent");
  }
  if (!input.producer || typeof input.producer !== "object") bodyBatchInvariant("producer facts are absent");
  if (input.producer.backend !== "linear") bodyBatchInvariant("producer backend must be linear");
  if (input.producer.version !== "l0-p1-v1") bodyBatchInvariant("unknown producer version");
  if (input.producer.representation !== "linear-ir") bodyBatchInvariant("producer representation is not linear-ir");
  requireNonEmptyString(input.producer.policy, "producer policy");
  requireArray(input.producer.boundaries, "producer boundaries");
  for (const boundary of input.producer.boundaries) requireNonEmptyString(boundary, "producer boundary");
  if (!input.producer.source || typeof input.producer.source !== "object") {
    bodyBatchInvariant("producer source facts are absent");
  }
  requireNonEmptyString(input.producer.source.sourceId, "producer source id");
  requireNonEmptyString(input.producer.source.sourceKey, "producer source key");
  requireNonEmptyString(input.producer.source.fileName, "producer source file");
  const declarations = irModuleDeclarations(input.module);
  for (const fn of input.module.functions) {
    let errors;
    try {
      errors = verifyIrFunction(fn, undefined, declarations);
    } catch (error) {
      bodyBatchInvariant(
        `executable owner is not structurally verifiable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (errors.length > 0) bodyBatchInvariant(`executable owner ${fn.unitId} has invalid IR: ${errors[0]!.message}`);
  }
  validateOwners(input.module, input.owners, input.producer.source);
  try {
    verifyLinearPreparedAllocationFacts(input.module, input.allocationFacts);
  } catch (error) {
    bodyBatchInvariant(error instanceof Error ? error.message : String(error));
  }
  let providers: readonly (readonly [string, RuntimeProviderPlan])[];
  try {
    providers = providerEntries(input.runtime?.providers);
  } catch (error) {
    bodyBatchInvariant(
      `runtime provider population is not iterable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateProviderEntries(providers);
  validateRuntimeProviderJoins(input.module, providers, input.runtime?.manifest);
  const receipts = input.countedStringReceipts ?? [];
  requireArray(receipts, "counted-string receipts");
  validateReceipts(receipts, input.owners);

  const effects = input.module.functions.flatMap(projectEffects);
  const snapshot = {
    schema: FROZEN_IR_BODY_BATCH_SCHEMA,
    module: input.module,
    owners: input.owners,
    signatures: projectSignatures(input.module),
    effects,
    allocationFacts: input.allocationFacts,
    runtime: { manifest: input.runtime?.manifest, providers: new Map(providers) },
    countedStringReceipts: receipts,
    producer: input.producer,
  };
  let ownedSnapshot: typeof snapshot;
  let contentDigest: string;
  let frozenBase: Omit<FrozenIrBodyBatch, "functions">;
  try {
    ownedSnapshot = freezePreparedIrValue(snapshot) as typeof snapshot;
    contentDigest = digest(ownedSnapshot);
    frozenBase = freezePreparedIrValue({ ...ownedSnapshot, digest: contentDigest }) as Omit<
      FrozenIrBodyBatch,
      "functions"
    >;
  } catch (error) {
    bodyBatchInvariant(`cannot own executable body data: ${error instanceof Error ? error.message : String(error)}`);
  }
  // `freezePreparedIrValue` defensively copies repeated references. Attach the
  // convenience alias only after the deep copy so `functions` and
  // `module.functions` are the same captured array object.
  const frozen = Object.freeze({ ...frozenBase, functions: frozenBase.module.functions }) as FrozenIrBodyBatch;
  if (!frozen || typeof frozen !== "object") bodyBatchInvariant("factory produced no object");
  authenticatedBatches.add(frozen as object);
  return frozen;
}

/** Verify that a value was produced by this factory in this process. */
export function assertFrozenIrBodyBatch(value: unknown): asserts value is FrozenIrBodyBatch {
  if (!value || typeof value !== "object" || !authenticatedBatches.has(value)) {
    bodyBatchInvariant("value is not an authenticated batch");
  }
}

export function isFrozenIrBodyBatch(value: unknown): value is FrozenIrBodyBatch {
  return !!value && typeof value === "object" && authenticatedBatches.has(value);
}
