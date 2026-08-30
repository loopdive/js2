// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrUnitId } from "../ir/identity.js";
import { ProgramAbiInvariantError, type ProgramAbiSlotSpace } from "../ir/program-abi.js";
import type {
  PreparedProgramAbiBorrowedBindingEvidence,
  PreparedProgramAbiComponentBatchInput,
  PreparedProgramAbiPendingScope,
  PreparedProgramAbiPlanningOverlay,
  PreparedProgramAbiStagedBatch,
  PreparedProgramAbiTransactionHost,
} from "./program-abi-prepared-transaction.js";
import { cloneProgramAbiCallableTypeContract, type ProgramAbiCallableTypeContract } from "./program-abi-signatures.js";
import type { ProgramAbiDraft, ProgramAbiSlotLocator, SealedPreparedProgramAbiScope } from "./program-abi-session.js";

export interface PreparedProgramAbiScopeLookup {
  get(id: IrBindingId): ProgramAbiDraft | undefined;
  bindingIdsForStructuralReference(key: string): readonly IrBindingId[];
  /** Exact current allocator locator, if this binding reserves a slot. */
  getLocator(id: IrBindingId): ProgramAbiSlotLocator | undefined;
  /** Resolve a required slot through this scope's claimed overlay. */
  resolveCurrentIndex(id: IrBindingId, expectedSpace: ProgramAbiSlotSpace, structuralReferenceKey: string): number;
  /** Current (post-remap) callable contract for one binding. */
  currentCallableSignature(id: IrBindingId): ProgramAbiCallableTypeContract | undefined;
  /** Explicitly named alias for callers that need the structured contract. */
  currentCallableContract(id: IrBindingId): ProgramAbiCallableTypeContract | undefined;
  /** Exact allocator object behind a claimed locator, for currentness joins. */
  locatorObject(id: IrBindingId): object | undefined;
  /** Compatibility spelling matching ProgramAbiSession's live lookup helper. */
  locatorObjectForBinding(id: IrBindingId): object | undefined;
}

function preparedPlanningCanonicalDraft(planning: PreparedProgramAbiPlanningOverlay, id: IrBindingId): ProgramAbiDraft {
  let current = planning.drafts.get(id);
  if (!current) throw new ProgramAbiInvariantError("unknown-binding", `prepared ABI lookup references ${id}`);
  const visited = new Set<IrBindingId>();
  while (current.slotPolicy === "alias") {
    if (!visited.add(current.id))
      throw new ProgramAbiInvariantError("alias-cycle", `prepared ABI lookup alias cycle includes ${current.id}`);
    current = planning.drafts.get(current.aliasOf);
    if (!current) throw new ProgramAbiInvariantError("missing-alias-target", "prepared ABI lookup has missing target");
  }
  return current;
}

