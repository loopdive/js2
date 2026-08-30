// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "./identity.js";
import type { IrIntegrationReport } from "./integration-report.js";
import type { Instr, WasmFunction } from "./types.js";

/** Opaque ABI preparation receipt shared across the IR/codegen boundary. */
export interface PreparedComponentPendingScope {
  readonly kind: "prepared-program-abi-pending-scope";
  readonly scopeId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
}

/** Structural view of a codegen-owned module-callable alias descriptor. */
export interface PreparedComponentModuleCallableAliasDescriptor {
  readonly kind: "prepared-module-callable-alias-descriptor";
}

/**
 * The body side of a prepared component is intentionally represented by a
 * detached value.  `existing` is the allocator object already owned by the
 * caller; it is not mutated while this value is staged.
 *
 * `Entry` remains private to the integration implementation.  Keeping it
 * generic here prevents the publication seam from acquiring a dependency on
 * the large integration module (and, more importantly, prevents an owner from
 * using a compatibility name in place of the exact unit identity).
 */
export interface PreparedComponentDetachedPatch<Entry = unknown> {
  readonly entry: Entry;
  readonly artifactUnitId: IrUnitId;
  readonly terminalOwnerUnitId: IrUnitId;
  readonly funcIdx: number;
  readonly existing: WasmFunction;
  readonly replacement: WasmFunction;
  readonly finalBody: readonly Instr[];
}

/**
 * The input accepted by the integration-side publication sink. `scope` is
 * retained only inside this IR publication boundary so `take()` can prepare
 * an authenticated pending token; it is not exposed on the owner token.
 */
export interface PreparedComponentPublicationDraft<Entry = unknown> {
  readonly preparedComponentId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly report: IrIntegrationReport;
  readonly patches: readonly PreparedComponentDetachedPatch<Entry>[];
  /** Re-check exact allocator/identity joins immediately before owner commit. */
  readonly assertCurrent: () => void;
  /** Prepare the still-open ABI scope without publishing it. */
  readonly prepareSeal: () => PreparedComponentPendingScope;
  /** Current one-shot ABI transaction state for post-prepare abort safety. */
  readonly scopePublicationState: () => "open" | "prepared" | "sealed" | "aborted";
  /** Close the still-open ABI scope without publishing it. */
  readonly abortScope: () => void;
}

/** The explicit aggregate result's receipt.  The receipt has no `commit` method. */
export interface PendingPreparedProgramComponentReceipt {
  readonly kind: "pending-prepared-program-component";
  readonly preparedComponentId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly report: IrIntegrationReport;
  /** Validate exact currentness while the receipt is still pending. */
  readonly assertCurrent: () => void;
  /** Abort the pending or claimed scope before the owner commit consumes it. */
  readonly abort: () => void;
}

/**
 * Owner-side data obtained after all fallible owner checks have completed.
 * This is not a commit operation: the owner passes the opaque pending scope
 * to its Program-ABI session and may then call `publishBodies()` as part of
 * the final no-throw assignment sequence.
 */
export interface PreparedComponentPublicationToken<Entry = unknown> {
  readonly preparedComponentId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly pendingScope: PreparedComponentPendingScope;
  readonly publishBodies: () => void;
}

interface PreparedComponentExistingPatchSnapshot {
  readonly existing: WasmFunction;
  readonly localsObject: WasmFunction["locals"];
  readonly locals: WasmFunction["locals"];
  readonly bodyObject: WasmFunction["body"];
  readonly body: WasmFunction["body"];
}

interface ReceiptState<Entry> {
  readonly draft: PreparedComponentPublicationDraft<Entry>;
  readonly existingPatchSnapshots: readonly PreparedComponentExistingPatchSnapshot[];
  readonly publicationPatches: PreparedComponentDetachedPatch<Entry>[];
  state: "pending" | "prepared" | "claimed" | "aborted" | "published";
  pendingScope?: PreparedComponentPendingScope;
}

