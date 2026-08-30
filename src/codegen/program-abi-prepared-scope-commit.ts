// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrClassId, IrSourceId, IrUnitId, IrUnitInventory } from "../ir/identity.js";
import { PreparedProgramAbiCommitError } from "../ir/outcomes.js";
import { ProgramAbiInvariantError, type ProgramAbiDerivedUnitRecord } from "../ir/program-abi.js";
import type { TypeDef, ValType, WasmModule } from "../ir/types.js";
import {
  assertPreparedProgramAbiStagedBindingClosure,
  assertPreparedProgramAbiStagedRequestClosure,
  consumePreparedProgramAbiComponentBatch,
  preparedProgramAbiPendingScopeTransactionActions,
  preparedProgramAbiPlanningOverlayForBatch,
  rebasePreparedProgramAbiComponentBatch,
  preparedProgramAbiDraftsEqual,
  type PreparedProgramAbiBorrowedBindingEvidence,
  type PreparedProgramAbiMapWrite,
  type PreparedProgramAbiPendingScope,
  type PreparedProgramAbiPendingScopeTransactionActions,
  type PreparedProgramAbiPlanningOverlay,
  type PreparedProgramAbiStagedBatch,
  type PreparedProgramAbiTransactionHost,
} from "./program-abi-prepared-transaction.js";
import type {
  ProgramAbiDraft,
  ProgramAbiGlobalTypeContract,
  ProgramAbiSession,
  ProgramAbiSlotLocator,
  ProgramAbiTypeCell,
  SealedPreparedProgramAbiScope,
} from "./program-abi-session.js";
import {
  canonicalProgramAbiTypeDef,
  cloneProgramAbiCallableTypeContract,
  cloneProgramAbiValType,
  type ProgramAbiCallableTypeContract,
} from "./program-abi-signatures.js";

export interface PreparedProgramAbiLocatorSnapshot {
  readonly kind: ProgramAbiSlotLocator["kind"];
  readonly object: object;
  readonly hostLinkage?: string;
}

/** Internal prepared-scope record shared by the session and commit adapter. */
export interface PreparedProgramAbiScopeRecord {
  readonly scopeId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly unitIds: ReadonlySet<IrUnitId>;
  readonly classIds: ReadonlySet<IrClassId>;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly requestedBindingIds: ReadonlySet<IrBindingId>;
  readonly bindingIds: ReadonlySet<IrBindingId>;
  readonly bindingTerminalOwnerIds: ReadonlyMap<IrBindingId, IrUnitId | null>;
  readonly drafts: Map<IrBindingId, ProgramAbiDraft>;
  readonly locators: ReadonlyMap<IrBindingId, PreparedProgramAbiLocatorSnapshot>;
  readonly structuralReferences: ReadonlyMap<IrBindingId, string>;
  readonly callableTypeContracts: Map<IrBindingId, ProgramAbiCallableTypeContract>;
  readonly globalTypeContracts: Map<IrBindingId, ProgramAbiGlobalTypeContract>;
  readonly typeLayouts: Map<IrBindingId, string>;
  readonly reachableTypeLayouts: Map<number, string>;
  readonly view: SealedPreparedProgramAbiScope;
}

export interface PreparedProgramAbiPendingScopePayload {
  readonly session: ProgramAbiSession;
  readonly scopeId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly requestedBindingIds: ReadonlySet<IrBindingId>;
  readonly borrowedBindings: ReadonlyMap<IrBindingId, PreparedProgramAbiBorrowedBindingEvidence>;
  readonly batch: PreparedProgramAbiStagedBatch | undefined;
  readonly unitIds: ReadonlySet<IrUnitId>;
  readonly classIds: ReadonlySet<IrClassId>;
  readonly bindingIds: ReadonlySet<IrBindingId>;
  readonly record: PreparedProgramAbiScopeRecord;
  readonly exclusiveBindingIds: ReadonlySet<IrBindingId>;
}

