// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irClassTypeRef, irTypeBindingKey } from "../ir/abi-bindings.js";
import type { IrBindingId, IrClassId, IrSourceId, IrUnitId } from "../ir/identity.js";
import { ProgramAbiInvariantError, type ProgramAbiPlanEntry, type ProgramAbiSlotSpace } from "../ir/program-abi.js";
import type { StructTypeDef, TypeDef, ValType, WasmModule } from "../ir/types.js";
import {
  consumePreparedCallableImportDescriptor,
  prepareCallableImportDescriptorForScope,
  type PreparedCallableImportDescriptor,
} from "./program-abi-import-planning.js";
import {
  consumePreparedCallableProviderDescriptor,
  prepareCallableProviderDescriptorForScope,
  type PreparedCallableProviderDescriptor,
} from "./program-abi-provider-planning.js";
import {
  consumePreparedExportAliasDescriptor,
  prepareExportAliasDescriptorForScope,
  type PreparedExportAliasDescriptor,
} from "./program-abi-export-planning.js";
import {
  consumePreparedModuleCallableAliasDescriptor,
  prepareModuleCallableAliasDescriptorForScope,
  type PreparedModuleCallableAliasDescriptor,
} from "./program-abi-module-callable-alias-planning.js";
import {
  createPreparedProgramAbiScopeLookup,
  type PreparedProgramAbiScopeLookup,
} from "./program-abi-prepared-scope-lookup.js";
import { programAbiIntentsEqual } from "./program-abi-intent-equality.js";
import {
  canonicalProgramAbiCallableTypeContract,
  canonicalProgramAbiTypeDef,
  canonicalProgramAbiValType,
  cloneProgramAbiCallableTypeContract,
  cloneProgramAbiValType,
  programAbiCallableSignaturesEqual,
  type ProgramAbiCallableTypeContract,
} from "./program-abi-signatures.js";
import type {
  ProgramAbiDraft,
  ProgramAbiDraftOrder,
  ProgramAbiGlobalTypeContract,
  ProgramAbiSession,
  ProgramAbiSlotLocator,
  ProgramAbiTypeCell,
} from "./program-abi-session.js";

export {
  markPreparedProgramAbiPendingScopeAborted,
  markPreparedProgramAbiPendingScopeCommitted,
  PreparedProgramAbiScopeTransaction,
  preparedProgramAbiPendingScopeTransactionActions,
  registerPreparedProgramAbiPendingScopeTransaction,
  type PreparedProgramAbiPendingScopeTransactionActions,
  type PreparedProgramAbiScopeLookup,
} from "./program-abi-prepared-scope-lookup.js";

/** One prevalidated, side-effect-free binding contribution to a prepared batch. */
export interface PreparedProgramAbiProvisionalBinding {
  readonly draft: ProgramAbiDraft;
  readonly structuralReferenceKey?: string;
  readonly locator?: ProgramAbiSlotLocator;
  readonly callableTypeContract?: ProgramAbiCallableTypeContract;
  readonly globalTypeContract?: { readonly type: ValType; readonly mutable: boolean };
}

/** A registry-owned lifecycle cell. It is never exposed by a descriptor token. */
export interface PreparedProgramAbiDescriptorLifecycle {
  readonly state: Map<"state" | "scopeId", string>;
}

/** A commit write built by a registry before any Program-ABI publication starts. */
export interface PreparedProgramAbiMapWrite {
  readonly target: Map<unknown, unknown>;
  readonly key: unknown;
  readonly value: unknown;
}

/** Authenticated registry contribution consumed by one exact prepared scope. */
export interface PreparedProgramAbiDescriptorPart {
  readonly kind:
    | "callable-imports"
    | "callable-providers"
    | "class-layouts"
    | "export-aliases"
    | "module-callable-aliases";
  readonly session: ProgramAbiSession;
  readonly descriptor: object;
  readonly lifecycle: PreparedProgramAbiDescriptorLifecycle;
  readonly bindings: readonly PreparedProgramAbiProvisionalBinding[];
  readonly requestedStructuralReferenceKeys: readonly string[];
  readonly closureStructuralReferenceKeys: readonly string[];
  readonly requiredImportDescriptor?: PreparedCallableImportDescriptor;
  readonly requiredImportBindingIds?: readonly IrBindingId[];
  readonly registryWrites: readonly PreparedProgramAbiMapWrite[];
  /** Binding identities that may not overlap another prepared scope. */
  readonly exclusiveBindingIds?: readonly IrBindingId[];
  /** Rebuild provisional bindings against a fresh committed overlay. */
  readonly rebaseBindings?: () => readonly PreparedProgramAbiProvisionalBinding[];
  readonly projectBindings?: (
    resolveTargetId: (allocator: object) => IrBindingId | undefined,
    getDraft: (id: IrBindingId) => ProgramAbiDraft | undefined,
  ) => readonly PreparedProgramAbiProvisionalBinding[];
  readonly assertBindingClosure?: (
    bindingIds: ReadonlySet<IrBindingId>,
    resolveTargetId: (allocator: object) => IrBindingId | undefined,
  ) => void;
  readonly assertCurrent: () => void;
}

export interface PreparedProgramAbiComponentBatchInput {
  readonly scopeId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly requestedStructuralReferenceKeys: readonly string[];
  readonly callableImports?: PreparedCallableImportDescriptor;
  readonly callableProviders?: PreparedCallableProviderDescriptor;
  readonly classLayouts?: PreparedClassLayoutDescriptor;
  readonly exportAliases?: PreparedExportAliasDescriptor;
  readonly moduleCallableAliases?: PreparedModuleCallableAliasDescriptor;
}

export interface PreparedProgramAbiPlanningOverlay {
  readonly drafts: Map<IrBindingId, ProgramAbiDraft>;
  readonly draftOrderOwners: Map<string, IrBindingId>;
  readonly locators: Map<IrBindingId, ProgramAbiSlotLocator>;
  readonly locatorOwners: Map<object, IrBindingId>;
  readonly structuralReferenceKeys: Map<IrBindingId, string>;
  readonly callableTypeContracts: Map<IrBindingId, ProgramAbiCallableTypeContract>;
  readonly globalTypeContracts: Map<IrBindingId, ProgramAbiGlobalTypeContract>;
}

export interface PreparedProgramAbiStagedBatch {
  readonly scopeId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly requestedStructuralReferenceKeys: readonly string[];
  readonly parts: readonly PreparedProgramAbiDescriptorPart[];
  readonly overlay: PreparedProgramAbiPlanningOverlay;
  readonly sessionWrites: readonly PreparedProgramAbiMapWrite[];
  readonly registryWrites: readonly PreparedProgramAbiMapWrite[];
  readonly lookup: PreparedProgramAbiScopeLookup;
}