/** Build the exact read-only resolver surface for a prepared ABI overlay. */
export function createPreparedProgramAbiScopeLookup(
  host: PreparedProgramAbiTransactionHost,
  planning: PreparedProgramAbiPlanningOverlay,
): PreparedProgramAbiScopeLookup {
  const canonical = (id: IrBindingId): ProgramAbiDraft => preparedPlanningCanonicalDraft(planning, id);
  const objectFor = (id: IrBindingId): object | undefined => {
    const locator = planning.locators.get(canonical(id).id);
    return locator === undefined ? undefined : locator.kind === "type-cell" ? locator.cell : locator.value;
  };
  const compare = (a: ProgramAbiDraft, b: ProgramAbiDraft): number => {
    const left = a.structuralOrder;
    const right = b.structuralOrder;
    return (
      host.sourceOrderById.get(left.sourceId)! - host.sourceOrderById.get(right.sourceId)! ||
      left.declarationOrdinal - right.declarationOrdinal ||
      left.domainOrdinal - right.domainOrdinal ||
      left.roleOrdinal - right.roleOrdinal ||
      left.derivedOrdinal - right.derivedOrdinal
    );
  };
  return Object.freeze({
    get: (id: IrBindingId) => planning.drafts.get(id),
    bindingIdsForStructuralReference: (key: string) =>
      typeof key !== "string" || key.length === 0
        ? Object.freeze([])
        : Object.freeze(
            [...planning.drafts.values()]
              .filter((draft) => draft.structuralReferenceKey === key)
              .sort(compare)
              .map(({ id }) => id),
          ),
    getLocator: (id: IrBindingId) => planning.locators.get(canonical(id).id),
    resolveCurrentIndex: (id: IrBindingId, expectedSpace: ProgramAbiSlotSpace, structuralReferenceKey: string) => {
      // Authenticate the exact requested binding before following an alias.
      // Alias drafts own their edge-specific structural key even though their
      // slot is resolved through the canonical target. Canonicalizing first
      // would compare that alias key with the target's key and reject a valid
      // prepared lookup.
      const requested = planning.drafts.get(id);
      if (!requested) {
        throw new ProgramAbiInvariantError("unknown-binding", `prepared ABI lookup references ${id}`);
      }
      const requestedKey = planning.structuralReferenceKeys.get(requested.id);
      if (requested.structuralReferenceKey !== structuralReferenceKey || requestedKey !== structuralReferenceKey) {
        throw new ProgramAbiInvariantError(
          "binding-reference-mismatch",
          `prepared ABI key does not belong to ${requested.id}`,
        );
      }
      const draft = canonical(id);
      const canonicalKey = planning.structuralReferenceKeys.get(draft.id);
      if (
        draft.structuralReferenceKey !== canonicalKey ||
        typeof canonicalKey !== "string" ||
        canonicalKey.length === 0
      ) {
        throw new ProgramAbiInvariantError(
          "binding-reference-mismatch",
          `prepared ABI key does not belong to ${draft.id}`,
        );
      }
      if (draft.slotPolicy !== "required" || draft.slotSpace !== expectedSpace) {
        throw new ProgramAbiInvariantError(
          "slot-locator-space-mismatch",
          `prepared ABI lookup ${id} does not resolve to required ${expectedSpace} slot`,
        );
      }
      const locator = planning.locators.get(draft.id);
      if (!locator)
        throw new ProgramAbiInvariantError("missing-required-locator", `prepared ABI lookup ${id} has no locator`);
      return host.resolveCurrentIndex(draft.id, expectedSpace, canonicalKey, locator);
    },
    currentCallableSignature: (id: IrBindingId) => {
      const contract = planning.callableTypeContracts.get(canonical(id).id);
      return contract === undefined ? undefined : cloneProgramAbiCallableTypeContract(contract);
    },
    currentCallableContract: (id: IrBindingId) => {
      const contract = planning.callableTypeContracts.get(canonical(id).id);
      return contract === undefined ? undefined : cloneProgramAbiCallableTypeContract(contract);
    },
    locatorObject: objectFor,
    locatorObjectForBinding: objectFor,
  });
}

export type PreparedProgramAbiScopePublicationState = "open" | "prepared" | "sealed" | "aborted";

export interface PreparedProgramAbiPendingScopeLifecycleCell {
  state: PreparedProgramAbiScopePublicationState;
}

export interface PreparedProgramAbiPendingScopeTransactionActions {
  readonly cell: PreparedProgramAbiPendingScopeLifecycleCell;
  readonly committedState: "sealed";
  readonly abortedState: "aborted";
}