export interface PreparedProgramAbiCommitHost {
  readonly session: ProgramAbiSession;
  readonly module: WasmModule;
  readonly committed: PreparedProgramAbiPlanningOverlay;
  readonly sourceOrderById: ReadonlyMap<IrSourceId, number>;
  readonly preparedScopes: Map<string, PreparedProgramAbiScopeRecord>;
  readonly preparedScopeByUnitId: Map<IrUnitId, string>;
  readonly preparedScopeByClassId: Map<IrClassId, string>;
  readonly preparedScopeIdsByBindingId: Map<IrBindingId, Set<string>>;
  readonly openPreparedScopeIds: Set<string>;
  readonly markFailed: () => void;
  readonly transactionHost: () => PreparedProgramAbiTransactionHost;
  readonly pendingPayload: (
    pending: PreparedProgramAbiPendingScope,
  ) => PreparedProgramAbiPendingScopePayload | undefined;
  readonly deletePending: (pending: PreparedProgramAbiPendingScope) => void;
  readonly assertPlanning: (action: string) => void;
  readonly assertScopeOpen: (scopeId: string, terminalUnitIds: readonly IrUnitId[]) => void;
  readonly assertDependencyRequest: (
    scopeId: string,
    terminalUnitIds: ReadonlySet<IrUnitId>,
    draft: ProgramAbiDraft,
    borrowing: PreparedProgramAbiBorrowedBindingEvidence | undefined,
    planning: PreparedProgramAbiPlanningOverlay,
  ) => void;
  readonly collectUnitIds: (terminalUnitIds: ReadonlySet<IrUnitId>) => Set<IrUnitId>;
  readonly collectClassIds: (terminalUnitIds: ReadonlySet<IrUnitId>) => Set<IrClassId>;
  readonly collectBindingClosure: (
    unitIds: ReadonlySet<IrUnitId>,
    requestedBindingIds: ReadonlySet<IrBindingId>,
    drafts: ReadonlyMap<IrBindingId, ProgramAbiDraft>,
  ) => Set<IrBindingId>;
  readonly assertCanonicalBindingId: (draft: ProgramAbiDraft) => IrSourceId | IrUnitId | IrClassId;
  readonly terminalOwnerForDraft: (
    draft: ProgramAbiDraft,
    structuralOwnerId: IrSourceId | IrUnitId | IrClassId,
  ) => IrUnitId | null;
  readonly preparedHostLinkage: (locator: ProgramAbiSlotLocator) => string | undefined;
  readonly callableTypeContractForState: (
    draft: ProgramAbiDraft,
    planning: PreparedProgramAbiPlanningOverlay,
  ) => ProgramAbiCallableTypeContract | undefined;
  readonly globalTypeContractForState: (
    draft: ProgramAbiDraft,
    planning: PreparedProgramAbiPlanningOverlay,
  ) => ProgramAbiGlobalTypeContract | undefined;
  readonly collectReachableTypeLayouts: (
    module: WasmModule,
    typeBindingIds: Iterable<IrBindingId>,
    callableContracts: ReadonlyMap<IrBindingId, ProgramAbiCallableTypeContract>,
    globalContracts: ReadonlyMap<IrBindingId, ProgramAbiGlobalTypeContract>,
    locators?: ReadonlyMap<IrBindingId, ProgramAbiSlotLocator>,
  ) => Map<number, string>;
}

const preparedProgramAbiPendingScopes = new WeakMap<
  PreparedProgramAbiPendingScope,
  PreparedProgramAbiPendingScopePayload
>();

export function registerPreparedProgramAbiPendingScope(
  pending: PreparedProgramAbiPendingScope,
  payload: PreparedProgramAbiPendingScopePayload,
): void {
  preparedProgramAbiPendingScopes.set(pending, payload);
}

export function preparedProgramAbiPendingScopePayload(
  pending: PreparedProgramAbiPendingScope,
): PreparedProgramAbiPendingScopePayload | undefined {
  return preparedProgramAbiPendingScopes.get(pending);
}

export function deletePreparedProgramAbiPendingScope(pending: PreparedProgramAbiPendingScope): void {
  preparedProgramAbiPendingScopes.delete(pending);
}

export function createPreparedProgramAbiTransactionHost(
  session: ProgramAbiSession,
  sourceOrderById: ReadonlyMap<IrSourceId, number>,
  typeCells: ReadonlySet<ProgramAbiTypeCell>,
  committed: PreparedProgramAbiPlanningOverlay,
  scopeOpen: (id: string) => boolean,
  scopeSealed: (id: string) => boolean,
  domainOrdinal: PreparedProgramAbiTransactionHost["domainOrdinal"],
  assertPlanning: (action: string) => void,
  resolveCurrentIndex: PreparedProgramAbiTransactionHost["resolveCurrentIndex"],
): PreparedProgramAbiTransactionHost {
  return {
    session,
    sourceOrderById,
    typeCells,
    committed,
    assertPlanning,
    scopeOpen,
    scopeSealed,
    domainOrdinal,
    resolveCurrentIndex,
  };
}

export function collectPreparedUnitIds(
  inventory: IrUnitInventory,
  derivedUnits: ReadonlyMap<IrUnitId, ProgramAbiDerivedUnitRecord>,
  terminalUnitIds: ReadonlySet<IrUnitId>,
  terminalOwnerForUnit: (unitId: IrUnitId) => IrUnitId | null,
): Set<IrUnitId> {
  const included = new Set<IrUnitId>();
  for (const unit of inventory.allUnits) {
    const terminalOwnerId = terminalOwnerForUnit(unit.id);
    if (terminalOwnerId !== null && terminalUnitIds.has(terminalOwnerId)) included.add(unit.id);
  }
  for (const terminalUnitId of terminalUnitIds) included.add(terminalUnitId);
  for (let changed = true; changed; ) {
    changed = false;
    for (const record of derivedUnits.values()) {
      if (
        included.has(record.id) ||
        (!included.has(record.parentId) &&
          (record.terminalOwnerId === null || !terminalUnitIds.has(record.terminalOwnerId)))
      ) {
        continue;
      }
      included.add(record.id);
      changed = true;
    }
  }
  return included;
}