/** Opaque, side-effect-free scope preparation token. */
export interface PreparedProgramAbiPendingScope {
  readonly kind: "prepared-program-abi-pending-scope";
  readonly scopeId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
}

export type PreparedProgramAbiBorrowedBindingEvidence =
  | {
      readonly kind: "nested-accessor-class-layout";
      readonly consumerUnitIds: readonly IrUnitId[];
    }
  | {
      readonly kind: "class-setter-writeback-global";
      readonly consumerUnitIds: readonly IrUnitId[];
      readonly dynamicCarrierBindingId: IrBindingId;
    }
  | {
      readonly kind: "class-setter-writeback-tdz-global";
      readonly consumerUnitIds: readonly IrUnitId[];
      readonly valueGlobalBindingId: IrBindingId;
    };

export interface PreparedProgramAbiTransactionHost {
  readonly session: ProgramAbiSession;
  readonly sourceOrderById: ReadonlyMap<IrSourceId, number>;
  readonly typeCells: ReadonlySet<ProgramAbiTypeCell>;
  readonly committed: PreparedProgramAbiPlanningOverlay;
  readonly assertPlanning: (action: string) => void;
  readonly scopeOpen: (scopeId: string) => boolean;
  readonly scopeSealed: (scopeId: string) => boolean;
  readonly domainOrdinal: (kind: ProgramAbiDraft["intent"]["kind"]) => number;
  readonly resolveCurrentIndex: (
    id: IrBindingId,
    expectedSpace: ProgramAbiSlotSpace,
    structuralReferenceKey: string,
    locator: ProgramAbiSlotLocator,
  ) => number;
}

export interface PreparedClassLayoutObservation {
  readonly classId: IrClassId;
  readonly displayName: string;
  readonly cell: ProgramAbiTypeCell;
}

export interface PreparedClassLayoutHost {
  readonly session: ProgramAbiSession;
  readonly module: WasmModule;
  readonly planningSealed: () => boolean;
  readonly observation: (classId: IrClassId) => PreparedClassLayoutObservation | undefined;
  readonly isPreparable: (type: StructTypeDef) => boolean;
  readonly roleOrdinal: number;
}

interface PreparedClassLayoutSessionSnapshot {
  readonly draft: ProgramAbiDraft | undefined;
  readonly structuralOrderOwner: IrBindingId | undefined;
  readonly structuralReferenceBindingIds: readonly IrBindingId[];
  readonly locatorOwner: IrBindingId | undefined;
  readonly hasExactLocator: boolean;
}

interface PreparedClassLayoutEntry {
  readonly classRecord: ProgramAbiSession["inventory"]["classes"][number];
  readonly observation: PreparedClassLayoutObservation;
  readonly type: StructTypeDef;
  readonly layoutKey: string;
  readonly structuralReferenceKey: string;
  readonly draft: ProgramAbiDraft;
  readonly session: PreparedClassLayoutSessionSnapshot;
}

interface PreparedClassLayoutDescriptorPayload {
  readonly host: PreparedClassLayoutHost;
  readonly lifecycle: PreparedProgramAbiDescriptorLifecycle;
  readonly entries: readonly PreparedClassLayoutEntry[];
  readonly planned: boolean;
}

/** Opaque type-registry-authenticated token for provisional class layouts. */
export interface PreparedClassLayoutDescriptor {
  readonly kind: "prepared-class-layout-descriptor";
}

const preparedClassLayoutDescriptors = new WeakMap<
  PreparedClassLayoutDescriptor,
  PreparedClassLayoutDescriptorPayload
>();

function validOrdinal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function locatorObject(locator: ProgramAbiSlotLocator): object {
  return locator.kind === "type-cell" ? locator.cell : locator.value;
}

function locatorSpace(locator: ProgramAbiSlotLocator): ProgramAbiSlotSpace {
  if (locator.kind === "defined-function" || locator.kind === "import-function") return "function";
  if (locator.kind === "defined-global" || locator.kind === "import-global") return "global";
  return "type";
}

export function clonePreparedProgramAbiDraft(draft: ProgramAbiDraft): ProgramAbiDraft {
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

export function preparedProgramAbiDraftsEqual(a: ProgramAbiDraft, b: ProgramAbiDraft): boolean {
  const left = a as ProgramAbiDraft & { readonly aliasOf?: IrBindingId; readonly slotSpace?: ProgramAbiSlotSpace };
  const right = b as ProgramAbiDraft & { readonly aliasOf?: IrBindingId; readonly slotSpace?: ProgramAbiSlotSpace };
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.structuralReferenceKey === b.structuralReferenceKey &&
    a.slotPolicy === b.slotPolicy &&
    left.slotSpace === right.slotSpace &&
    left.aliasOf === right.aliasOf &&
    a.structuralOrder.sourceId === b.structuralOrder.sourceId &&
    a.structuralOrder.declarationOrdinal === b.structuralOrder.declarationOrdinal &&
    a.structuralOrder.domainOrdinal === b.structuralOrder.domainOrdinal &&
    a.structuralOrder.roleOrdinal === b.structuralOrder.roleOrdinal &&
    a.structuralOrder.derivedOrdinal === b.structuralOrder.derivedOrdinal &&
    programAbiIntentsEqual(a.intent, b.intent)
  );
}

export function preparedProgramAbiPlanEntriesEqualIgnoringDenseOrder(
  a: ProgramAbiPlanEntry,
  b: ProgramAbiPlanEntry,
): boolean {
  const left = a as ProgramAbiPlanEntry & {
    readonly aliasOf?: IrBindingId;
    readonly slotSpace?: ProgramAbiSlotSpace;
  };
  const right = b as ProgramAbiPlanEntry & {
    readonly aliasOf?: IrBindingId;
    readonly slotSpace?: ProgramAbiSlotSpace;
  };
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.structuralReferenceKey === b.structuralReferenceKey &&
    a.slotPolicy === b.slotPolicy &&
    left.slotSpace === right.slotSpace &&
    left.aliasOf === right.aliasOf &&
    programAbiIntentsEqual(a.intent, b.intent)
  );
}

export function preparedProgramAbiStructuralOrderKey(sourceOrder: number, order: ProgramAbiDraftOrder): string {
  return [sourceOrder, order.declarationOrdinal, order.domainOrdinal, order.roleOrdinal, order.derivedOrdinal].join(
    ":",
  );
}

