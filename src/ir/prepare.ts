// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrTerminalUnitRecord, IrUnitId } from "./identity.js";
import {
  createPreparedIrCandidateProgram,
  freezePreparedIrValue,
  preparedIrReadonlyMap,
  PreparedIrProgramInvariantError,
  type PreparedIrAllocationCandidate,
  type PreparedIrAssertedBackendLegality,
  type PreparedIrAssertedOptimizationEvidence,
  type PreparedIrDirectCandidate,
  type PreparedIrInvariantCandidate,
  type PreparedIrIrCandidate,
  type PreparedIrProgram,
  type PreparedIrProvenanceCandidate,
  type PreparedIrSupportIntentCandidate,
  type PreparedIrUnitCandidate,
} from "./program.js";
import type { ProgramAbiCallableSignature } from "./program-abi.js";
import { ProgramAbiMap } from "./program-abi.js";

export interface PreparedIrIrCandidateInput {
  readonly unitId: IrUnitId;
  readonly assertedSignature: ProgramAbiCallableSignature;
  readonly assertedExportIntents?: readonly IrBindingId[];
  readonly assertedBackendLegality: PreparedIrAssertedBackendLegality;
  readonly assertedOptimization: PreparedIrAssertedOptimizationEvidence;
  readonly irCandidate: unknown;
}

export interface PreparedIrFailureCandidateInput {
  readonly unitId: IrUnitId;
  readonly code: string;
  readonly stage: string;
  readonly detail: string;
}

export interface PreparedIrComponentCandidateInput {
  readonly id: string;
  readonly unitIds: readonly IrUnitId[];
}

type BuilderState = "open" | "sealing" | "sealed" | "failed";

function location(unit: IrTerminalUnitRecord) {
  return Object.freeze({
    sourceId: unit.sourceId,
    line: unit.line,
    column: unit.column,
    declarationStart: unit.declarationStart,
    declarationEnd: unit.declarationEnd,
  });
}

function ownSignature(signature: ProgramAbiCallableSignature): ProgramAbiCallableSignature {
  return Object.freeze({
    params: Object.freeze([...signature.params]),
    results: Object.freeze([...signature.results]),
  });
}

function ownIrCandidate(input: PreparedIrIrCandidateInput, unit: IrTerminalUnitRecord): PreparedIrIrCandidate {
  return Object.freeze({
    kind: "ir-candidate" as const,
    route: "ir" as const,
    evidenceStatus: "unvalidated-candidate" as const,
    unitId: input.unitId,
    location: location(unit),
    assertedSignature: ownSignature(input.assertedSignature),
    assertedExportIntents: Object.freeze([...(input.assertedExportIntents ?? [])]),
    assertedBackendLegality: Object.freeze({ ...input.assertedBackendLegality }),
    assertedOptimization: Object.freeze({ ...input.assertedOptimization }),
    irCandidate: freezePreparedIrValue(input.irCandidate),
  });
}

function ownFailureCandidate(
  kind: "direct-candidate" | "invariant-candidate",
  input: PreparedIrFailureCandidateInput,
  unit: IrTerminalUnitRecord,
): PreparedIrDirectCandidate | PreparedIrInvariantCandidate {
  return Object.freeze({
    kind,
    route: kind === "direct-candidate" ? ("direct" as const) : ("neither" as const),
    evidenceStatus: "unvalidated-candidate" as const,
    unitId: input.unitId,
    location: location(unit),
    code: input.code,
    stage: input.stage,
    detail: input.detail,
  }) as PreparedIrDirectCandidate | PreparedIrInvariantCandidate;
}