export function collectPreparedClassIds(
  inventory: IrUnitInventory,
  terminalUnitIds: ReadonlySet<IrUnitId>,
  terminalOwnerForClass: (classId: IrClassId) => IrUnitId | null,
): Set<IrClassId> {
  const included = new Set<IrClassId>();
  for (const classRecord of inventory.classes) {
    const terminalOwnerId = terminalOwnerForClass(classRecord.id);
    if (terminalOwnerId !== null && terminalUnitIds.has(terminalOwnerId)) included.add(classRecord.id);
  }
  return included;
}

export function collectPreparedDerivedUnits(
  derivedUnits: ReadonlyMap<IrUnitId, ProgramAbiDerivedUnitRecord>,
  drafts: ReadonlyMap<IrBindingId, ProgramAbiDraft>,
  unitIds: ReadonlySet<IrUnitId>,
  compare: (left: ProgramAbiDraft, right: ProgramAbiDraft) => number,
): readonly ProgramAbiDerivedUnitRecord[] {
  const records: ProgramAbiDerivedUnitRecord[] = [];
  for (const record of derivedUnits.values()) if (unitIds.has(record.id)) records.push(record);
  return Object.freeze(
    records.sort((left, right) => {
      const leftDraft = [...drafts.values()].find(
        (draft) => draft.intent.kind === "callable" && draft.intent.unitId === left.id,
      );
      const rightDraft = [...drafts.values()].find(
        (draft) => draft.intent.kind === "callable" && draft.intent.unitId === right.id,
      );
      if (leftDraft && rightDraft) return compare(leftDraft, rightDraft);
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }),
  );
}

export function collectPreparedBindingClosure(
  drafts: ReadonlyMap<IrBindingId, ProgramAbiDraft>,
  unitIds: ReadonlySet<IrUnitId>,
  requestedBindingIds: ReadonlySet<IrBindingId>,
): Set<IrBindingId> {
  const included = new Set<IrBindingId>(requestedBindingIds);
  for (const draft of drafts.values()) {
    if (
      (draft.intent.kind === "callable" || (draft.intent.kind === "global" && draft.intent.origin === "source")) &&
      draft.intent.unitId &&
      unitIds.has(draft.intent.unitId)
    ) {
      included.add(draft.id);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...included]) {
      const draft = drafts.get(id);
      if (!draft) continue;
      const target = draft.slotPolicy === "alias" ? draft.aliasOf : undefined;
      if (target !== undefined && !included.has(target)) {
        included.add(target);
        changed = true;
      }
    }
    for (const draft of drafts.values()) {
      const pointsIntoScope = draft.slotPolicy === "alias" && included.has(draft.aliasOf);
      if (pointsIntoScope && !included.has(draft.id)) {
        included.add(draft.id);
        changed = true;
      }
    }
  }
  return included;
}

function collectProgramAbiTypeReferences(type: TypeDef, references: Set<number>): void {
  const addValue = (value: ValType): void => {
    if (value.kind === "ref" || value.kind === "ref_null") references.add(value.typeIdx);
  };
  switch (type.kind) {
    case "func":
      type.params.forEach(addValue);
      type.results.forEach(addValue);
      return;
    case "struct":
      type.fields.forEach((field) => addValue(field.type));
      if (type.superTypeIdx !== undefined && type.superTypeIdx >= 0) references.add(type.superTypeIdx);
      return;
    case "array":
      addValue(type.element);
      return;
    case "rec":
      type.types.forEach((nested) => collectProgramAbiTypeReferences(nested, references));
      return;
    case "sub":
      if (type.superType !== null) references.add(type.superType);
      collectProgramAbiTypeReferences(type.type, references);
      return;
  }
}

export function collectPreparedReachableTypeLayouts(
  module: WasmModule,
  typeBindingIds: Iterable<IrBindingId>,
  callableContracts: ReadonlyMap<IrBindingId, ProgramAbiCallableTypeContract>,
  globalContracts: ReadonlyMap<IrBindingId, ProgramAbiGlobalTypeContract>,
  locators: ReadonlyMap<IrBindingId, ProgramAbiSlotLocator>,
): Map<number, string> {
  const roots = new Set<number>();
  const addValue = (value: ValType): void => {
    if (value.kind === "ref" || value.kind === "ref_null") roots.add(value.typeIdx);
  };
  for (const id of typeBindingIds) {
    const locator = locators.get(id);
    if (locator?.kind !== "type-cell" || locator.cell.current === null) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `prepared type/class layout ${id} has no live cell while pinning its type graph`,
      );
    }
    const index = module.types.indexOf(locator.cell.current);
    if (index < 0 || module.types.lastIndexOf(locator.cell.current) !== index) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `prepared type/class layout ${id} is not uniquely present while pinning its type graph`,
      );
    }
    roots.add(index);
  }
  for (const contract of callableContracts.values()) {
    contract.params.forEach(addValue);
    contract.results.forEach(addValue);
  }
  for (const contract of globalContracts.values()) addValue(contract.type);

  const layouts = new Map<number, string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const index = pending.pop()!;
    if (layouts.has(index)) continue;
    if (!Number.isSafeInteger(index) || index < 0 || index >= module.types.length) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `prepared type graph references index ${index} outside the module type layout`,
      );
    }
    const type = module.types[index]!;
    layouts.set(index, canonicalProgramAbiTypeDef(type));
    const references = new Set<number>();
    collectProgramAbiTypeReferences(type, references);
    for (const reference of references) if (!layouts.has(reference)) pending.push(reference);
  }
  return layouts;
}