const receiptStates = new WeakMap<PendingPreparedProgramComponentReceipt, ReceiptState<unknown>>();

function publicationError(message: string): Error {
  // Avoid importing the integration error hierarchy here.  The receipt is an
  // intentionally tiny IR boundary and callers already translate ordinary
  // integration failures before constructing it.
  return new Error(`prepared component publication: ${message}`);
}

function assertPending(state: ReceiptState<unknown>, action: string): void {
  if (state.state !== "pending" && state.state !== "prepared") {
    throw publicationError(`cannot ${action} after receipt is ${state.state}`);
  }
}

function cloneStructuralValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneStructuralValue(entry)) as T;
  if (!value || typeof value !== "object") return value;
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) clone[key] = cloneStructuralValue(entry);
  return clone as T;
}

function sameStructuralValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameStructuralValue(entry, right[index]))
    );
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameStructuralValue(leftRecord[key], rightRecord[key]))
  );
}

function freezeReport(report: IrIntegrationReport): IrIntegrationReport {
  for (const error of report.errors) {
    Object.freeze(error.outcome);
    Object.freeze(error);
  }
  for (const evidence of report.terminalEvidence ?? []) {
    if (evidence.kind === "failed") {
      for (const error of evidence.errors ?? []) {
        Object.freeze(error.outcome);
        Object.freeze(error);
      }
      Object.freeze(evidence.errors);
    }
    Object.freeze(evidence);
  }
  for (const evidence of report.compiledArtifactEvidence ?? []) Object.freeze(evidence);
  Object.freeze(report.compiled);
  Object.freeze(report.errors);
  Object.freeze(report.compiledArtifactEvidence);
  Object.freeze(report.terminalEvidence);
  Object.freeze(report.terminalCompiledOwners);
  Object.freeze(report.syntheticCompiledArtifacts);
  Object.freeze(report.preparedCountedStringAppendReceipts);
  return Object.freeze(report);
}

function assertPatchSnapshotsCurrent(state: ReceiptState<unknown>): void {
  for (const snapshot of state.existingPatchSnapshots) {
    if (
      snapshot.existing.locals !== snapshot.localsObject ||
      snapshot.existing.body !== snapshot.bodyObject ||
      !sameStructuralValue(snapshot.existing.locals, snapshot.locals) ||
      !sameStructuralValue(snapshot.existing.body, snapshot.body)
    ) {
      throw publicationError(`allocator ${snapshot.existing.name} changed before component publication`);
    }
  }
}

function assertReceiptCurrent(state: ReceiptState<unknown>): void {
  state.draft.assertCurrent();
  assertPatchSnapshotsCurrent(state);
}