function duplicateIds(ids: readonly IrUnitId[]): IrUnitId[] {
  const seen = new Set<IrUnitId>();
  const duplicates = new Set<IrUnitId>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

/**
 * Structural candidate collector only. seal() proves denominator/lifecycle
 * integrity, not production Prepared status. Production wiring must derive and
 * reconcile IR edges, signatures, support, allocation, and provenance.
 */
export class PreparedIrProgramBuilder {
  readonly #abi: ProgramAbiMap;
  readonly #freeUnits: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly #candidates: PreparedIrUnitCandidate[] = [];
  readonly #componentCandidates: PreparedIrComponentCandidateInput[] = [];
  readonly #supportIntentCandidates: Omit<PreparedIrSupportIntentCandidate, "evidenceStatus">[] = [];
  readonly #allocationCandidates: Omit<PreparedIrAllocationCandidate, "evidenceStatus">[] = [];
  readonly #provenanceCandidates: Omit<PreparedIrProvenanceCandidate, "evidenceStatus">[] = [];
  #state: BuilderState = "open";
  #program?: PreparedIrProgram;

  constructor(abi: ProgramAbiMap) {
    if (!abi.planningSealed) {
      throw new PreparedIrProgramInvariantError(
        "abi-not-sealed",
        "PreparedIrProgram requires a sealed ProgramAbiMap plan",
      );
    }
    this.#abi = abi;
    this.#freeUnits = preparedIrReadonlyMap(
      abi.inventory.terminalUnits
        .filter((unit) => unit.kind === "top-level-function")
        .map((unit) => [unit.id, unit] as const),
    );
  }

  recordIrCandidate(input: PreparedIrIrCandidateInput): void {
    this.#mutate(() => {
      const ownedInput = freezePreparedIrValue(input) as PreparedIrIrCandidateInput;
      const unit = this.#requireFreeUnit(ownedInput.unitId);
      if (
        ownedInput.assertedBackendLegality.verified !== true ||
        ownedInput.assertedOptimization.allocationProvenance !== "verified" ||
        !Array.isArray(ownedInput.assertedSignature.params) ||
        !Array.isArray(ownedInput.assertedSignature.results)
      ) {
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          `IR candidate ${ownedInput.unitId} lacks structurally valid asserted evidence`,
        );
      }
      this.#candidates.push(ownIrCandidate(ownedInput, unit));
    });
  }

  recordDirectCandidate(input: PreparedIrFailureCandidateInput): void {
    this.#mutate(() => {
      const ownedInput = freezePreparedIrValue(input) as PreparedIrFailureCandidateInput;
      const unit = this.#requireFreeUnit(ownedInput.unitId);
      this.#candidates.push(ownFailureCandidate("direct-candidate", ownedInput, unit) as PreparedIrDirectCandidate);
    });
  }

  recordInvariantCandidate(input: PreparedIrFailureCandidateInput): void {
    this.#mutate(() => {
      const ownedInput = freezePreparedIrValue(input) as PreparedIrFailureCandidateInput;
      const unit = this.#requireFreeUnit(ownedInput.unitId);
      this.#candidates.push(
        ownFailureCandidate("invariant-candidate", ownedInput, unit) as PreparedIrInvariantCandidate,
      );
    });
  }

  addComponentCandidate(input: PreparedIrComponentCandidateInput): void {
    this.#mutate(() => {
      const ownedInput = freezePreparedIrValue(input) as PreparedIrComponentCandidateInput;
      this.#componentCandidates.push(
        Object.freeze({ id: ownedInput.id, unitIds: Object.freeze([...ownedInput.unitIds]) }),
      );
    });
  }

  addSupportIntentCandidate(input: Omit<PreparedIrSupportIntentCandidate, "evidenceStatus">): void {
    if (this.#state !== "open") {
      throw new PreparedIrProgramInvariantError(
        "late-support-intent",
        "support intent candidate was requested after preparation sealed",
      );
    }
    this.#mutate(() => {
      const ownedInput = freezePreparedIrValue(input) as Omit<PreparedIrSupportIntentCandidate, "evidenceStatus">;
      this.#supportIntentCandidates.push(ownedInput);
    });
  }

  addAllocationCandidate(input: Omit<PreparedIrAllocationCandidate, "evidenceStatus">): void {
    this.#mutate(() => {
      const ownedInput = freezePreparedIrValue(input) as Omit<PreparedIrAllocationCandidate, "evidenceStatus">;
      this.#allocationCandidates.push(ownedInput);
    });
  }

  addProvenanceCandidate(input: Omit<PreparedIrProvenanceCandidate, "evidenceStatus">): void {
    this.#mutate(() => {
      const ownedInput = freezePreparedIrValue(input) as Omit<PreparedIrProvenanceCandidate, "evidenceStatus">;
      this.#provenanceCandidates.push(ownedInput);
    });
  }

  seal(): PreparedIrProgram {
    if (this.#state === "sealed") return this.#program!;
    this.#assertOpen();
    this.#state = "sealing";
    try {
      const units = this.#validateUnitCandidates();
      this.#validateComponentCandidates();
      this.#validateSupportCandidates();
      this.#validateIrOwnedCandidates(units);
      this.#program = createPreparedIrCandidateProgram({
        abiEntries: this.#abi.entries(),
        units,
        componentCandidates: this.#componentCandidates,
        supportIntentCandidates: this.#supportIntentCandidates,
        allocationCandidates: this.#allocationCandidates,
        provenanceCandidates: this.#provenanceCandidates,
      });
      this.#state = "sealed";
      return this.#program;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  #validateUnitCandidates(): ReadonlyMap<IrUnitId, PreparedIrUnitCandidate> {
    const duplicateCandidates = duplicateIds(this.#candidates.map((candidate) => candidate.unitId));
    if (duplicateCandidates.length > 0) {
      throw new PreparedIrProgramInvariantError(
        "duplicate-unit",
        `free-function candidates duplicated: ${duplicateCandidates.join(", ")}`,
      );
    }
    const candidates = new Map(this.#candidates.map((candidate) => [candidate.unitId, candidate] as const));
    const missing = [...this.#freeUnits.keys()].filter((unitId) => !candidates.has(unitId));
    if (missing.length > 0) {
      throw new PreparedIrProgramInvariantError(
        "missing-unit",
        `free-function candidates missing: ${missing.join(", ")}`,
      );
    }
    return candidates;
  }

  #validateComponentCandidates(): void {
    const ids = this.#componentCandidates.map((component) => component.id);
    if (new Set(ids).size !== ids.length) {
      throw new PreparedIrProgramInvariantError(
        "duplicate-component-candidate",
        "component candidate IDs must be unique",
      );
    }
    for (const component of this.#componentCandidates) {
      if (component.unitIds.length === 0) {
        throw new PreparedIrProgramInvariantError(
          "empty-component-candidate",
          `component candidate ${component.id} is empty`,
        );
      }
      const unknown = component.unitIds.filter((unitId) => !this.#freeUnits.has(unitId));
      if (unknown.length > 0) {
        throw new PreparedIrProgramInvariantError(
          "unknown-unit",
          `component candidate ${component.id} includes non-R2 units: ${unknown.join(", ")}`,
        );
      }
    }
  }

  #validateSupportCandidates(): void {
    const keys = this.#supportIntentCandidates.map((candidate) => candidate.key);
    if (new Set(keys).size !== keys.length) {
      throw new PreparedIrProgramInvariantError(
        "duplicate-support-intent-candidate",
        "support intent candidate keys must be unique",
      );
    }
    for (const candidate of this.#supportIntentCandidates) {
      if (candidate.ownerUnitId && !this.#freeUnits.has(candidate.ownerUnitId)) {
        throw new PreparedIrProgramInvariantError(
          "unknown-support-owner",
          `support intent candidate ${candidate.key} has unknown owner ${candidate.ownerUnitId}`,
        );
      }
      if (candidate.bindingId && !this.#abi.get(candidate.bindingId)) {
        throw new PreparedIrProgramInvariantError(
          "unknown-support-binding",
          `support intent candidate ${candidate.key} references unplanned binding ${candidate.bindingId}`,
        );
      }
    }
  }

  #validateIrOwnedCandidates(units: ReadonlyMap<IrUnitId, PreparedIrUnitCandidate>): void {
    const allocationKeys = this.#allocationCandidates.map((candidate) => candidate.key);
    if (new Set(allocationKeys).size !== allocationKeys.length) {
      throw new PreparedIrProgramInvariantError(
        "duplicate-allocation-candidate",
        "allocation candidate keys must be unique",
      );
    }
    for (const candidate of this.#allocationCandidates) {
      if (units.get(candidate.ownerUnitId)?.kind !== "ir-candidate") {
        throw new PreparedIrProgramInvariantError(
          "allocation-not-ir-candidate-owned",
          `allocation candidate ${candidate.key} is owned by non-IR candidate ${candidate.ownerUnitId}`,
        );
      }
    }
    const artifacts = this.#provenanceCandidates.map((candidate) => candidate.artifactUnitId);
    if (new Set(artifacts).size !== artifacts.length) {
      throw new PreparedIrProgramInvariantError(
        "duplicate-provenance-candidate",
        "provenance candidate artifacts must be unique",
      );
    }
    for (const candidate of this.#provenanceCandidates) {
      if (units.get(candidate.ownerUnitId)?.kind !== "ir-candidate") {
        throw new PreparedIrProgramInvariantError(
          "provenance-not-ir-candidate-owned",
          `provenance candidate ${candidate.artifactUnitId} is owned by non-IR candidate ${candidate.ownerUnitId}`,
        );
      }
    }
  }

  #requireFreeUnit(unitId: IrUnitId): IrTerminalUnitRecord {
    const unit = this.#freeUnits.get(unitId);
    if (!unit) {
      throw new PreparedIrProgramInvariantError(
        "unknown-unit",
        `${unitId} is not an inventoried top-level free function`,
      );
    }
    return unit;
  }

  #mutate(operation: () => void): void {
    this.#assertOpen();
    try {
      operation();
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#state === "failed") {
      throw new PreparedIrProgramInvariantError("program-seal-failed", "preparation transaction already failed");
    }
    if (this.#state !== "open") {
      throw new PreparedIrProgramInvariantError("program-sealed", `preparation transaction is ${this.#state}`);
    }
  }
}