export function preparedProgramAbiHostLinkage(locator: ProgramAbiSlotLocator): string | undefined {
  if (locator.kind === "import-function") {
    if (locator.value.desc.kind !== "func") {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        "prepared imported callable locator no longer has a function descriptor",
      );
    }
    return JSON.stringify({
      kind: "func",
      module: locator.value.module,
      name: locator.value.name,
    });
  }
  if (locator.kind === "import-global") {
    if (locator.value.desc.kind !== "global") {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        "prepared imported global locator no longer has a global descriptor",
      );
    }
    return JSON.stringify({
      kind: "global",
      module: locator.value.module,
      name: locator.value.name,
    });
  }
  return undefined;
}

export function preparedProgramAbiScopeForTypeCell(
  preparedScopes: ReadonlyMap<string, PreparedProgramAbiScopeRecord>,
  cell: ProgramAbiTypeCell,
): string | undefined {
  for (const scope of preparedScopes.values()) {
    for (const locator of scope.locators.values()) {
      if (locator.kind === "type-cell" && locator.object === cell) return scope.scopeId;
    }
  }
  return undefined;
}

export function preparedProgramAbiScopeForBinding(
  preparedScopeIdsByBindingId: ReadonlyMap<IrBindingId, ReadonlySet<string>>,
  id: IrBindingId,
): string | undefined {
  return preparedScopeIdsByBindingId.get(id)?.values().next().value;
}

function setsIntersect<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const value of smaller) if (larger.has(value)) return true;
  return false;
}

function preparedWriteValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function retargetPreparedBatchSessionWrites(
  host: PreparedProgramAbiCommitHost,
  batch: PreparedProgramAbiStagedBatch,
  composite: PreparedProgramAbiPlanningOverlay,
): PreparedProgramAbiStagedBatch {
  const targetMap = new Map<Map<unknown, unknown>, Map<unknown, unknown>>([
    [composite.drafts as Map<unknown, unknown>, host.committed.drafts as Map<unknown, unknown>],
    [composite.draftOrderOwners as Map<unknown, unknown>, host.committed.draftOrderOwners as Map<unknown, unknown>],
    [composite.locators as Map<unknown, unknown>, host.committed.locators as Map<unknown, unknown>],
    [composite.locatorOwners as Map<unknown, unknown>, host.committed.locatorOwners as Map<unknown, unknown>],
    [
      composite.structuralReferenceKeys as Map<unknown, unknown>,
      host.committed.structuralReferenceKeys as Map<unknown, unknown>,
    ],
    [
      composite.callableTypeContracts as Map<unknown, unknown>,
      host.committed.callableTypeContracts as Map<unknown, unknown>,
    ],
    [
      composite.globalTypeContracts as Map<unknown, unknown>,
      host.committed.globalTypeContracts as Map<unknown, unknown>,
    ],
  ]);
  const sessionWrites = Object.freeze(
    batch.sessionWrites.map((write) =>
      Object.freeze({ ...write, target: targetMap.get(write.target) ?? write.target }),
    ),
  );
  return Object.freeze({ ...batch, sessionWrites });
}

function mergePreparedWriteSet(
  writes: readonly PreparedProgramAbiMapWrite[],
  domain: string,
): readonly PreparedProgramAbiMapWrite[] {
  const byTarget = new Map<Map<unknown, unknown>, Map<unknown, PreparedProgramAbiMapWrite>>();
  const merged: PreparedProgramAbiMapWrite[] = [];
  for (const write of writes) {
    const byKey = byTarget.get(write.target) ?? new Map<unknown, PreparedProgramAbiMapWrite>();
    const previous = byKey.get(write.key);
    const occupied = write.target.get(write.key);
    if (
      (previous && !preparedWriteValuesEqual(previous.value, write.value)) ||
      (previous === undefined && write.target.has(write.key) && !preparedWriteValuesEqual(occupied, write.value))
    ) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `prepared ${domain} write overlaps a changed key before commit`,
      );
    }
    if (previous || (write.target.has(write.key) && preparedWriteValuesEqual(occupied, write.value))) {
      byTarget.set(write.target, byKey);
      continue;
    }
    byKey.set(write.key, write);
    byTarget.set(write.target, byKey);
    merged.push(write);
  }
  return Object.freeze(merged);
}