export function comparePreparedProgramAbiDrafts(
  sourceOrderById: ReadonlyMap<IrSourceId, number>,
  left: ProgramAbiDraft,
  right: ProgramAbiDraft,
): number {
  const a = left.structuralOrder;
  const b = right.structuralOrder;
  return (
    sourceOrderById.get(a.sourceId)! - sourceOrderById.get(b.sourceId)! ||
    a.declarationOrdinal - b.declarationOrdinal ||
    a.domainOrdinal - b.domainOrdinal ||
    a.roleOrdinal - b.roleOrdinal ||
    a.derivedOrdinal - b.derivedOrdinal
  );
}

function classLayoutDraftOrderOwner(session: ProgramAbiSession, draft: ProgramAbiDraft): IrBindingId | undefined {
  const sourceOrder = session.inventory.sources.find(({ id }) => id === draft.structuralOrder.sourceId)?.order;
  if (sourceOrder === undefined) {
    throw new ProgramAbiInvariantError(
      "unknown-draft-source",
      `ABI draft ${draft.id} references source ${draft.structuralOrder.sourceId} outside this inventory`,
    );
  }
  const state = session as unknown as { readonly draftOrderOwners: ReadonlyMap<string, IrBindingId> };
  return state.draftOrderOwners.get(preparedProgramAbiStructuralOrderKey(sourceOrder, draft.structuralOrder));
}

function describePreparedClassLayoutEntry(host: PreparedClassLayoutHost, classId: IrClassId): PreparedClassLayoutEntry {
  const classRecords = host.session.inventory.classes.filter((record) => record.id === classId);
  const observation = host.observation(classId);
  const type = observation?.cell.current;
  const typeIndex = type === null || type === undefined ? -1 : host.module.types.indexOf(type);
  if (
    classRecords.length !== 1 ||
    !observation ||
    observation.classId !== classId ||
    !type ||
    type.kind !== "struct" ||
    typeIndex < 0 ||
    host.module.types.lastIndexOf(type) !== typeIndex ||
    !host.isPreparable(type) ||
    host.session.typeCellFor(type) !== observation.cell
  ) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `prepared class ${classId} has no exact final observed remappable layout`,
    );
  }
  const classRecord = classRecords[0]!;
  const ref = irClassTypeRef(classId, observation.displayName);
  const structuralReferenceKey = irTypeBindingKey(ref.binding);
  const layoutKey = canonicalProgramAbiTypeDef(type);
  const draft = Object.freeze({
    id: ref.binding.bindingId,
    structuralOrder: Object.freeze({
      ...host.session.structuralOrder.forClass(classId, {
        domain: "class",
        roleOrdinal: host.roleOrdinal,
      }),
    }),
    structuralReferenceKey,
    displayName: observation.displayName,
    slotPolicy: "required" as const,
    slotSpace: "type" as const,
    intent: Object.freeze({ kind: "class" as const, classId, layoutKey }),
  }) satisfies ProgramAbiDraft;
  const session = Object.freeze({
    draft: host.session.getDraft(draft.id),
    structuralOrderOwner: classLayoutDraftOrderOwner(host.session, draft),
    structuralReferenceBindingIds: Object.freeze([
      ...host.session.bindingIdsForStructuralReference(structuralReferenceKey),
    ]),
    locatorOwner: host.session.locatorBindingId(observation.cell),
    hasExactLocator: host.session.hasLocator(draft.id, observation.cell),
  });
  const committed = session.draft !== undefined;
  if (
    !(session.draft === undefined ? !committed : preparedProgramAbiDraftsEqual(session.draft, draft)) ||
    session.structuralOrderOwner !== (committed ? draft.id : undefined) ||
    (committed
      ? session.structuralReferenceBindingIds.length !== 1 ||
        session.structuralReferenceBindingIds[0] !== draft.id ||
        session.locatorOwner !== draft.id ||
        !session.hasExactLocator
      : session.structuralReferenceBindingIds.length !== 0 ||
        session.locatorOwner !== undefined ||
        session.hasExactLocator)
  ) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `prepared class ${classId} disagrees with current Program-ABI ownership`,
    );
  }
  return Object.freeze({ classRecord, observation, type, layoutKey, structuralReferenceKey, draft, session });
}

function assertSamePreparedClassLayoutEntry(
  expected: PreparedClassLayoutEntry,
  actual: PreparedClassLayoutEntry,
): void {
  const expectedSessionDraft = expected.session.draft;
  const actualSessionDraft = actual.session.draft;
  if (
    expected.classRecord !== actual.classRecord ||
    expected.observation !== actual.observation ||
    expected.observation.displayName !== actual.observation.displayName ||
    expected.observation.cell !== actual.observation.cell ||
    expected.type !== actual.type ||
    expected.layoutKey !== actual.layoutKey ||
    expected.structuralReferenceKey !== actual.structuralReferenceKey ||
    !preparedProgramAbiDraftsEqual(expected.draft, actual.draft) ||
    (expectedSessionDraft === undefined || actualSessionDraft === undefined
      ? expectedSessionDraft !== actualSessionDraft
      : !preparedProgramAbiDraftsEqual(expectedSessionDraft, actualSessionDraft)) ||
    expected.session.structuralOrderOwner !== actual.session.structuralOrderOwner ||
    expected.session.locatorOwner !== actual.session.locatorOwner ||
    expected.session.hasExactLocator !== actual.session.hasExactLocator ||
    expected.session.structuralReferenceBindingIds.length !== actual.session.structuralReferenceBindingIds.length ||
    expected.session.structuralReferenceBindingIds.some(
      (id, index) => id !== actual.session.structuralReferenceBindingIds[index],
    )
  ) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `prepared class ${expected.classRecord.id} descriptor is stale`,
    );
  }
}

function assertClassLayoutDescriptorCurrent(
  descriptor: PreparedClassLayoutDescriptor,
  payload: PreparedClassLayoutDescriptorPayload,
): void {
  if (payload.host.planningSealed() !== payload.planned || payload.planned) {
    throw new ProgramAbiInvariantError(
      "planning-sealed",
      "prepared class-layout descriptor crossed retained type planning",
    );
  }
  const actual = payload.entries.map((entry) => describePreparedClassLayoutEntry(payload.host, entry.classRecord.id));
  if (actual.length !== payload.entries.length) {
    throw new ProgramAbiInvariantError("type-remap-mismatch", "prepared class-layout descriptor selection changed");
  }
  payload.entries.forEach((expected, index) => assertSamePreparedClassLayoutEntry(expected, actual[index]!));
  if (!preparedClassLayoutDescriptors.has(descriptor)) {
    throw new ProgramAbiInvariantError("type-remap-mismatch", "prepared class-layout descriptor lost ownership");
  }
}