/** Create an opaque receipt for one open, fully prevalidated component scope. */
export function createPendingPreparedProgramComponentReceipt<Entry>(
  draft: PreparedComponentPublicationDraft<Entry>,
): PendingPreparedProgramComponentReceipt {
  if (draft.preparedComponentId.length === 0 || draft.terminalUnitIds.length === 0) {
    throw publicationError("receipt has no exact component identity");
  }
  const terminalUnitIds = Object.freeze([...draft.terminalUnitIds]);
  const report = freezeReport(draft.report);
  const existingPatchSnapshots = Object.freeze(
    draft.patches.map(({ existing }) =>
      Object.freeze({
        existing,
        localsObject: existing.locals,
        locals: cloneStructuralValue(existing.locals),
        bodyObject: existing.body,
        body: cloneStructuralValue(existing.body),
      }),
    ),
  );
  const patches = Object.freeze(
    draft.patches.map((patch) =>
      Object.freeze({
        ...patch,
        replacement: Object.freeze({
          ...patch.replacement,
          locals: cloneStructuralValue(patch.replacement.locals),
          body: cloneStructuralValue(patch.replacement.body),
        }),
        // The detached array must remain optimizer-owned after publication.
        // Clone it now so the no-throw commit path performs assignment only,
        // but do not freeze the instruction array itself.
        finalBody: cloneStructuralValue(patch.finalBody),
      }),
    ),
  );
  const state: ReceiptState<Entry> = {
    draft: Object.freeze({ ...draft, terminalUnitIds, report, patches }),
    existingPatchSnapshots,
    publicationPatches: [...patches],
    state: "pending",
  };
  const receipt: PendingPreparedProgramComponentReceipt = Object.freeze({
    kind: "pending-prepared-program-component" as const,
    preparedComponentId: draft.preparedComponentId,
    terminalUnitIds,
    report,
    assertCurrent: () => {
      assertPending(state as ReceiptState<unknown>, "assert currentness");
      assertReceiptCurrent(state as ReceiptState<unknown>);
    },
    abort: () => {
      if (state.state === "aborted") throw publicationError("receipt was already aborted");
      if (state.state === "published") throw publicationError("receipt was already published");
      const scopeState = state.draft.scopePublicationState();
      if (scopeState === "sealed") {
        // The ABI is already live. Diagnosing this forbidden interleaving must
        // not revoke the retained body capability and create an ABI/body split.
        throw publicationError("cannot abort after the prepared ABI scope committed");
      }
      if (scopeState === "aborted") {
        state.publicationPatches.length = 0;
        state.state = "aborted";
        return;
      }
      // A claimed receipt may still be aborted if the session's pre-write
      // commit validation rejects its pending scope.
      try {
        state.draft.abortScope();
      } finally {
        // Revocation is assignment-only and permanent even when the scope's
        // own close path reports that another participant already consumed it.
        state.publicationPatches.length = 0;
        state.state = "aborted";
      }
    },
  });
  receiptStates.set(receipt, state as ReceiptState<unknown>);
  return receipt;
}

/**
 * Claim the receipt for the owner transaction.  Claiming performs no live
 * writes and does not seal/commit the ABI scope.  It is deliberately separate
 * from `publishBodies()` so the owner can commit all scopes first.
 */
export function takePendingPreparedProgramComponentReceipt<Entry>(
  receipt: PendingPreparedProgramComponentReceipt,
): PreparedComponentPublicationToken<Entry> {
  const state = receiptStates.get(receipt);
  if (!state) throw publicationError("receipt belongs to another publication boundary");
  assertPending(state, "claim receipt");
  assertReceiptCurrent(state);
  let pendingScope = state.pendingScope;
  if (pendingScope === undefined) {
    try {
      pendingScope = state.draft.prepareSeal();
      state.pendingScope = pendingScope;
      state.state = "prepared";
    } catch (error) {
      state.state = "aborted";
      try {
        // ProgramAbiScopeTransaction already closes itself when preparation
        // rejects. The guard keeps the original failure while also closing
        // any compatible draft whose preparation callback did not do so.
        state.draft.abortScope();
      } catch {
        // Preserve the pre-write preparation failure; the receipt is terminal.
      }
      throw error;
    }
  }
  state.state = "claimed";
  return Object.freeze({
    preparedComponentId: state.draft.preparedComponentId,
    terminalUnitIds: state.draft.terminalUnitIds,
    pendingScope,
    publishBodies: () => {
      // This function is intentionally only the detached body assignment
      // phase.  Every identity/type/currentness check belongs before the
      // first owner write; no recoverable operation is allowed here.
      for (const patch of state.publicationPatches) {
        patch.existing.locals = patch.replacement.locals;
        patch.existing.body = patch.finalBody as Instr[];
      }
      // Consume the capability without a fallible post-commit check. An abort
      // clears the same queue, so a retained token can never publish afterward;
      // a replay likewise has no body assignment left to perform.
      state.publicationPatches.length = 0;
      state.state = "published";
    },
  });
}

/** Abort a receipt without exposing its internal scope handle. */
export function abortPendingPreparedProgramComponentReceipt(receipt: PendingPreparedProgramComponentReceipt): void {
  receipt.abort();
}