function validatePendingPreparedScope(
  host: PreparedProgramAbiCommitHost,
  payload: PreparedProgramAbiPendingScopePayload,
  batch: PreparedProgramAbiStagedBatch | undefined,
): void {
  const planning = preparedProgramAbiPlanningOverlayForBatch(batch, host.committed);
  const terminalUnitIds = new Set(payload.terminalUnitIds);
  for (const id of payload.requestedBindingIds) {
    const draft = planning.drafts.get(id);
    if (!draft) {
      throw new ProgramAbiInvariantError("unknown-binding", `prepared ABI scope ${payload.scopeId} lost binding ${id}`);
    }
    host.assertDependencyRequest(payload.scopeId, terminalUnitIds, draft, payload.borrowedBindings.get(id), planning);
  }
  assertPreparedProgramAbiStagedRequestClosure(batch, payload.scopeId, payload.requestedBindingIds, planning);
  const unitIds = host.collectUnitIds(terminalUnitIds);
  if (unitIds.size !== payload.unitIds.size || [...payload.unitIds].some((id) => !unitIds.has(id))) {
    throw new ProgramAbiInvariantError(
      "session-draft-mismatch",
      `prepared ABI scope ${payload.scopeId} unit closure drifted`,
    );
  }
  const classIds = host.collectClassIds(terminalUnitIds);
  if (classIds.size !== payload.classIds.size || [...payload.classIds].some((id) => !classIds.has(id))) {
    throw new ProgramAbiInvariantError(
      "session-draft-mismatch",
      `prepared ABI scope ${payload.scopeId} class closure drifted`,
    );
  }
  const bindingIds = host.collectBindingClosure(payload.unitIds, payload.requestedBindingIds, planning.drafts);
  if (bindingIds.size !== payload.bindingIds.size || [...payload.bindingIds].some((id) => !bindingIds.has(id))) {
    throw new ProgramAbiInvariantError(
      "session-draft-mismatch",
      `prepared ABI scope ${payload.scopeId} binding closure drifted`,
    );
  }
  assertPreparedProgramAbiStagedBindingClosure(batch, payload.scopeId, bindingIds, planning);
  for (const id of payload.bindingIds) {
    const draft = planning.drafts.get(id);
    if (!draft) throw new ProgramAbiInvariantError("unknown-binding", `prepared ABI scope lost binding ${id}`);
    const ownerId = host.assertCanonicalBindingId(draft);
    const ownerTerminalId = host.terminalOwnerForDraft(draft, ownerId);
    if (ownerTerminalId !== payload.record.bindingTerminalOwnerIds.get(id)) {
      throw new ProgramAbiInvariantError("invalid-callable-provenance", `prepared ABI binding ${id} changed owner`);
    }
    const expectedLocator = payload.record.locators.get(id);
    const actualLocator = planning.locators.get(id);
    if (
      (expectedLocator === undefined) !== (actualLocator === undefined) ||
      (expectedLocator !== undefined &&
        (actualLocator === undefined ||
          expectedLocator.kind !== actualLocator.kind ||
          expectedLocator.object !== locatorObjectForPlanning(actualLocator) ||
          expectedLocator.hostLinkage !== host.preparedHostLinkage(actualLocator)))
    ) {
      throw new ProgramAbiInvariantError("locator-remap-mismatch", `prepared ABI locator ${id} changed before commit`);
    }
  }
}

function refreshPendingPreparedScopeRecord(
  host: PreparedProgramAbiCommitHost,
  payload: PreparedProgramAbiPendingScopePayload,
  batch: PreparedProgramAbiStagedBatch | undefined,
): void {
  const planning = preparedProgramAbiPlanningOverlayForBatch(batch, host.committed);
  for (const id of payload.record.bindingIds) {
    const draft = planning.drafts.get(id);
    if (!draft) throw new ProgramAbiInvariantError("unknown-binding", `prepared ABI scope lost binding ${id}`);
    payload.record.drafts.set(id, clonePreparedPlanningDraft(draft));
    if (draft.intent.kind === "callable") {
      const contract = host.callableTypeContractForState(draft, planning);
      if (!contract) throw new ProgramAbiInvariantError("type-remap-mismatch", `prepared callable ${id} lost contract`);
      payload.record.callableTypeContracts.set(id, cloneProgramAbiCallableTypeContract(contract));
    } else if (draft.intent.kind === "global") {
      const contract = host.globalTypeContractForState(draft, planning);
      if (!contract) throw new ProgramAbiInvariantError("type-remap-mismatch", `prepared global ${id} lost contract`);
      payload.record.globalTypeContracts.set(
        id,
        Object.freeze({ type: cloneProgramAbiValType(contract.type), mutable: contract.mutable }),
      );
    }
    const locator = planning.locators.get(id);
    if (locator?.kind === "type-cell" && locator.cell.current !== null && payload.record.typeLayouts.has(id)) {
      payload.record.typeLayouts.set(id, canonicalProgramAbiTypeDef(locator.cell.current));
    }
  }
  const reachable = host.collectReachableTypeLayouts(
    host.module,
    payload.record.typeLayouts.keys(),
    payload.record.callableTypeContracts,
    payload.record.globalTypeContracts,
    planning.locators,
  );
  payload.record.reachableTypeLayouts.clear();
  for (const [index, layout] of reachable) payload.record.reachableTypeLayouts.set(index, layout);
}