function classLayoutDescriptorState(lifecycle: PreparedProgramAbiDescriptorLifecycle): string | undefined {
  return lifecycle.state.get("state");
}

function assertClassLayoutDescriptorFresh(lifecycle: PreparedProgramAbiDescriptorLifecycle): void {
  if (classLayoutDescriptorState(lifecycle) !== "fresh" || lifecycle.state.has("scopeId")) {
    throw new ProgramAbiInvariantError("type-remap-mismatch", "prepared class-layout descriptor is not fresh");
  }
}

function assertClassLayoutDescriptorClaimed(lifecycle: PreparedProgramAbiDescriptorLifecycle, scopeId: string): void {
  if (classLayoutDescriptorState(lifecycle) !== "claimed" || lifecycle.state.get("scopeId") !== scopeId) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `prepared class-layout descriptor is not claimed by exact scope ${scopeId}`,
    );
  }
}

export function describePreparedClassLayouts(
  host: PreparedClassLayoutHost,
  classIds: ReadonlySet<IrClassId>,
): PreparedClassLayoutDescriptor {
  if (host.planningSealed()) {
    throw new ProgramAbiInvariantError(
      "planning-sealed",
      "cannot describe prepared class layouts after retained type planning",
    );
  }
  const entries = Object.freeze([...classIds].sort().map((classId) => describePreparedClassLayoutEntry(host, classId)));
  const descriptor = Object.freeze({ kind: "prepared-class-layout-descriptor" as const });
  preparedClassLayoutDescriptors.set(
    descriptor,
    Object.freeze({
      host,
      lifecycle: Object.freeze({ state: new Map<"state" | "scopeId", string>([["state", "fresh"]]) }),
      entries,
      planned: host.planningSealed(),
    }),
  );
  return descriptor;
}

export function prepareClassLayoutDescriptorForScope(
  descriptor: PreparedClassLayoutDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): PreparedProgramAbiDescriptorPart {
  const payload = preparedClassLayoutDescriptors.get(descriptor);
  if (!payload || payload.host.session !== session || scopeId.length === 0) {
    throw new ProgramAbiInvariantError(
      "context-session-mismatch",
      "prepared class-layout descriptor targets a foreign session or empty scope",
    );
  }
  assertClassLayoutDescriptorFresh(payload.lifecycle);
  payload.lifecycle.state.set("scopeId", scopeId);
  payload.lifecycle.state.set("state", "claimed");
  try {
    assertClassLayoutDescriptorCurrent(descriptor, payload);
    const bindings = Object.freeze(
      payload.entries.map(
        (entry): PreparedProgramAbiProvisionalBinding =>
          Object.freeze({
            draft: entry.draft,
            structuralReferenceKey: entry.structuralReferenceKey,
            locator: Object.freeze({ kind: "type-cell" as const, cell: entry.observation.cell }),
          }),
      ),
    );
    return Object.freeze({
      kind: "class-layouts" as const,
      session,
      descriptor,
      lifecycle: payload.lifecycle,
      bindings,
      requestedStructuralReferenceKeys: Object.freeze(payload.entries.map((entry) => entry.structuralReferenceKey)),
      closureStructuralReferenceKeys: Object.freeze([]),
      registryWrites: Object.freeze([]),
      assertCurrent: () => {
        assertClassLayoutDescriptorClaimed(payload.lifecycle, scopeId);
        assertClassLayoutDescriptorCurrent(descriptor, payload);
      },
    });
  } catch (error) {
    payload.lifecycle.state.set("state", "consumed");
    throw error;
  }
}

export function consumePreparedClassLayoutDescriptor(
  descriptor: PreparedClassLayoutDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): void {
  const payload = preparedClassLayoutDescriptors.get(descriptor);
  if (!payload || payload.host.session !== session) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      "prepared class-layout descriptor is forged or belongs to another session",
    );
  }
  assertClassLayoutDescriptorClaimed(payload.lifecycle, scopeId);
  payload.lifecycle.state.set("state", "consumed");
}

function assertPreparedMapWritesUnique(
  scopeId: string,
  writes: readonly PreparedProgramAbiMapWrite[],
  domain: string,
): void {
  const keysByTarget = new Map<Map<unknown, unknown>, Set<unknown>>();
  for (const write of writes) {
    let keys = keysByTarget.get(write.target);
    if (!keys) {
      keys = new Set();
      keysByTarget.set(write.target, keys);
    }
    if (keys.has(write.key)) {
      throw new ProgramAbiInvariantError(
        "duplicate-session-draft",
        `prepared ABI batch ${scopeId} contains duplicate ${domain} write`,
      );
    }
    keys.add(write.key);
  }
}

