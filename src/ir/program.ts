// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBackendKind } from "./backend/legality.js";
import type { IrBindingId, IrUnitId } from "./identity.js";
import { freezePreparedIrValue, invalidPreparedData, preparedIrReadonlyMap } from "./program/data.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
export {
  preparedIrReadonlyMap,
  preparedIrDataMismatch,
  freezePreparedIrValue,
  freezePreparedIrRuntimeValue,
} from "./program/data.js";
export { PreparedIrProgramInvariantError } from "./program/errors.js";
export type { PreparedIrProgramInvariantCode } from "./program/errors.js";
import type { ProgramAbiCallableSignature, ProgramAbiPlanEntry } from "./program-abi.js";
import type { PreparedComponentAbiLookup } from "./prepared-component-dependencies.js";
import type { RuntimeManifestPolicy } from "./runtime-manifest.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import type { WasmModule } from "./types.js";
import type { LinearOptions } from "../codegen-linear/index.js";
import type {
  PreparedIrProgramProducerInput,
  PreparedIrProgramFailure,
  PreparedIrProgramRuntimeProjection,
  PreparedIrProgram,
  PreparedIrProgramOwner,
  PreparedIrSourceLocation,
} from "./program/prepared-contracts.js";
export type {
  PreparedIrAbiContract,
  PreparedIrAbiEntry,
  PreparedIrAbiSnapshot,
  PreparedIrProgramProducerInput,
  PreparedIrProgramFailure,
  PreparedIrProgramRuntimeProjection,
  PreparedIrProgram,
  IrProgramPreparationResult,
  PreparedIrProgramOwner,
  PreparedIrSourceLocation,
} from "./program/prepared-contracts.js";

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