/** One-shot dependency transaction for one prepared executable component. */
export class PreparedProgramAbiScopeTransaction {
  readonly #bindingIds = new Set<IrBindingId>();
  readonly #borrowedBindings = new Map<IrBindingId, PreparedProgramAbiBorrowedBindingEvidence>();
  readonly #prepareScope: (
    bindingIds: ReadonlySet<IrBindingId>,
    borrowedBindings: ReadonlyMap<IrBindingId, PreparedProgramAbiBorrowedBindingEvidence>,
    batch: PreparedProgramAbiStagedBatch | undefined,
  ) => PreparedProgramAbiPendingScope;
  readonly #commitScope: (pending: PreparedProgramAbiPendingScope) => SealedPreparedProgramAbiScope;
  readonly #stageBatch: (input: PreparedProgramAbiComponentBatchInput) => PreparedProgramAbiStagedBatch;
  readonly #abortScope: (
    batch: PreparedProgramAbiStagedBatch | undefined,
    pending: PreparedProgramAbiPendingScope | undefined,
  ) => void;
  readonly #baseLookup: PreparedProgramAbiScopeLookup;
  #batch: PreparedProgramAbiStagedBatch | undefined;
  #pending: PreparedProgramAbiPendingScope | undefined;
  readonly #publicationStateCell: PreparedProgramAbiPendingScopeLifecycleCell = { state: "open" };

  constructor(
    readonly scopeId: string,
    readonly terminalUnitIds: readonly IrUnitId[],
    prepareScope: (
      bindingIds: ReadonlySet<IrBindingId>,
      borrowedBindings: ReadonlyMap<IrBindingId, PreparedProgramAbiBorrowedBindingEvidence>,
      batch: PreparedProgramAbiStagedBatch | undefined,
    ) => PreparedProgramAbiPendingScope,
    commitScope: (pending: PreparedProgramAbiPendingScope) => SealedPreparedProgramAbiScope,
    stageBatch: (input: PreparedProgramAbiComponentBatchInput) => PreparedProgramAbiStagedBatch,
    abortScope: (
      batch: PreparedProgramAbiStagedBatch | undefined,
      pending: PreparedProgramAbiPendingScope | undefined,
    ) => void,
    baseLookup: PreparedProgramAbiScopeLookup,
  ) {
    Object.freeze(this.terminalUnitIds);
    this.#prepareScope = prepareScope;
    this.#commitScope = commitScope;
    this.#stageBatch = stageBatch;
    this.#abortScope = abortScope;
    this.#baseLookup = baseLookup;
  }

  get abi(): PreparedProgramAbiScopeLookup {
    this.#assertReadable("read the prepared ABI overlay");
    return this.#batch?.lookup ?? this.#baseLookup;
  }

  /** Observable terminal state for aggregate receipt abort decisions. */
  get publicationState(): PreparedProgramAbiScopePublicationState {
    return this.#publicationStateCell.state;
  }

  stagePreparedComponentBatch(input: PreparedProgramAbiComponentBatchInput): void {
    this.#assertOpen("stage a prepared component batch");
    if (this.#batch !== undefined) {
      throw new ProgramAbiInvariantError(
        "duplicate-session-draft",
        `prepared ABI scope ${this.scopeId} already owns one complete batch`,
      );
    }
    this.#batch = this.#stageBatch(input);
  }

  includeBinding(id: IrBindingId): void {
    this.#assertOpen("include an ABI binding");
    if (this.#bindingIds.has(id)) {
      throw new ProgramAbiInvariantError(
        "duplicate-session-draft",
        `prepared ABI scope ${this.scopeId} included binding ${id} more than once`,
      );
    }
    this.#bindingIds.add(id);
  }

  includeBorrowedBinding(id: IrBindingId, evidence: PreparedProgramAbiBorrowedBindingEvidence): void {
    this.#assertOpen("include a borrowed ABI binding");
    if (this.#bindingIds.has(id)) {
      throw new ProgramAbiInvariantError(
        "duplicate-session-draft",
        `prepared ABI scope ${this.scopeId} included binding ${id} more than once`,
      );
    }
    if (
      evidence.consumerUnitIds.length === 0 ||
      new Set(evidence.consumerUnitIds).size !== evidence.consumerUnitIds.length ||
      evidence.consumerUnitIds.some((unitId) => !this.terminalUnitIds.includes(unitId))
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-callable-provenance",
        `prepared ABI scope ${this.scopeId} borrowed binding ${id} without a unique exact component consumer set`,
      );
    }
    this.#bindingIds.add(id);
    this.#borrowedBindings.set(id, Object.freeze({ ...evidence }));
  }

  seal(): SealedPreparedProgramAbiScope {
    this.#assertOpen("seal the prepared ABI scope");
    const pending = this.#pending ?? this.prepareSeal();
    try {
      const sealed = this.#commitScope(pending);
      this.#publicationStateCell.state = "sealed";
      return sealed;
    } catch (error) {
      this.#publicationStateCell.state = "aborted";
      throw error;
    }
  }

  /** Validate this scope without publishing session or registry state. */
  prepareSeal(): PreparedProgramAbiPendingScope {
    this.#assertOpen("prepare the prepared ABI scope");
    try {
      const pending = this.#prepareScope(this.#bindingIds, this.#borrowedBindings, this.#batch);
      this.#pending = pending;
      registerPreparedProgramAbiPendingScopeTransaction(pending, {
        cell: this.#publicationStateCell,
        committedState: "sealed",
        abortedState: "aborted",
      });
      this.#publicationStateCell.state = "prepared";
      return pending;
    } catch (error) {
      this.#publicationStateCell.state = "aborted";
      try {
        this.#abortScope(this.#batch, undefined);
      } catch {
        // Preserve the primary preparation failure while closing this token.
      } finally {
        this.#pending = undefined;
        this.#batch = undefined;
      }
      throw error;
    }
  }

  abort(): void {
    if (this.#publicationStateCell.state !== "open" && this.#publicationStateCell.state !== "prepared") {
      this.#assertReadable("abort the prepared ABI scope");
    }
    this.#publicationStateCell.state = "aborted";
    let firstError: unknown;
    let hadError = false;
    try {
      this.#abortScope(this.#batch, this.#pending);
    } catch (error) {
      firstError = error;
      hadError = true;
    } finally {
      this.#pending = undefined;
      this.#batch = undefined;
    }
    if (hadError) throw firstError;
  }

  #assertOpen(action: string): void {
    if (this.#publicationStateCell.state !== "open") {
      throw new ProgramAbiInvariantError(
        "session-closed",
        `cannot ${action} after prepared ABI scope ${this.scopeId} ${this.#publicationStateCell.state}`,
      );
    }
  }

  #assertReadable(action: string): void {
    if (this.#publicationStateCell.state !== "open" && this.#publicationStateCell.state !== "prepared") {
      throw new ProgramAbiInvariantError(
        "session-closed",
        `cannot ${action} after prepared ABI scope ${this.scopeId} ${this.#publicationStateCell.state}`,
      );
    }
  }
}