function preflightPreparedProvisionalBinding(
  host: PreparedProgramAbiTransactionHost,
  scopeId: string,
  binding: PreparedProgramAbiProvisionalBinding,
  overlay: PreparedProgramAbiPlanningOverlay,
  sessionWrites: PreparedProgramAbiMapWrite[],
  provisionalIds: Set<IrBindingId>,
  provisionalKeys: Map<string, IrBindingId>,
  provisionalLocatorOwners: Map<object, IrBindingId>,
): void {
  const { draft, structuralReferenceKey, locator, callableTypeContract, globalTypeContract } = binding;
  if (provisionalIds.has(draft.id)) {
    throw new ProgramAbiInvariantError(
      "duplicate-session-draft",
      `prepared ABI batch ${scopeId} contains duplicate provisional binding ${draft.id}`,
    );
  }
  provisionalIds.add(draft.id);
  const isExportAlias = draft.intent.kind === "export" && draft.slotPolicy === "alias";
  if (
    isExportAlias
      ? structuralReferenceKey !== undefined || draft.structuralReferenceKey !== undefined
      : typeof structuralReferenceKey !== "string" ||
        structuralReferenceKey.length === 0 ||
        draft.structuralReferenceKey !== structuralReferenceKey
  ) {
    throw new ProgramAbiInvariantError(
      "binding-reference-mismatch",
      `prepared ABI binding ${draft.id} has a mismatched structural key`,
    );
  }
  if (structuralReferenceKey !== undefined) {
    const previousKeyOwner = provisionalKeys.get(structuralReferenceKey);
    if (previousKeyOwner !== undefined && previousKeyOwner !== draft.id) {
      throw new ProgramAbiInvariantError(
        "duplicate-session-draft",
        `prepared ABI bindings ${previousKeyOwner} and ${draft.id} share provisional key ${structuralReferenceKey}`,
      );
    }
    provisionalKeys.set(structuralReferenceKey, draft.id);
  }

  const sourceOrder = host.sourceOrderById.get(draft.structuralOrder.sourceId);
  const orderComponents = [
    draft.structuralOrder.declarationOrdinal,
    draft.structuralOrder.domainOrdinal,
    draft.structuralOrder.roleOrdinal,
    draft.structuralOrder.derivedOrdinal,
  ];
  if (
    sourceOrder === undefined ||
    orderComponents.some((value) => !validOrdinal(value)) ||
    draft.structuralOrder.domainOrdinal !== host.domainOrdinal(draft.intent.kind)
  ) {
    throw new ProgramAbiInvariantError(
      sourceOrder === undefined ? "unknown-draft-source" : "invalid-draft-order",
      `prepared ABI binding ${draft.id} has invalid source/order provenance`,
    );
  }
  const exactDraft = clonePreparedProgramAbiDraft(draft);
  const existingDraft = overlay.drafts.get(draft.id);
  const committedReuse = existingDraft !== undefined;
  const orderKey = preparedProgramAbiStructuralOrderKey(sourceOrder, draft.structuralOrder);
  const orderOwner = overlay.draftOrderOwners.get(orderKey);
  if (existingDraft) {
    if (!preparedProgramAbiDraftsEqual(existingDraft, exactDraft) || orderOwner !== draft.id) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `prepared ABI binding ${draft.id} disagrees with committed draft/order ownership`,
      );
    }
  } else {
    if (orderOwner !== undefined) {
      throw new ProgramAbiInvariantError(
        "duplicate-draft-order",
        `prepared ABI binding ${draft.id} collides with ${orderOwner} at structural order ${orderKey}`,
      );
    }
    overlay.drafts.set(draft.id, exactDraft);
    overlay.draftOrderOwners.set(orderKey, draft.id);
    sessionWrites.push(
      Object.freeze({ target: host.committed.drafts as Map<unknown, unknown>, key: draft.id, value: exactDraft }),
      Object.freeze({
        target: host.committed.draftOrderOwners as Map<unknown, unknown>,
        key: orderKey,
        value: draft.id,
      }),
    );
  }

  const existingReference = overlay.structuralReferenceKeys.get(draft.id);
  const existingReferenceOwner = [...overlay.structuralReferenceKeys.entries()].find(
    ([id, key]) => key === structuralReferenceKey && id !== draft.id,
  )?.[0];
  if (existingReferenceOwner !== undefined) {
    throw new ProgramAbiInvariantError(
      "duplicate-session-draft",
      `prepared ABI binding ${draft.id} collides with structural reference owner ${existingReferenceOwner}`,
    );
  }
  if (isExportAlias) {
    if (existingReference !== undefined) {
      throw new ProgramAbiInvariantError(
        "binding-reference-mismatch",
        `prepared export alias ${draft.id} unexpectedly owns a structural reservation`,
      );
    }
  } else {
    if (existingReference !== undefined && existingReference !== structuralReferenceKey) {
      throw new ProgramAbiInvariantError(
        "binding-reference-mismatch",
        `prepared ABI binding ${draft.id} disagrees with its committed structural reservation`,
      );
    }
    if (existingReference === undefined && committedReuse) {
      throw new ProgramAbiInvariantError(
        "binding-reference-mismatch",
        `prepared ABI binding ${draft.id} has an incomplete committed structural reservation`,
      );
    }
    if (existingReference === undefined) {
      overlay.structuralReferenceKeys.set(draft.id, structuralReferenceKey!);
      sessionWrites.push(
        Object.freeze({
          target: host.committed.structuralReferenceKeys as Map<unknown, unknown>,
          key: draft.id,
          value: structuralReferenceKey,
        }),
      );
    }
  }

  if (locator !== undefined) {
    if (draft.slotPolicy !== "required" || draft.slotSpace !== locatorSpace(locator)) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `prepared ABI binding ${draft.id} has incompatible ${locator.kind} locator`,
      );
    }
    if (
      (locator.kind === "import-function" && locator.value.desc.kind !== "func") ||
      (locator.kind === "import-global" && locator.value.desc.kind !== "global") ||
      (locator.kind === "type-cell" && !host.typeCells.has(locator.cell))
    ) {
      throw new ProgramAbiInvariantError(
        locator.kind === "type-cell" ? "foreign-type-cell" : "slot-locator-space-mismatch",
        `prepared ABI binding ${draft.id} has an invalid locator`,
      );
    }
    const object = locatorObject(locator);
    const provisionalOwner = provisionalLocatorOwners.get(object);
    if (provisionalOwner !== undefined && provisionalOwner !== draft.id) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `prepared ABI locators ${provisionalOwner} and ${draft.id} share one allocator object`,
      );
    }
    provisionalLocatorOwners.set(object, draft.id);
    const existingLocator = overlay.locators.get(draft.id);
    const existingOwner = overlay.locatorOwners.get(object);
    if (existingLocator !== undefined || existingOwner !== undefined) {
      if (
        !existingLocator ||
        locatorObject(existingLocator) !== object ||
        existingLocator.kind !== locator.kind ||
        existingOwner !== draft.id
      ) {
        throw new ProgramAbiInvariantError(
          "duplicate-slot-locator",
          `prepared ABI binding ${draft.id} disagrees with committed locator ownership`,
        );
      }
    } else if (committedReuse) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `prepared ABI binding ${draft.id} has an incomplete committed locator reservation`,
      );
    } else {
      const exactLocator = Object.freeze({ ...locator }) as ProgramAbiSlotLocator;
      overlay.locators.set(draft.id, exactLocator);
      overlay.locatorOwners.set(object, draft.id);
      sessionWrites.push(
        Object.freeze({
          target: host.committed.locators as Map<unknown, unknown>,
          key: draft.id,
          value: exactLocator,
        }),
        Object.freeze({
          target: host.committed.locatorOwners as Map<unknown, unknown>,
          key: object,
          value: draft.id,
        }),
      );
    }
  } else if (draft.slotPolicy === "required" && !overlay.locators.has(draft.id)) {
    throw new ProgramAbiInvariantError(
      "missing-required-locator",
      `prepared ABI binding ${draft.id} has no provisional or committed locator`,
    );
  }

  if (draft.intent.kind === "callable") {
    if (
      !callableTypeContract ||
      !programAbiCallableSignaturesEqual(
        draft.intent.signature,
        canonicalProgramAbiCallableTypeContract(callableTypeContract),
      )
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `prepared callable ${draft.id} has no exact structured type contract`,
      );
    }
    const exactContract = cloneProgramAbiCallableTypeContract(callableTypeContract);
    const existing = overlay.callableTypeContracts.get(draft.id);
    if (
      existing !== undefined &&
      !programAbiCallableSignaturesEqual(
        canonicalProgramAbiCallableTypeContract(existing),
        canonicalProgramAbiCallableTypeContract(exactContract),
      )
    ) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `prepared callable ${draft.id} disagrees with its committed type contract`,
      );
    }
    if (existing === undefined && committedReuse) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `prepared callable ${draft.id} has an incomplete committed type contract`,
      );
    }
    if (existing === undefined) {
      overlay.callableTypeContracts.set(draft.id, exactContract);
      sessionWrites.push(
        Object.freeze({
          target: host.committed.callableTypeContracts as Map<unknown, unknown>,
          key: draft.id,
          value: exactContract,
        }),
      );
    }
  } else if (callableTypeContract !== undefined) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `non-callable prepared ABI binding ${draft.id} carries a callable contract`,
    );
  }

  if (draft.intent.kind === "global") {
    if (
      globalTypeContract === undefined ||
      draft.intent.valueType !== canonicalProgramAbiValType(globalTypeContract.type) ||
      draft.intent.mutable !== globalTypeContract.mutable
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `prepared global ${draft.id} has no exact structured storage contract`,
      );
    }
    const exactContract = Object.freeze({
      type: cloneProgramAbiValType(globalTypeContract.type),
      mutable: globalTypeContract.mutable,
    });
    const existing = overlay.globalTypeContracts.get(draft.id);
    if (
      existing !== undefined &&
      (existing.mutable !== exactContract.mutable ||
        canonicalProgramAbiValType(existing.type) !== canonicalProgramAbiValType(exactContract.type))
    ) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `prepared global ${draft.id} disagrees with its committed storage contract`,
      );
    }
    if (existing === undefined && committedReuse) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `prepared global ${draft.id} has an incomplete committed storage contract`,
      );
    }
    if (existing === undefined) {
      overlay.globalTypeContracts.set(draft.id, exactContract);
      sessionWrites.push(
        Object.freeze({
          target: host.committed.globalTypeContracts as Map<unknown, unknown>,
          key: draft.id,
          value: exactContract,
        }),
      );
    }
  } else if (globalTypeContract !== undefined) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `non-global prepared ABI binding ${draft.id} carries a global contract`,
    );
  }
}