function locatorObjectForPlanning(locator: ProgramAbiSlotLocator): object {
  return locator.kind === "type-cell" ? locator.cell : locator.value;
}

function clonePreparedPlanningDraft(draft: ProgramAbiDraft): ProgramAbiDraft {
  const intent =
    draft.intent.kind === "callable"
      ? {
          ...draft.intent,
          signature: {
            params: Object.freeze([...draft.intent.signature.params]),
            results: Object.freeze([...draft.intent.signature.results]),
          },
        }
      : { ...draft.intent };
  return Object.freeze({
    ...draft,
    structuralOrder: Object.freeze({ ...draft.structuralOrder }),
    intent: Object.freeze(intent),
  }) as ProgramAbiDraft;
}

interface PreparedScopeEntry {
  readonly pending: PreparedProgramAbiPendingScope;
  readonly payload: PreparedProgramAbiPendingScopePayload;
}

interface PreparedScopeBatchEntry extends PreparedScopeEntry {
  readonly batch: PreparedProgramAbiStagedBatch | undefined;
}

interface PreparedScopeLifecycleEntry extends PreparedScopeBatchEntry {
  readonly lifecycle: PreparedProgramAbiPendingScopeTransactionActions;
}

function commitError(message: string): ProgramAbiInvariantError {
  return new ProgramAbiInvariantError("context-session-mismatch", message);
}

function authenticatePendingScopes(
  host: PreparedProgramAbiCommitHost,
  pendingScopes: readonly PreparedProgramAbiPendingScope[],
): { readonly entries: readonly PreparedScopeEntry[]; readonly failed: boolean; readonly error?: unknown } {
  const entries: PreparedScopeEntry[] = [];
  const seenTokens = new Set<PreparedProgramAbiPendingScope>();
  const seenScopeIds = new Set<string>();
  let firstError: unknown;
  let hadError = false;
  const remember = (error: unknown): void => {
    if (!hadError) firstError = error;
    hadError = true;
  };
  for (const pending of pendingScopes) {
    let payload: PreparedProgramAbiPendingScopePayload | undefined;
    let isOpaquePending = false;
    try {
      payload = host.pendingPayload(pending);
      isOpaquePending =
        typeof pending === "object" && pending !== null && pending.kind === "prepared-program-abi-pending-scope";
    } catch (error) {
      remember(error);
      continue;
    }
    if (!payload || payload.session !== host.session || !isOpaquePending) {
      remember(commitError("prepared ABI commit received a forged or foreign pending scope"));
      continue;
    }
    if (seenTokens.has(pending) || seenScopeIds.has(payload.scopeId)) {
      remember(
        new ProgramAbiInvariantError("duplicate-session-draft", `prepared ABI commit repeats scope ${payload.scopeId}`),
      );
      continue;
    }
    seenTokens.add(pending);
    seenScopeIds.add(payload.scopeId);
    const entry = { pending, payload };
    entries.push(entry);
    try {
      host.assertScopeOpen(payload.scopeId, payload.terminalUnitIds);
    } catch (error) {
      remember(error);
    }
  }
  return { entries, failed: hadError, error: firstError };
}

function abortRecognizedPendingScopes(
  host: PreparedProgramAbiCommitHost,
  entries: readonly PreparedScopeLifecycleEntry[],
  consumeBatches: boolean,
): void {
  for (const entry of entries) {
    if (
      consumeBatches &&
      entry.payload.batch &&
      entry.payload.batch.parts.some((part) => part.lifecycle.state.get("state") === "claimed")
    ) {
      try {
        consumePreparedProgramAbiComponentBatch(entry.payload.batch, host.session);
      } catch {
        // Preserve the original pre-write validation error.
      }
    }
    host.openPreparedScopeIds.delete(entry.payload.scopeId);
    entry.lifecycle.cell.state = entry.lifecycle.abortedState;
    host.deletePending(entry.pending);
  }
}

