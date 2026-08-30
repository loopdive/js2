// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrSourceId, IrTerminalUnitRecord, IrUnitId } from "../ir/identity.js";
import type { IrObservedOutcome } from "../ir/outcomes.js";
import {
  takePendingPreparedProgramComponentReceipt,
  type PendingPreparedProgramComponentReceipt,
  type PreparedComponentPublicationToken,
} from "../ir/prepared-component-publication.js";
import type { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import type { PreparedComponentPendingScope } from "./multi-source-ir-integration.js";

type SourceFile = ts.SourceFile;

export interface MultiPreparedProgramCallableUnit {
  readonly sourceFile: SourceFile;
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly declaration: ts.FunctionDeclaration;
}

/** One detached aggregate component. No field here is a live publication. */
export interface MultiPreparedProgramCallableComponent {
  readonly preparedComponentId: string;
  readonly units: readonly MultiPreparedProgramCallableUnit[];
  readonly pendingReceipt: PendingPreparedProgramComponentReceipt;
  readonly assertPreflightCurrent: () => void;
}

export interface MultiPreparedCallablePublicationOwnerState {
  readonly components: readonly MultiPreparedProgramCallableComponent[];
  readonly componentByUnitId: ReadonlyMap<IrUnitId, MultiPreparedProgramCallableComponent>;
  readonly componentsBySourceFile: ReadonlyMap<SourceFile, readonly MultiPreparedProgramCallableComponent[]>;
  readonly preparedUnitIds: ReadonlySet<IrUnitId>;
  readonly skippedUnitIds: ReadonlySet<IrUnitId>;
  readonly skippedUnitIdsBySourceFile: ReadonlyMap<SourceFile, ReadonlySet<IrUnitId>>;
}

export interface PreparedMultiPreparedCallablePublication<BodyPlan extends object> {
  readonly bodyPlan: BodyPlan;
  readonly ownerState: MultiPreparedCallablePublicationOwnerState;
  readonly pendingScopes: readonly PreparedComponentPendingScope[];
  readonly finalCompiledFuncs: readonly string[];
  readonly finalOutcomes: IrObservedOutcome[] | undefined;
  /** Assignment-only detached body publication; all checks precede this call. */
  readonly publishBodies: () => void;
}

export interface MultiPreparedCallablePublicationInput {
  readonly ctx: CodegenContext;
  readonly sourceFiles: readonly SourceFile[];
  readonly terminalByUnitId: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly components: readonly MultiPreparedProgramCallableComponent[];
}

type PublicationState = "staged" | "boundary-sealed" | "prepared" | "published" | "aborted";

type PublicationMutation =
  | "body-plan"
  | "attempted-census"
  | "compiled-prefix"
  | "existing-outcome"
  | "outcome-row"
  | "outcome-prefix"
  | "skip-duplicate"
  | "skip-foreign"
  | "skip-missing"
  | "stale-first-scope"
  | "stale-second-scope";

function publicationMutation(): PublicationMutation | undefined {
  const value = process.env.JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_PUBLICATION;
  if (value === undefined) return undefined;
  if (
    value === "body-plan" ||
    value === "attempted-census" ||
    value === "compiled-prefix" ||
    value === "existing-outcome" ||
    value === "outcome-row" ||
    value === "outcome-prefix" ||
    value === "skip-duplicate" ||
    value === "skip-foreign" ||
    value === "skip-missing" ||
    value === "stale-first-scope" ||
    value === "stale-second-scope"
  ) {
    return value;
  }
  throw publicationError(`unknown test mutation ${JSON.stringify(value)}`);
}

function sameIdentityArray<T>(actual: readonly T[] | undefined, expected: readonly T[]): boolean {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function sameSet<T>(actual: ReadonlySet<T>, expected: ReadonlySet<T>): boolean {
  return actual.size === expected.size && [...expected].every((value) => actual.has(value));
}

function publicationError(detail: string): Error {
  return new Error(`multi-prepared callable publication: ${detail}`);
}

function serializeOutcome(outcome: IrObservedOutcome): string {
  const serialized = JSON.stringify(outcome);
  if (serialized === undefined) throw publicationError("terminal outcome cannot be structurally snapshotted");
  return serialized;
}

/**
 * Private, one-shot owner transaction for late callable publication.
 *
 * The constructor snapshots every public context prefix but writes nothing.
 * Body compilation consumes only the private skip methods. `prepareCommit()`
 * is called after the final exact body visit and performs every remaining
 * fallible check before returning assignment-only publication values.
 */
export class MultiPreparedCallablePublication<BodyPlan extends object> {
  readonly #ctx: CodegenContext;
  readonly #sourceFiles: readonly SourceFile[];
  readonly #sourceFileSet: ReadonlySet<SourceFile>;
  readonly #terminalByUnitId: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly #components: readonly MultiPreparedProgramCallableComponent[];
  readonly #componentByUnitId: ReadonlyMap<IrUnitId, MultiPreparedProgramCallableComponent>;
  readonly #componentsBySourceFile: ReadonlyMap<SourceFile, readonly MultiPreparedProgramCallableComponent[]>;
  readonly #preparedUnitIds: ReadonlySet<IrUnitId>;
  readonly #expectedSkipUnitIdsBySourceFile: ReadonlyMap<SourceFile, ReadonlySet<IrUnitId>>;
  readonly #expectedSkipNamesBySourceFile: ReadonlyMap<SourceFile, ReadonlySet<string>>;
  readonly #skippedUnitIdsBySourceFile = new Map<SourceFile, ReadonlySet<IrUnitId>>();
  readonly #compiledPrefixObject: readonly string[] | undefined;
  readonly #compiledPrefix: readonly string[];
  readonly #outcomePrefixObject: readonly IrObservedOutcome[] | undefined;
  readonly #outcomePrefix: readonly IrObservedOutcome[];
  readonly #outcomePrefixRows: readonly string[];
  #bodyPlan: BodyPlan | undefined;
  #state: PublicationState = "staged";

  constructor(input: MultiPreparedCallablePublicationInput) {
    this.#ctx = input.ctx;
    this.#sourceFiles = Object.freeze([...input.sourceFiles]);
    this.#sourceFileSet = new Set(this.#sourceFiles);
    this.#terminalByUnitId = input.terminalByUnitId;
    this.#compiledPrefixObject = input.ctx.irCompiledFuncs;
    this.#compiledPrefix = Object.freeze([...(input.ctx.irCompiledFuncs ?? [])]);
    this.#outcomePrefixObject = input.ctx.irOutcomes;
    this.#outcomePrefix = Object.freeze([...(input.ctx.irOutcomes ?? [])]);
    this.#outcomePrefixRows = Object.freeze(this.#outcomePrefix.map(serializeOutcome));

    if (
      input.components.length === 0 ||
      this.#sourceFileSet.size !== this.#sourceFiles.length ||
      input.ctx.irProgramCallablePreparedUnitIds !== undefined
    ) {
      throw publicationError("staging began with a non-exact source/component or prepared-unit prefix");
    }

    const componentIds = new Set<string>();
    const preparedUnitIds = new Set<IrUnitId>();
    const componentByUnitId = new Map<IrUnitId, MultiPreparedProgramCallableComponent>();
    const componentsBySourceFile = new Map<SourceFile, MultiPreparedProgramCallableComponent[]>();
    const expectedSkipUnitIdsBySourceFile = new Map<SourceFile, Set<IrUnitId>>();
    const expectedSkipNamesBySourceFile = new Map<SourceFile, Set<string>>();
    const components = input.components.map((component) => {
      const receipt = component.pendingReceipt;
      const unitIds = component.units.map(({ unitId }) => unitId);
      if (
        component.preparedComponentId.length === 0 ||
        componentIds.has(component.preparedComponentId) ||
        component.units.length === 0 ||
        receipt.kind !== "pending-prepared-program-component" ||
        receipt.preparedComponentId !== component.preparedComponentId ||
        !sameIdentityArray(receipt.terminalUnitIds, unitIds) ||
        typeof component.assertPreflightCurrent !== "function"
      ) {
        throw publicationError(`component ${component.preparedComponentId || "<empty>"} has a non-exact receipt`);
      }
      componentIds.add(component.preparedComponentId);
      const units = component.units.map((unit) => {
        const terminal = input.terminalByUnitId.get(unit.unitId);
        if (
          preparedUnitIds.has(unit.unitId) ||
          !this.#sourceFileSet.has(unit.sourceFile) ||
          !terminal ||
          terminal.id !== unit.unitId ||
          terminal.sourceId !== unit.sourceId ||
          terminal.terminalOwnerId !== unit.unitId ||
          terminal.kind !== "top-level-function" ||
          terminal.observedKind !== "function" ||
          terminal.legacyMatchName !== unit.legacyName
        ) {
          throw publicationError(`component ${component.preparedComponentId} has a foreign terminal ${unit.unitId}`);
        }
        preparedUnitIds.add(unit.unitId);
        const frozenUnit = Object.freeze({ ...unit });
        const skipUnitIds = expectedSkipUnitIdsBySourceFile.get(unit.sourceFile) ?? new Set<IrUnitId>();
        const skipNames = expectedSkipNamesBySourceFile.get(unit.sourceFile) ?? new Set<string>();
        if (skipNames.has(unit.legacyName)) {
          throw publicationError(
            `component ${component.preparedComponentId} repeats local skip name ${unit.legacyName}`,
          );
        }
        skipUnitIds.add(unit.unitId);
        skipNames.add(unit.legacyName);
        expectedSkipUnitIdsBySourceFile.set(unit.sourceFile, skipUnitIds);
        expectedSkipNamesBySourceFile.set(unit.sourceFile, skipNames);
        return frozenUnit;
      });
      const frozen = Object.freeze({ ...component, units: Object.freeze(units) });
      for (const unit of frozen.units) {
        componentByUnitId.set(unit.unitId, frozen);
        const sourceComponents = componentsBySourceFile.get(unit.sourceFile) ?? [];
        if (!sourceComponents.includes(frozen)) sourceComponents.push(frozen);
        componentsBySourceFile.set(unit.sourceFile, sourceComponents);
      }
      return frozen;
    });

    for (const sourceFile of this.#sourceFiles) {
      expectedSkipUnitIdsBySourceFile.set(sourceFile, new Set(expectedSkipUnitIdsBySourceFile.get(sourceFile) ?? []));
      expectedSkipNamesBySourceFile.set(sourceFile, new Set(expectedSkipNamesBySourceFile.get(sourceFile) ?? []));
      componentsBySourceFile.set(sourceFile, [...(componentsBySourceFile.get(sourceFile) ?? [])]);
    }
    this.#components = Object.freeze(components);
    this.#componentByUnitId = componentByUnitId;
    this.#componentsBySourceFile = componentsBySourceFile;
    this.#preparedUnitIds = preparedUnitIds;
    this.#expectedSkipUnitIdsBySourceFile = expectedSkipUnitIdsBySourceFile;
    this.#expectedSkipNamesBySourceFile = expectedSkipNamesBySourceFile;
  }

  get unitIds(): ReadonlySet<IrUnitId> {
    return new Set(this.#preparedUnitIds);
  }

  /** Private owner census used to build the not-yet-public body-plan shadow. */
  stagedComponents(): readonly MultiPreparedProgramCallableComponent[] {
    if (this.#state !== "staged" && this.#state !== "boundary-sealed") {
      throw publicationError(`cannot read staged components while transaction is ${this.#state}`);
    }
    return this.#components;
  }

  skipNamesForSource(sourceFile: SourceFile): ReadonlySet<string> {
    this.#assertBodyReadable();
    this.#assertSource(sourceFile);
    return new Set(this.#expectedSkipNamesBySourceFile.get(sourceFile));
  }

  skipUnitIdsForSource(sourceFile: SourceFile): ReadonlySet<IrUnitId> {
    this.#assertBodyReadable();
    this.#assertSource(sourceFile);
    return new Set(this.#expectedSkipUnitIdsBySourceFile.get(sourceFile));
  }

  sealBodyBoundary(bodyPlan: BodyPlan): void {
    this.#assertState("staged", "seal the private body boundary");
    if (publicationMutation() === "body-plan") {
      throw publicationError("injected private body-plan reservation failure");
    }
    this.#bodyPlan = bodyPlan;
    this.#state = "boundary-sealed";
  }

  recordSkippedUnitIds(sourceFile: SourceFile, unitIds: readonly IrUnitId[]): void {
    this.#assertState("boundary-sealed", "record callable body skips");
    this.#assertSource(sourceFile);
    if (this.#skippedUnitIdsBySourceFile.has(sourceFile)) {
      throw publicationError(`source ${sourceFile.fileName} reported callable body skips twice`);
    }
    const expected = this.#expectedSkipUnitIdsBySourceFile.get(sourceFile)!;
    const mutatedUnitIds = [...unitIds];
    const mutation = publicationMutation();
    if (expected.size > 0 && mutation === "skip-missing") mutatedUnitIds.pop();
    if (expected.size > 0 && mutation === "skip-duplicate") mutatedUnitIds.push(mutatedUnitIds[0]!);
    if (expected.size > 0 && mutation === "skip-foreign") {
      mutatedUnitIds.push("ir-unit:v1:test-foreign-callable-skip" as IrUnitId);
    }
    const observed = new Set(mutatedUnitIds);
    if (observed.size !== mutatedUnitIds.length || !sameSet(observed, expected)) {
      throw publicationError(`source ${sourceFile.fileName} did not report its exact callable body skips`);
    }
    this.#skippedUnitIdsBySourceFile.set(sourceFile, observed);
  }

  assertSourceSkipped(sourceFile: SourceFile): void {
    this.#assertBodyReadable();
    this.#assertSource(sourceFile);
    const observed = this.#skippedUnitIdsBySourceFile.get(sourceFile);
    const expected = this.#expectedSkipUnitIdsBySourceFile.get(sourceFile)!;
    if (!observed || !sameSet(observed, expected)) {
      throw publicationError(`source ${sourceFile.fileName} has an incomplete callable skip receipt`);
    }
  }

  prepareCommit(): PreparedMultiPreparedCallablePublication<BodyPlan> {
    this.#assertState("boundary-sealed", "prepare final callable publication");
    const bodyPlan = this.#bodyPlan;
    if (bodyPlan === undefined) throw publicationError("private body plan is missing");
    this.#assertAllSkipped();
    this.#assertPreflightCurrent();
    this.#assertContextPrefixes();

    const existingUnitIds = new Set(
      this.#outcomePrefix.flatMap((outcome) => (outcome.unitId === undefined ? [] : [outcome.unitId])),
    );
    const existingKeys = new Set(this.#outcomePrefix.map(({ key }) => key));
    if (publicationMutation() === "existing-outcome") {
      existingUnitIds.add(this.#components[0]!.units[0]!.unitId);
    }
    const target: IrObservedOutcome["target"] = this.#ctx.wasi ? "wasi" : this.#ctx.standalone ? "standalone" : "gc";
    const finalOutcomes =
      this.#outcomePrefixObject === undefined
        ? undefined
        : [
            ...this.#outcomePrefix,
            ...this.#components.flatMap((component) =>
              component.units.map((unit): IrObservedOutcome => {
                const terminal = this.#terminalByUnitId.get(unit.unitId)!;
                if (existingUnitIds.has(unit.unitId) || existingKeys.has(terminal.legacyKey)) {
                  throw publicationError(`terminal outcome prefix already owns ${unit.unitId}`);
                }
                existingUnitIds.add(unit.unitId);
                existingKeys.add(terminal.legacyKey);
                return Object.freeze({
                  key: terminal.legacyKey,
                  sourceId: terminal.sourceId,
                  unitId: terminal.id,
                  file: unit.sourceFile.fileName,
                  unitKind: terminal.observedKind,
                  displayName: terminal.displayName,
                  ordinal: terminal.legacyOrdinal,
                  line: terminal.line,
                  column: terminal.column,
                  backend: "wasmgc",
                  target,
                  legacyBodyEmitted: false,
                  irBodyEmitted: true,
                  preparedComponentId: component.preparedComponentId,
                  kind: "emitted",
                  stage: "patch",
                });
              }),
            ),
          ];

    const tokens: PreparedComponentPublicationToken[] = [];
    try {
      const staleScopeMutation = publicationMutation();
      if (staleScopeMutation === "stale-first-scope") this.#components[0]!.pendingReceipt.abort();
      if (staleScopeMutation === "stale-second-scope") {
        const second = this.#components[1];
        if (!second) throw publicationError("stale-second-scope mutation requires two prepared components");
        second.pendingReceipt.abort();
      }
      for (const component of this.#components) {
        component.pendingReceipt.assertCurrent();
        const token = takePendingPreparedProgramComponentReceipt(component.pendingReceipt);
        if (
          token.preparedComponentId !== component.preparedComponentId ||
          !sameIdentityArray(
            token.terminalUnitIds,
            component.units.map(({ unitId }) => unitId),
          ) ||
          token.pendingScope.scopeId !== component.preparedComponentId ||
          !sameIdentityArray(
            token.pendingScope.terminalUnitIds,
            component.units.map(({ unitId }) => unitId),
          )
        ) {
          throw publicationError(`component ${component.preparedComponentId} changed at final receipt claim`);
        }
        tokens.push(token);
      }
    } catch (error) {
      this.#state = "aborted";
      for (const component of this.#components) {
        try {
          component.pendingReceipt.abort();
        } catch {
          // A prior failing take may already have aborted its own exact scope.
        }
      }
      throw error;
    }

    const skippedUnitIds = new Set<IrUnitId>();
    for (const unitIds of this.#skippedUnitIdsBySourceFile.values()) {
      for (const unitId of unitIds) skippedUnitIds.add(unitId);
    }
    const ownerState: MultiPreparedCallablePublicationOwnerState = Object.freeze({
      components: this.#components,
      componentByUnitId: this.#componentByUnitId,
      componentsBySourceFile: this.#componentsBySourceFile,
      preparedUnitIds: this.#preparedUnitIds,
      skippedUnitIds,
      skippedUnitIdsBySourceFile: this.#skippedUnitIdsBySourceFile,
    });
    const finalCompiledFuncs = Object.freeze([
      ...this.#compiledPrefix,
      ...this.#components.flatMap((component) => component.units.map(({ legacyName }) => legacyName)),
    ]);
    let bodiesPublished = false;
    this.#state = "prepared";
    return Object.freeze({
      bodyPlan,
      ownerState,
      pendingScopes: Object.freeze(tokens.map(({ pendingScope }) => pendingScope)),
      finalCompiledFuncs,
      finalOutcomes,
      publishBodies: () => {
        if (bodiesPublished) return;
        for (const token of tokens) token.publishBodies();
        bodiesPublished = true;
      },
    });
  }

  /** Assignment-only state transition used after the first live commit write. */
  markPublishedNoThrow(): void {
    this.#state = "published";
  }

  abort(): void {
    if (this.#state === "aborted") return;
    if (this.#state === "published") throw publicationError("cannot abort a published callable transaction");
    for (const component of this.#components) {
      try {
        component.pendingReceipt.abort();
      } catch {
        // Abort remains idempotent at the owner batch boundary even though an
        // individual receipt deliberately diagnoses direct replay.
      }
    }
    this.#state = "aborted";
  }

  #assertContextPrefixes(): void {
    const mutation = publicationMutation();
    const compiledBeforeMutation = this.#ctx.irCompiledFuncs;
    const outcomesBeforeMutation = this.#ctx.irOutcomes;
    const outcomeRowBeforeMutation = outcomesBeforeMutation?.[0];
    try {
      // Test-only mutations perturb the real compared state. The finally block
      // removes the injected perturbation after the detector observes it, so
      // the seam itself cannot masquerade as a leaked publication prefix.
      if (mutation === "compiled-prefix") {
        this.#ctx.irCompiledFuncs = [...(this.#ctx.irCompiledFuncs ?? []), "__test_stale_compiled_prefix"];
      } else if (mutation === "outcome-prefix") {
        this.#ctx.irOutcomes = [...(this.#ctx.irOutcomes ?? [])];
      } else if (mutation === "outcome-row" && outcomeRowBeforeMutation !== undefined) {
        this.#ctx.irOutcomes![0] = {
          ...outcomeRowBeforeMutation,
          file: `${outcomeRowBeforeMutation.file}#test-stale-row`,
        };
      }
      if (
        this.#ctx.irProgramCallablePreparedUnitIds !== undefined ||
        this.#ctx.irCompiledFuncs !== this.#compiledPrefixObject ||
        !sameIdentityArray(this.#ctx.irCompiledFuncs ?? [], this.#compiledPrefix) ||
        this.#ctx.irOutcomes !== this.#outcomePrefixObject ||
        !sameIdentityArray(this.#ctx.irOutcomes ?? [], this.#outcomePrefix) ||
        !sameIdentityArray((this.#ctx.irOutcomes ?? []).map(serializeOutcome), this.#outcomePrefixRows)
      ) {
        throw publicationError("callable telemetry/outcome prefix changed before final publication");
      }
    } finally {
      this.#ctx.irCompiledFuncs = compiledBeforeMutation;
      this.#ctx.irOutcomes = outcomesBeforeMutation;
      if (
        mutation === "outcome-row" &&
        outcomesBeforeMutation !== undefined &&
        outcomeRowBeforeMutation !== undefined
      ) {
        outcomesBeforeMutation[0] = outcomeRowBeforeMutation;
      }
    }
  }

  #assertPreflightCurrent(): void {
    const attemptedBeforeMutation = this.#ctx.irProgramCallableAttemptedUnitIds;
    try {
      if (publicationMutation() === "attempted-census" && attemptedBeforeMutation !== undefined) {
        const mutated = new Set(attemptedBeforeMutation);
        mutated.delete(mutated.values().next().value!);
        this.#ctx.irProgramCallableAttemptedUnitIds = mutated;
      }
      for (const component of this.#components) component.assertPreflightCurrent();
    } finally {
      this.#ctx.irProgramCallableAttemptedUnitIds = attemptedBeforeMutation;
    }
  }

  #assertAllSkipped(): void {
    if (this.#skippedUnitIdsBySourceFile.size !== this.#sourceFiles.length) {
      throw publicationError("callable skip receipts do not cover every semantic source");
    }
    const observed = new Set<IrUnitId>();
    for (const sourceFile of this.#sourceFiles) {
      this.assertSourceSkipped(sourceFile);
      for (const unitId of this.#skippedUnitIdsBySourceFile.get(sourceFile)!) observed.add(unitId);
    }
    if (!sameSet(observed, this.#preparedUnitIds)) {
      throw publicationError("callable skip receipts do not cover the staged terminal population");
    }
  }

  #assertSource(sourceFile: SourceFile): void {
    if (!this.#sourceFileSet.has(sourceFile)) {
      throw publicationError(`source ${sourceFile.fileName} is outside the staged semantic population`);
    }
  }

  #assertBodyReadable(): void {
    if (this.#state !== "boundary-sealed" && this.#state !== "prepared" && this.#state !== "published") {
      throw publicationError(`cannot read callable body projection while transaction is ${this.#state}`);
    }
  }

  #assertState(expected: PublicationState, action: string): void {
    if (this.#state !== expected) {
      throw publicationError(`cannot ${action} while transaction is ${this.#state}; expected ${expected}`);
    }
  }
}