/** Build one authenticated prepared-component batch without publishing any ABI state. */
export function stagePreparedProgramAbiComponentBatch(
  host: PreparedProgramAbiTransactionHost,
  scopeId: string,
  terminalUnitIds: readonly IrUnitId[],
  input: PreparedProgramAbiComponentBatchInput,
): PreparedProgramAbiStagedBatch {
  host.assertPlanning(`stage prepared ABI batch for ${scopeId}`);
  if (!host.scopeOpen(scopeId) || host.scopeSealed(scopeId)) {
    throw new ProgramAbiInvariantError(
      "session-closed",
      `prepared ABI scope ${scopeId} is not an open session transaction`,
    );
  }
  if (
    input.scopeId !== scopeId ||
    input.terminalUnitIds.length !== terminalUnitIds.length ||
    input.terminalUnitIds.some((id, index) => id !== terminalUnitIds[index])
  ) {
    throw new ProgramAbiInvariantError(
      "invalid-callable-provenance",
      `prepared ABI batch does not match exact scope/terminal denominator ${scopeId}`,
    );
  }
  const requestedStructuralReferenceKeys = Object.freeze([...input.requestedStructuralReferenceKeys]);
  if (
    new Set(requestedStructuralReferenceKeys).size !== requestedStructuralReferenceKeys.length ||
    requestedStructuralReferenceKeys.some((key) => typeof key !== "string" || key.length === 0)
  ) {
    throw new ProgramAbiInvariantError(
      "invalid-binding-reference",
      `prepared ABI batch ${scopeId} requires a non-empty unique structural request denominator`,
    );
  }

  const parts: PreparedProgramAbiDescriptorPart[] = [];
  let preparationFailure: unknown;
  let preparationFailed = false;
  const prepare = (action: () => PreparedProgramAbiDescriptorPart): void => {
    try {
      parts.push(action());
    } catch (error) {
      if (!preparationFailed) preparationFailure = error;
      preparationFailed = true;
    }
  };
  try {
    if (input.callableImports) {
      prepare(() => prepareCallableImportDescriptorForScope(input.callableImports!, host.session, scopeId));
    }
    if (input.callableProviders) {
      prepare(() => prepareCallableProviderDescriptorForScope(input.callableProviders!, host.session, scopeId));
    }
    if (input.classLayouts) {
      prepare(() => prepareClassLayoutDescriptorForScope(input.classLayouts!, host.session, scopeId));
    }
    if (input.exportAliases) {
      prepare(() => prepareExportAliasDescriptorForScope(input.exportAliases!, host.session, scopeId));
    }
    if (input.moduleCallableAliases) {
      prepare(() => prepareModuleCallableAliasDescriptorForScope(input.moduleCallableAliases!, host.session, scopeId));
    }
    if (preparationFailed) throw preparationFailure;
    if (parts.length === 0 || new Set(parts.map(({ kind }) => kind)).size !== parts.length) {
      throw new ProgramAbiInvariantError(
        "duplicate-session-draft",
        `prepared ABI batch ${scopeId} must contain one non-empty combined descriptor set`,
      );
    }
    if (parts.some((part) => part.session !== host.session)) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        `prepared ABI batch ${scopeId} contains a descriptor from another session`,
      );
    }
    if (
      requestedStructuralReferenceKeys.length === 0 &&
      !parts.some(({ kind }) => kind === "export-aliases" || kind === "module-callable-aliases")
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `prepared ABI batch ${scopeId} has neither dependency requests nor export aliases`,
      );
    }

    const importPart = parts.find(({ kind }) => kind === "callable-imports");
    const providerPart = parts.find(({ kind }) => kind === "callable-providers");
    if (
      providerPart?.requiredImportDescriptor !== undefined &&
      (input.callableImports === undefined ||
        providerPart.requiredImportDescriptor !== input.callableImports ||
        importPart?.descriptor !== input.callableImports)
    ) {
      throw new ProgramAbiInvariantError(
        "callable-provider-mismatch",
        `prepared ABI batch ${scopeId} omits the provider's exact callable-import descriptor`,
      );
    }

    const directRequestKeys = new Set(requestedStructuralReferenceKeys);
    const requiredProviderAndClassKeys = new Set(
      parts
        .filter(({ kind }) => kind !== "callable-imports" && kind !== "module-callable-aliases")
        .flatMap(({ requestedStructuralReferenceKeys: keys }) => keys),
    );
    const importKeys = new Set(importPart?.requestedStructuralReferenceKeys ?? []);
    const requiredImportBindingIds = new Set(providerPart?.requiredImportBindingIds ?? []);
    for (const key of requiredProviderAndClassKeys) {
      if (!directRequestKeys.has(key)) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `prepared ABI batch ${scopeId} omits requested dependency key ${key}`,
        );
      }
    }
    for (const key of directRequestKeys) {
      if (!requiredProviderAndClassKeys.has(key) && !importKeys.has(key)) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `prepared ABI batch ${scopeId} requests key ${key} outside its descriptors`,
        );
      }
    }
    for (const binding of importPart?.bindings ?? []) {
      const key = binding.structuralReferenceKey;
      if ((key === undefined || !directRequestKeys.has(key)) && !requiredImportBindingIds.has(binding.draft.id)) {
        throw new ProgramAbiInvariantError(
          "callable-provider-mismatch",
          `prepared ABI batch ${scopeId} contains unrelated import ${binding.structuralReferenceKey}`,
        );
      }
    }
    for (const bindingId of requiredImportBindingIds) {
      if (!(importPart?.bindings.some(({ draft }) => draft.id === bindingId) ?? false)) {
        throw new ProgramAbiInvariantError(
          "callable-provider-mismatch",
          `prepared ABI batch ${scopeId} has no exact provisional import owner ${bindingId}`,
        );
      }
    }

    const overlay: PreparedProgramAbiPlanningOverlay = {
      drafts: new Map(host.committed.drafts),
      draftOrderOwners: new Map(host.committed.draftOrderOwners),
      locators: new Map(host.committed.locators),
      locatorOwners: new Map(host.committed.locatorOwners),
      structuralReferenceKeys: new Map(host.committed.structuralReferenceKeys),
      callableTypeContracts: new Map(host.committed.callableTypeContracts),
      globalTypeContracts: new Map(host.committed.globalTypeContracts),
    };
    const sessionWrites: PreparedProgramAbiMapWrite[] = [];
    const provisionalIds = new Set<IrBindingId>();
    const provisionalKeys = new Map<string, IrBindingId>();
    const provisionalLocatorOwners = new Map<object, IrBindingId>();
    for (const part of parts) {
      for (const binding of part.bindings) {
        preflightPreparedProvisionalBinding(
          host,
          scopeId,
          binding,
          overlay,
          sessionWrites,
          provisionalIds,
          provisionalKeys,
          provisionalLocatorOwners,
        );
      }
    }
    const resolvedParts = parts.map((part): PreparedProgramAbiDescriptorPart => {
      if (!part.projectBindings) return part;
      const bindings = part.projectBindings(
        (allocator) => overlay.locatorOwners.get(allocator),
        (id) => overlay.drafts.get(id),
      );
      for (const binding of bindings) {
        preflightPreparedProvisionalBinding(
          host,
          scopeId,
          binding,
          overlay,
          sessionWrites,
          provisionalIds,
          provisionalKeys,
          provisionalLocatorOwners,
        );
      }
      return Object.freeze({ ...part, bindings: Object.freeze([...bindings]) });
    });
    for (const part of resolvedParts) {
      for (const closureKey of part.closureStructuralReferenceKeys) {
        if (
          typeof closureKey !== "string" ||
          closureKey.length === 0 ||
          ![...overlay.drafts.values()].some(({ structuralReferenceKey }) => structuralReferenceKey === closureKey)
        ) {
          throw new ProgramAbiInvariantError(
            "invalid-binding-reference",
            `prepared ABI batch ${scopeId} has an unowned closure key ${closureKey || "<empty>"}`,
          );
        }
      }
    }

    const registryWrites = Object.freeze(resolvedParts.flatMap(({ registryWrites }) => registryWrites));
    assertPreparedMapWritesUnique(scopeId, registryWrites, "registry");
    assertPreparedMapWritesUnique(scopeId, sessionWrites, "session");
    const lookup = createPreparedProgramAbiScopeLookup(host, overlay);
    return Object.freeze({
      scopeId,
      terminalUnitIds: Object.freeze([...terminalUnitIds]),
      requestedStructuralReferenceKeys,
      parts: Object.freeze([...resolvedParts]),
      overlay,
      sessionWrites: Object.freeze(sessionWrites),
      registryWrites,
      lookup,
    });
  } catch (error) {
    // Failed one-shot descriptors cannot be replayed into another component.
    for (const part of parts) {
      const state = part.lifecycle.state.get("state");
      if (state === "fresh") {
        part.lifecycle.state.set("scopeId", scopeId);
        part.lifecycle.state.set("state", "claimed");
      }
      if (part.lifecycle.state.get("state") === "claimed") part.lifecycle.state.set("state", "consumed");
    }
    throw error;
  }
}