/** Atomically publish authenticated pending ABI scopes through a session adapter. */
export function commitPreparedProgramAbiScopes(
  host: PreparedProgramAbiCommitHost,
  pendingScopes: readonly PreparedProgramAbiPendingScope[],
): readonly SealedPreparedProgramAbiScope[] {
  host.assertPlanning("commit prepared ABI scopes");
  if (pendingScopes.length === 0) {
    throw new ProgramAbiInvariantError("duplicate-session-draft", "prepared ABI commit requires at least one scope");
  }
  let recognized: readonly PreparedScopeEntry[] = [];
  let lifecycleEntries: readonly PreparedScopeLifecycleEntry[] = [];
  let liveWritesStarted = false;
  let commitScopeIds = "";
  try {
    const authenticated = authenticatePendingScopes(host, pendingScopes);
    recognized = authenticated.entries;
    if (authenticated.failed) throw authenticated.error;
    const ordered = [...recognized].sort((left, right) => left.payload.scopeId.localeCompare(right.payload.scopeId));
    const committedOverlay: PreparedProgramAbiPlanningOverlay = {
      drafts: new Map(host.committed.drafts),
      draftOrderOwners: new Map(host.committed.draftOrderOwners),
      locators: new Map(host.committed.locators),
      locatorOwners: new Map(host.committed.locatorOwners),
      structuralReferenceKeys: new Map(host.committed.structuralReferenceKeys),
      callableTypeContracts: new Map(host.committed.callableTypeContracts),
      globalTypeContracts: new Map(host.committed.globalTypeContracts),
    };
    const compositeHost: PreparedProgramAbiTransactionHost = {
      ...host.transactionHost(),
      committed: committedOverlay,
    };
    const rebased: PreparedScopeBatchEntry[] = [];
    for (const entry of ordered) {
      const batch = entry.payload.batch
        ? rebasePreparedProgramAbiComponentBatch(compositeHost, entry.payload.batch)
        : undefined;
      if (batch) for (const write of batch.sessionWrites) write.target.set(write.key, write.value);
      rebased.push({
        ...entry,
        batch: batch ? retargetPreparedBatchSessionWrites(host, batch, committedOverlay) : undefined,
      });
    }
    for (const entry of rebased) {
      validatePendingPreparedScope(host, entry.payload, entry.batch);
      for (const unitId of entry.payload.unitIds) {
        const owner = host.preparedScopeByUnitId.get(unitId);
        if (owner !== undefined && owner !== entry.payload.scopeId) {
          throw new ProgramAbiInvariantError(
            "duplicate-session-draft",
            `prepared ABI unit ${unitId} is already sealed by scope ${owner}`,
          );
        }
      }
      for (const classId of entry.payload.classIds) {
        const owner = host.preparedScopeByClassId.get(classId);
        if (owner !== undefined && owner !== entry.payload.scopeId) {
          throw new ProgramAbiInvariantError(
            "duplicate-session-draft",
            `prepared ABI class ${classId} is already sealed by scope ${owner}`,
          );
        }
      }
    }
    for (let leftIndex = 0; leftIndex < rebased.length; leftIndex++) {
      const left = rebased[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < rebased.length; rightIndex++) {
        const right = rebased[rightIndex]!;
        if (setsIntersect(left.payload.unitIds, right.payload.unitIds)) {
          throw new ProgramAbiInvariantError(
            "duplicate-session-draft",
            `prepared ABI scopes ${left.payload.scopeId} and ${right.payload.scopeId} overlap executable units`,
          );
        }
        if (setsIntersect(left.payload.classIds, right.payload.classIds)) {
          throw new ProgramAbiInvariantError(
            "duplicate-session-draft",
            `prepared ABI scopes ${left.payload.scopeId} and ${right.payload.scopeId} overlap class ownership`,
          );
        }
        for (const bindingId of left.payload.bindingIds) {
          if (!right.payload.bindingIds.has(bindingId)) continue;
          const leftOwner = left.payload.record.bindingTerminalOwnerIds.get(bindingId) ?? null;
          const rightOwner = right.payload.record.bindingTerminalOwnerIds.get(bindingId) ?? null;
          if (
            left.payload.exclusiveBindingIds.has(bindingId) ||
            right.payload.exclusiveBindingIds.has(bindingId) ||
            leftOwner !== null ||
            rightOwner !== null
          ) {
            throw new ProgramAbiInvariantError(
              "duplicate-session-draft",
              `prepared ABI scopes ${left.payload.scopeId} and ${right.payload.scopeId} overlap owned binding ${bindingId}`,
            );
          }
          const leftDraft = left.payload.record.drafts.get(bindingId);
          const rightDraft = right.payload.record.drafts.get(bindingId);
          if (!leftDraft || !rightDraft || !preparedProgramAbiDraftsEqual(leftDraft, rightDraft)) {
            throw new ProgramAbiInvariantError(
              "session-draft-mismatch",
              `prepared ABI scopes ${left.payload.scopeId} and ${right.payload.scopeId} disagree on shared dependency ${bindingId}`,
            );
          }
          const leftLocator = left.payload.record.locators.get(bindingId);
          const rightLocator = right.payload.record.locators.get(bindingId);
          if (
            leftLocator?.kind !== rightLocator?.kind ||
            leftLocator?.object !== rightLocator?.object ||
            leftLocator?.hostLinkage !== rightLocator?.hostLinkage
          ) {
            throw new ProgramAbiInvariantError(
              "locator-remap-mismatch",
              `prepared ABI scopes ${left.payload.scopeId} and ${right.payload.scopeId} disagree on shared locator ${bindingId}`,
            );
          }
        }
      }
    }
    const allSessionWrites = mergePreparedWriteSet(
      rebased.flatMap((entry) => entry.batch?.sessionWrites ?? []),
      "session",
    );
    const allRegistryWrites = mergePreparedWriteSet(
      rebased.flatMap((entry) => entry.batch?.registryWrites ?? []),
      "registry",
    );
    for (const entry of rebased) refreshPendingPreparedScopeRecord(host, entry.payload, entry.batch);

    const reverseScopeIdsByBinding = new Map<IrBindingId, Set<string>>();
    for (const entry of rebased) {
      for (const bindingId of entry.payload.record.bindingIds) {
        const scopeIds =
          reverseScopeIdsByBinding.get(bindingId) ?? new Set(host.preparedScopeIdsByBindingId.get(bindingId) ?? []);
        scopeIds.add(entry.payload.scopeId);
        reverseScopeIdsByBinding.set(bindingId, scopeIds);
      }
    }
    const reverseWrites = [...reverseScopeIdsByBinding].map(([bindingId, scopeIds]) => ({ bindingId, scopeIds }));
    const preparedScopeWrites = rebased.map((entry) => ({
      target: host.preparedScopes,
      key: entry.payload.scopeId,
      value: entry.payload.record,
    }));
    const preparedUnitWrites = rebased.flatMap((entry) =>
      [...entry.payload.unitIds].map((unitId) => ({
        target: host.preparedScopeByUnitId,
        key: unitId,
        value: entry.payload.scopeId,
      })),
    );
    const preparedClassWrites = rebased.flatMap((entry) =>
      [...entry.payload.classIds].map((classId) => ({
        target: host.preparedScopeByClassId,
        key: classId,
        value: entry.payload.scopeId,
      })),
    );
    const callerViews = Object.freeze(recognized.map((entry) => entry.payload.record.view));
    commitScopeIds = recognized.map((entry) => entry.payload.scopeId).join(",");
    lifecycleEntries = rebased.map((entry) => {
      const actions = preparedProgramAbiPendingScopeTransactionActions(entry.pending);
      if (!actions)
        throw new ProgramAbiInvariantError("context-session-mismatch", "prepared ABI pending scope has no lifecycle");
      return { ...entry, lifecycle: actions };
    });

    // Consume descriptor rows and delete pending tokens before the first live
    // ABI Map write. Every operation needed after this point is precomputed.
    for (const entry of rebased) if (entry.batch) consumePreparedProgramAbiComponentBatch(entry.batch, host.session);
    for (const entry of lifecycleEntries) host.deletePending(entry.pending);

    liveWritesStarted = true;
    for (const write of allSessionWrites) write.target.set(write.key, write.value);
    for (const write of allRegistryWrites) write.target.set(write.key, write.value);
    for (const write of preparedScopeWrites) write.target.set(write.key, write.value);
    for (const write of preparedUnitWrites) write.target.set(write.key, write.value);
    for (const write of preparedClassWrites) write.target.set(write.key, write.value);
    for (const { bindingId, scopeIds } of reverseWrites) host.preparedScopeIdsByBindingId.set(bindingId, scopeIds);
    for (const entry of lifecycleEntries) {
      host.openPreparedScopeIds.delete(entry.payload.scopeId);
      entry.lifecycle.cell.state = entry.lifecycle.committedState;
    }
    return callerViews;
  } catch (error) {
    if (liveWritesStarted) {
      host.markFailed();
      for (const entry of lifecycleEntries) {
        host.openPreparedScopeIds.delete(entry.payload.scopeId);
        entry.lifecycle.cell.state = entry.lifecycle.abortedState;
      }
      throw new PreparedProgramAbiCommitError(commitScopeIds, error);
    }
    const actions = recognized.map((entry) => {
      const lifecycle = preparedProgramAbiPendingScopeTransactionActions(entry.pending);
      return {
        ...entry,
        batch: entry.payload.batch,
        lifecycle: lifecycle ?? {
          cell: { state: "prepared" },
          committedState: "sealed",
          abortedState: "aborted",
        },
      };
    });
    abortRecognizedPendingScopes(host, actions, true);
    throw error;
  }
}

/** Close one pending scope even when descriptor validation reports a stale row. */
export function abortPreparedProgramAbiScope(
  host: PreparedProgramAbiCommitHost,
  pending: PreparedProgramAbiPendingScope,
): void {
  const payload = host.pendingPayload(pending);
  if (!payload || payload.session !== host.session) {
    throw new ProgramAbiInvariantError("session-closed", "prepared ABI pending scope is no longer open");
  }
  const actions = preparedProgramAbiPendingScopeTransactionActions(pending);
  let firstError: unknown;
  let hadError = false;
  try {
    if (payload.batch) consumePreparedProgramAbiComponentBatch(payload.batch, host.session);
  } catch (error) {
    firstError = error;
    hadError = true;
  } finally {
    host.openPreparedScopeIds.delete(payload.scopeId);
    try {
      if (actions) actions.cell.state = actions.abortedState;
    } finally {
      host.deletePending(pending);
    }
  }
  if (hadError) throw firstError;
}