const preparedProgramAbiPendingScopeTransactionHooks = new WeakMap<
  PreparedProgramAbiPendingScope,
  PreparedProgramAbiPendingScopeTransactionActions
>();

/** Resolve lifecycle actions once, before aggregate publication starts. */
export function preparedProgramAbiPendingScopeTransactionActions(
  pending: PreparedProgramAbiPendingScope,
): PreparedProgramAbiPendingScopeTransactionActions | undefined {
  return preparedProgramAbiPendingScopeTransactionHooks.get(pending);
}

/** @internal Session-owned commit primitive updates the originating scope. */
export function registerPreparedProgramAbiPendingScopeTransaction(
  pending: PreparedProgramAbiPendingScope,
  hooks: PreparedProgramAbiPendingScopeTransactionActions,
): void {
  preparedProgramAbiPendingScopeTransactionHooks.set(pending, hooks);
}

/** @internal Mark an opaque pending scope consumed by the session publisher. */
export function markPreparedProgramAbiPendingScopeCommitted(pending: PreparedProgramAbiPendingScope): void {
  const actions = preparedProgramAbiPendingScopeTransactionHooks.get(pending);
  if (actions) actions.cell.state = actions.committedState;
}

/** @internal Close an opaque pending scope after a pre-write failure. */
export function markPreparedProgramAbiPendingScopeAborted(pending: PreparedProgramAbiPendingScope): void {
  const actions = preparedProgramAbiPendingScopeTransactionHooks.get(pending);
  if (actions) actions.cell.state = actions.abortedState;
}