/**
 * Replay a claimed batch over the session's latest committed maps. The first
 * stage is intentionally only a preview: unrelated ABI work may be planned
 * while an aggregate component is lowering. Rebase never reuses the stale
 * cloned overlay and never changes descriptor lifecycle state.
 */
export function rebasePreparedProgramAbiComponentBatch(
  host: PreparedProgramAbiTransactionHost,
  batch: PreparedProgramAbiStagedBatch,
): PreparedProgramAbiStagedBatch {
  host.assertPlanning(`rebase prepared ABI batch for ${batch.scopeId}`);
  if (!host.scopeOpen(batch.scopeId) || host.scopeSealed(batch.scopeId)) {
    throw new ProgramAbiInvariantError(
      "session-closed",
      `prepared ABI scope ${batch.scopeId} is not an open session transaction`,
    );
  }
  assertPreparedProgramAbiStagedBatchCurrent(batch, batch.scopeId, batch.terminalUnitIds);
  const overlay: PreparedProgramAbiPlanningOverlay = {
    drafts: new Map(host.committed.drafts),
    draftOrderOwners: new Map(host.committed.draftOrderOwners),
    locators: new Map(host.committed.locators),
    locatorOwners: new Map(host.committed.locatorOwners),
    structuralReferenceKeys: new Map(host.committed.structuralReferenceKeys),
    callableTypeContracts: new Map(host.committed.callableTypeContracts),
    globalTypeContracts: new Map(host.committed.globalTypeContracts),
  };
  const sessionWrites: PreparedProgramAbiMapWrite[] = [];
  const provisionalIds = new Set<IrBindingId>();
  const provisionalKeys = new Map<string, IrBindingId>();
  const provisionalLocatorOwners = new Map<object, IrBindingId>();
  const parts: PreparedProgramAbiDescriptorPart[] = [];
  for (const part of batch.parts) {
    const bindings = part.rebaseBindings?.() ?? part.bindings;
    const projected = part.projectBindings
      ? part.projectBindings(
          (allocator) => overlay.locatorOwners.get(allocator),
          (id) => overlay.drafts.get(id),
        )
      : bindings;
    for (const binding of projected) {
      preflightPreparedProvisionalBinding(
        host,
        batch.scopeId,
        binding,
        overlay,
        sessionWrites,
        provisionalIds,
        provisionalKeys,
        provisionalLocatorOwners,
      );
    }
    parts.push(
      Object.freeze({
        ...part,
        bindings: Object.freeze([...projected]),
      }),
    );
  }
  for (const part of parts) {
    for (const closureKey of part.closureStructuralReferenceKeys) {
      if (
        typeof closureKey !== "string" ||
        closureKey.length === 0 ||
        ![...overlay.drafts.values()].some(({ structuralReferenceKey }) => structuralReferenceKey === closureKey)
      ) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `prepared ABI batch ${batch.scopeId} has an unowned closure key ${closureKey || "<empty>"}`,
        );
      }
    }
  }
  const registryWrites = Object.freeze(parts.flatMap(({ registryWrites }) => registryWrites));
  assertPreparedMapWritesUnique(batch.scopeId, registryWrites, "registry");
  assertPreparedMapWritesUnique(batch.scopeId, sessionWrites, "session");
  return Object.freeze({
    scopeId: batch.scopeId,
    terminalUnitIds: Object.freeze([...batch.terminalUnitIds]),
    requestedStructuralReferenceKeys: Object.freeze([...batch.requestedStructuralReferenceKeys]),
    parts: Object.freeze(parts),
    overlay,
    sessionWrites: Object.freeze(sessionWrites),
    registryWrites,
    lookup: createPreparedProgramAbiScopeLookup(host, overlay),
  });
}

/** Consume every descriptor in a staged batch exactly once. */
export function consumePreparedProgramAbiComponentBatch(
  batch: PreparedProgramAbiStagedBatch,
  session: ProgramAbiSession,
): void {
  let firstError: unknown;
  let hadError = false;
  for (const part of batch.parts) {
    try {
      if (part.kind === "callable-imports") {
        consumePreparedCallableImportDescriptor(
          part.descriptor as PreparedCallableImportDescriptor,
          session,
          batch.scopeId,
        );
      } else if (part.kind === "callable-providers") {
        consumePreparedCallableProviderDescriptor(
          part.descriptor as PreparedCallableProviderDescriptor,
          session,
          batch.scopeId,
        );
      } else if (part.kind === "class-layouts") {
        consumePreparedClassLayoutDescriptor(part.descriptor as PreparedClassLayoutDescriptor, session, batch.scopeId);
      } else if (part.kind === "module-callable-aliases") {
        consumePreparedModuleCallableAliasDescriptor(
          part.descriptor as PreparedModuleCallableAliasDescriptor,
          session,
          batch.scopeId,
        );
      } else {
        consumePreparedExportAliasDescriptor(part.descriptor as PreparedExportAliasDescriptor, session, batch.scopeId);
      }
    } catch (error) {
      if (!hadError) firstError = error;
      hadError = true;
    } finally {
      // Every staged part is one-shot even when an underlying registry
      // validation observes a stale/partially-consumed lifecycle. The registry
      // callbacks and this shared lifecycle cell intentionally agree here so
      // replay cannot resurrect one remaining part after an abort failure.
      part.lifecycle.state.set("state", "consumed");
    }
  }
  if (hadError) throw firstError;
}

/** Re-authenticate a staged batch immediately before scope sealing. */
export function assertPreparedProgramAbiStagedBatchCurrent(
  batch: PreparedProgramAbiStagedBatch | undefined,
  scopeId: string,
  terminalUnitIds: readonly IrUnitId[],
): void {
  if (!batch) return;
  if (
    batch.scopeId !== scopeId ||
    batch.terminalUnitIds.length !== terminalUnitIds.length ||
    batch.terminalUnitIds.some((id, index) => id !== terminalUnitIds[index])
  ) {
    throw new ProgramAbiInvariantError(
      "invalid-callable-provenance",
      `prepared ABI staged batch no longer matches exact scope/terminal denominator ${scopeId}`,
    );
  }
  for (const part of batch.parts) part.assertCurrent();
  for (const write of batch.sessionWrites) {
    if (write.target.has(write.key) && !preparedTransactionWriteValuesEqual(write.target.get(write.key), write.value)) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `prepared ABI batch ${scopeId} crossed intervening session publication`,
      );
    }
  }
}

function preparedTransactionWriteValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** Select the side-effect-free batch overlay or the exact committed maps. */
export function preparedProgramAbiPlanningOverlayForBatch(
  batch: PreparedProgramAbiStagedBatch | undefined,
  committed: PreparedProgramAbiPlanningOverlay,
): PreparedProgramAbiPlanningOverlay {
  return batch?.overlay ?? Object.freeze(committed);
}

/** Prove that every staged structural request was included by the component. */
export function assertPreparedProgramAbiStagedRequestClosure(
  batch: PreparedProgramAbiStagedBatch | undefined,
  scopeId: string,
  requestedBindingIds: ReadonlySet<IrBindingId>,
  planning: PreparedProgramAbiPlanningOverlay,
): void {
  for (const key of batch?.requestedStructuralReferenceKeys ?? []) {
    if (![...requestedBindingIds].some((id) => planning.drafts.get(id)?.structuralReferenceKey === key)) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `prepared ABI scope ${scopeId} omitted staged dependency request ${key}`,
      );
    }
  }
}

/** Prove final component closure over every staged descriptor contribution. */
export function assertPreparedProgramAbiStagedBindingClosure(
  batch: PreparedProgramAbiStagedBatch | undefined,
  scopeId: string,
  bindingIds: ReadonlySet<IrBindingId>,
  planning: PreparedProgramAbiPlanningOverlay,
): void {
  for (const part of batch?.parts ?? []) {
    part.assertBindingClosure?.(bindingIds, (allocator) => planning.locatorOwners.get(allocator));
  }
  if (batch?.parts.some((part) => part.bindings.some(({ draft }) => !bindingIds.has(draft.id))) === true) {
    throw new ProgramAbiInvariantError(
      "invalid-binding-reference",
      `prepared ABI scope ${scopeId} does not close over every staged provisional binding`,
    );
  }
}
