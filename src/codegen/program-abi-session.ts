// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncTypeDef, GlobalDef, Import, TypeDef, ValType, WasmFunction, WasmModule } from "../ir/types.js";
import type { IrBindingId, IrClassId, IrSourceId, IrUnitId, IrUnitInventory } from "../ir/identity.js";
import {
  LegacyAbiAdapter,
  ProgramAbiInvariantError,
  ProgramAbiMap,
  type ProgramAbiDerivedUnitRecord,
  type ProgramAbiPlanEntry,
  type ProgramAbiSlotSpace,
} from "../ir/program-abi.js";
import {
  canonicalProgramAbiCallableTypeContract,
  canonicalProgramAbiTypeDef,
  canonicalProgramAbiValType,
  cloneProgramAbiCallableTypeContract,
  cloneProgramAbiValType,
  programAbiCallableSignaturesEqual,
  type ProgramAbiCallableTypeContract,
} from "./program-abi-signatures.js";

const ABI_DOMAIN_ORDINAL = Object.freeze({
  callable: 0,
  global: 1,
  type: 2,
  class: 3,
  export: 4,
  support: 5,
} as const);

export type ProgramAbiDomain = keyof typeof ABI_DOMAIN_ORDINAL;

/**
 * Closed domain order used by ABI planning. Producers record this value
 * explicitly, and the session verifies it against the draft's intent.
 */
export function programAbiDomainOrdinal(domain: ProgramAbiDomain): number {
  return ABI_DOMAIN_ORDINAL[domain];
}

/**
 * Structural order supplied by the producer that owns a declaration/support
 * role. The session derives source order from the inventory and rejects ties;
 * no encoded ID or Map insertion order participates.
 */
export interface ProgramAbiDraftOrder {
  readonly sourceId: IrSourceId;
  readonly declarationOrdinal: number;
  readonly domainOrdinal: number;
  readonly roleOrdinal: number;
  readonly derivedOrdinal: number;
}

export interface ProgramAbiDraftSuborder {
  readonly domain: ProgramAbiDomain;
  readonly roleOrdinal: number;
  readonly derivedOrdinal?: number;
}

interface ProgramAbiDeclarationAnchor {
  readonly sourceId: IrSourceId;
  readonly declarationOrdinal: number;
}

/**
 * Canonical source-local draft ordering derived from the inventory population.
 *
 * `IrUnitRecord.ordinal` is only local to a structural owner/kind, so it is
 * never used here as a whole-source ordinal. Exact unit anchors instead use
 * their position in `inventory.allUnits`; source and class anchors occupy
 * disjoint slots around that authoritative sequence.
 */
export class ProgramAbiStructuralOrder {
  private readonly sourceAnchors = new Map<IrSourceId, ProgramAbiDeclarationAnchor>();
  private readonly unitAnchors = new Map<IrUnitId, ProgramAbiDeclarationAnchor>();
  private readonly classAnchors = new Map<IrClassId, ProgramAbiDeclarationAnchor>();
  private readonly derivedParents = new Map<IrUnitId, IrUnitId>();
  private readonly derivedChildren = new Map<IrUnitId, Set<IrUnitId>>();
  private readonly derivedUnits = new Map<IrUnitId, ProgramAbiDerivedUnitRecord>();
  private readonly derivedPathOrdinalsByRoot = new Map<IrUnitId, ReadonlyMap<IrUnitId, number>>();

  constructor(readonly inventory: IrUnitInventory) {
    const sourceLocalCounts = new Map<IrSourceId, number>();
    const anchorOwners = new Map<string, string>();
    const reserveAnchor = (anchor: ProgramAbiDeclarationAnchor, owner: string): void => {
      const key = `${anchor.sourceId}\u0000${anchor.declarationOrdinal}`;
      const previous = anchorOwners.get(key);
      if (previous !== undefined) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `${owner} and ${previous} share ABI order anchor ${anchor.declarationOrdinal}`,
        );
      }
      anchorOwners.set(key, owner);
    };
    for (const source of inventory.sources) {
      if (this.sourceAnchors.has(source.id)) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `source ${source.id} occurs more than once in the ABI ordering inventory`,
        );
      }
      const anchor = Object.freeze({ sourceId: source.id, declarationOrdinal: 0 });
      reserveAnchor(anchor, `source ${source.id}`);
      this.sourceAnchors.set(source.id, anchor);
      sourceLocalCounts.set(source.id, 0);
    }

    for (const unit of inventory.allUnits) {
      if (this.unitAnchors.has(unit.id)) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `unit ${unit.id} occurs more than once in the ABI ordering inventory`,
        );
      }
      const sourceCount = sourceLocalCounts.get(unit.sourceId);
      if (sourceCount === undefined) {
        throw new ProgramAbiInvariantError(
          "unknown-order-anchor",
          `unit ${unit.id} references source ${unit.sourceId} outside the ABI ordering inventory`,
        );
      }
      const anchor = Object.freeze({
        sourceId: unit.sourceId,
        declarationOrdinal: (sourceCount + 1) * 2,
      });
      reserveAnchor(anchor, `unit ${unit.id}`);
      this.unitAnchors.set(unit.id, anchor);
      sourceLocalCounts.set(unit.sourceId, sourceCount + 1);
    }

    // Unit-backed classes retain their historical slot immediately before the
    // first exact member unit. Classes with no executable unit (for example an
    // ambient `declare class`) occupy odd slots after the authoritative unit
    // range, in the inventory's canonical source-local class order.
    const nextUnitlessClassOrdinalBySource = new Map<IrSourceId, number>();
    for (const source of inventory.sources) {
      const sourceUnitCount = sourceLocalCounts.get(source.id)!;
      nextUnitlessClassOrdinalBySource.set(source.id, (sourceUnitCount + 1) * 2 - 1);
    }
    for (const classRecord of inventory.classes) {
      if (this.classAnchors.has(classRecord.id)) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `class ${classRecord.id} occurs more than once in the ABI ordering inventory`,
        );
      }
      const member = inventory.allUnits.find(
        (unit) => unit.sourceId === classRecord.sourceId && unit.lexicalOwnerId === classRecord.id,
      );
      const memberAnchor = member === undefined ? undefined : this.unitAnchors.get(member.id);
      let anchor: Readonly<ProgramAbiDeclarationAnchor>;
      if (memberAnchor) {
        anchor = Object.freeze({
          sourceId: classRecord.sourceId,
          declarationOrdinal: memberAnchor.declarationOrdinal - 1,
        });
      } else {
        const declarationOrdinal = nextUnitlessClassOrdinalBySource.get(classRecord.sourceId);
        if (declarationOrdinal === undefined) {
          throw new ProgramAbiInvariantError(
            "unknown-order-anchor",
            `class ${classRecord.id} references source ${classRecord.sourceId} outside the ABI ordering inventory`,
          );
        }
        anchor = Object.freeze({ sourceId: classRecord.sourceId, declarationOrdinal });
        nextUnitlessClassOrdinalBySource.set(classRecord.sourceId, declarationOrdinal + 2);
      }
      if (!validOrdinal(anchor.declarationOrdinal)) {
        throw new ProgramAbiInvariantError(
          "invalid-draft-order",
          `class ${classRecord.id} has invalid ABI order anchor ${anchor.declarationOrdinal}`,
        );
      }
      reserveAnchor(anchor, `class ${classRecord.id}`);
      this.classAnchors.set(classRecord.id, anchor);
    }
  }

  registerDerivedUnit(record: ProgramAbiDerivedUnitRecord): void {
    const exactRecord = Object.freeze({ ...record });
    const parentRoot = this.resolveKnownRoot(exactRecord.parentId, new Set());
    if (parentRoot !== undefined && this.derivedPathOrdinalsByRoot.has(parentRoot)) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `cannot register derived unit ${exactRecord.id} after ordering started for its provenance root`,
      );
    }
    if (this.unitAnchors.has(exactRecord.id) || this.derivedParents.has(exactRecord.id)) {
      throw new ProgramAbiInvariantError(
        "ambiguous-order-anchor",
        `derived unit ${exactRecord.id} was registered more than once with the ABI ordering sidecar`,
      );
    }
    this.derivedParents.set(exactRecord.id, exactRecord.parentId);
    this.derivedUnits.set(exactRecord.id, exactRecord);
    let children = this.derivedChildren.get(exactRecord.parentId);
    if (!children) {
      children = new Set();
      this.derivedChildren.set(exactRecord.parentId, children);
    }
    children.add(exactRecord.id);
  }

  forSource(sourceId: IrSourceId, suborder: ProgramAbiDraftSuborder): ProgramAbiDraftOrder {
    return this.orderFor(this.sourceAnchors.get(sourceId), `source ${sourceId}`, suborder);
  }

  forUnit(unitId: IrUnitId, suborder: ProgramAbiDraftSuborder): ProgramAbiDraftOrder {
    const exactSuborder =
      this.derivedUnits.has(unitId) && suborder.derivedOrdinal === undefined
        ? { ...suborder, derivedOrdinal: this.derivedPathOrdinal(unitId) }
        : suborder;
    return this.orderFor(this.resolveUnitAnchor(unitId, new Set()), `unit ${unitId}`, exactSuborder);
  }

  forClass(classId: IrClassId, suborder: ProgramAbiDraftSuborder): ProgramAbiDraftOrder {
    return this.orderFor(this.classAnchors.get(classId), `class ${classId}`, suborder);
  }

  private orderFor(
    anchor: ProgramAbiDeclarationAnchor | undefined,
    description: string,
    suborder: ProgramAbiDraftSuborder,
  ): ProgramAbiDraftOrder {
    if (!anchor) {
      throw new ProgramAbiInvariantError(
        "unknown-order-anchor",
        `${description} is outside the ABI ordering inventory`,
      );
    }
    const derivedOrdinal = suborder.derivedOrdinal ?? 0;
    if (!validOrdinal(suborder.roleOrdinal) || !validOrdinal(derivedOrdinal)) {
      throw new ProgramAbiInvariantError("invalid-draft-order", `${description} has an invalid ABI suborder`);
    }
    return Object.freeze({
      sourceId: anchor.sourceId,
      declarationOrdinal: anchor.declarationOrdinal,
      domainOrdinal: programAbiDomainOrdinal(suborder.domain),
      roleOrdinal: suborder.roleOrdinal,
      derivedOrdinal,
    });
  }

  private resolveUnitAnchor(unitId: IrUnitId, visiting: Set<IrUnitId>): ProgramAbiDeclarationAnchor | undefined {
    const inventoryAnchor = this.unitAnchors.get(unitId);
    if (inventoryAnchor) return inventoryAnchor;
    const parentId = this.derivedParents.get(unitId);
    if (parentId === undefined) return undefined;
    if (visiting.has(unitId)) {
      throw new ProgramAbiInvariantError("ambiguous-order-anchor", `derived ABI order cycle includes ${unitId}`);
    }
    visiting.add(unitId);
    const parent = this.resolveUnitAnchor(parentId, visiting);
    visiting.delete(unitId);
    return parent;
  }

  private derivedPathOrdinal(id: IrUnitId): number {
    const path = this.resolveDerivedPath(id, new Set());
    let ordinals = this.derivedPathOrdinalsByRoot.get(path.rootUnitId);
    if (!ordinals) {
      ordinals = this.buildDerivedPathOrdinals(path.rootUnitId);
      this.derivedPathOrdinalsByRoot.set(path.rootUnitId, ordinals);
    }
    const ordinal = ordinals.get(id);
    if (ordinal === undefined) {
      throw new ProgramAbiInvariantError("unknown-order-anchor", `derived unit ${id} has no ABI provenance-path rank`);
    }
    return ordinal;
  }

  private buildDerivedPathOrdinals(rootUnitId: IrUnitId): ReadonlyMap<IrUnitId, number> {
    const entries: Array<{ readonly id: IrUnitId; readonly path: ProgramAbiDerivedPath }> = [];
    const pending = [...(this.derivedChildren.get(rootUnitId) ?? [])];
    const visited = new Set<IrUnitId>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `derived ABI ordering reaches ${id} more than once from root ${rootUnitId}`,
        );
      }
      visited.add(id);
      const path = this.resolveDerivedPath(id, new Set());
      if (path.rootUnitId !== rootUnitId) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `derived unit ${id} is indexed beneath root ${rootUnitId} but resolves through ${path.rootUnitId}`,
        );
      }
      entries.push({ id, path });
      pending.push(...(this.derivedChildren.get(id) ?? []));
    }

    const ordinals = new Map<IrUnitId, number>();
    entries.sort((left, right) => compareDerivedPaths(left.path, right.path));
    for (let index = 0; index < entries.length; index++) {
      if (index > 0 && compareDerivedPaths(entries[index - 1]!.path, entries[index]!.path) === 0) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `derived units ${entries[index - 1]!.id} and ${entries[index]!.id} share one provenance path`,
        );
      }
      ordinals.set(entries[index]!.id, index + 1);
    }
    return ordinals;
  }

  private resolveDerivedPath(id: IrUnitId, visiting: Set<IrUnitId>): ProgramAbiDerivedPath {
    if (this.unitAnchors.has(id)) {
      return Object.freeze({ rootUnitId: id, segments: Object.freeze([]) });
    }
    const record = this.derivedUnits.get(id);
    if (!record) {
      throw new ProgramAbiInvariantError(
        "unknown-order-anchor",
        `derived ABI ordering references unknown parent ${id}`,
      );
    }
    if (!validOrdinal(record.ordinal) || record.role.length === 0) {
      throw new ProgramAbiInvariantError(
        "invalid-draft-order",
        `derived unit ${id} has invalid role/ordinal ordering provenance`,
      );
    }
    if (visiting.has(id)) {
      throw new ProgramAbiInvariantError("ambiguous-order-anchor", `derived ABI order cycle includes ${id}`);
    }
    visiting.add(id);
    const parent = this.resolveDerivedPath(record.parentId, visiting);
    visiting.delete(id);
    return Object.freeze({
      rootUnitId: parent.rootUnitId,
      segments: Object.freeze([...parent.segments, Object.freeze({ role: record.role, ordinal: record.ordinal })]),
    });
  }

  private resolveKnownRoot(id: IrUnitId, visiting: Set<IrUnitId>): IrUnitId | undefined {
    if (this.unitAnchors.has(id)) return id;
    const parentId = this.derivedParents.get(id);
    if (parentId === undefined) return undefined;
    if (visiting.has(id)) {
      throw new ProgramAbiInvariantError("ambiguous-order-anchor", `derived ABI order cycle includes ${id}`);
    }
    visiting.add(id);
    const root = this.resolveKnownRoot(parentId, visiting);
    visiting.delete(id);
    return root;
  }
}

type ProgramAbiDraftFromPlan<T> = T extends ProgramAbiPlanEntry
  ? Omit<T, "order"> & { readonly structuralOrder: ProgramAbiDraftOrder }
  : never;

/** A queued ABI intention before the session assigns its dense plan order. */
export type ProgramAbiDraft = ProgramAbiDraftFromPlan<ProgramAbiPlanEntry>;

/** Opaque session-owned cell that follows an explicitly reported type remap. */
export interface ProgramAbiTypeCell {
  readonly current: TypeDef | null;
}

type MutableProgramAbiTypeCell = {
  current: TypeDef | null;
};

export interface ProgramAbiTypeLayoutRemap {
  /** Exact module type array installed when the layout pass began. */
  readonly previousTypes: readonly TypeDef[];
  /** Complete compacted array that will replace {@link previousTypes}. */
  readonly nextTypes: readonly TypeDef[];
  /** Dense old-index → final-index mapping; null records elimination. */
  readonly targetsByOldIndex: readonly (number | null)[];
}

interface ProgramAbiGlobalTypeContract {
  readonly type: ValType;
  readonly mutable: boolean;
}

export type ProgramAbiSlotLocator =
  | {
      readonly kind: "defined-function";
      readonly value: WasmFunction;
    }
  | {
      readonly kind: "import-function";
      readonly value: Import;
    }
  | {
      readonly kind: "defined-global";
      readonly value: GlobalDef;
    }
  | {
      readonly kind: "import-global";
      readonly value: Import;
    }
  | {
      readonly kind: "type-cell";
      readonly cell: ProgramAbiTypeCell;
    };

export interface PublishedProgramAbi {
  readonly abi: ProgramAbiMap;
  readonly legacy: LegacyAbiAdapter;
}

type SessionState = "open" | "publishing" | "published" | "failed";

function validOrdinal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

interface ProgramAbiDerivedPath {
  readonly rootUnitId: IrUnitId;
  readonly segments: readonly {
    readonly role: string;
    readonly ordinal: number;
  }[];
}

function compareDerivedPaths(a: ProgramAbiDerivedPath, b: ProgramAbiDerivedPath): number {
  const sharedLength = Math.min(a.segments.length, b.segments.length);
  for (let index = 0; index < sharedLength; index++) {
    const left = a.segments[index]!;
    const right = b.segments[index]!;
    if (left.role !== right.role) return left.role < right.role ? -1 : 1;
    if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  }
  return a.segments.length - b.segments.length;
}

function remapProgramAbiValType(
  type: ValType,
  targetsByOldIndex: readonly (number | null)[],
  bindingId: IrBindingId,
): ValType {
  if (type.kind !== "ref" && type.kind !== "ref_null") return cloneProgramAbiValType(type);
  const oldIndex = type.typeIdx;
  if (!Number.isSafeInteger(oldIndex) || oldIndex < 0 || oldIndex >= targetsByOldIndex.length) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `ABI binding ${bindingId} references type index ${oldIndex} outside the old type layout`,
    );
  }
  const target = targetsByOldIndex[oldIndex];
  if (target === null || target === undefined) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `ABI binding ${bindingId} references eliminated type index ${oldIndex}`,
    );
  }
  return Object.freeze({ ...type, typeIdx: target }) as ValType;
}

function locatorObject(locator: ProgramAbiSlotLocator): object {
  return locator.kind === "type-cell" ? locator.cell : locator.value;
}

function locatorSpace(locator: ProgramAbiSlotLocator): ProgramAbiSlotSpace {
  if (locator.kind === "defined-function" || locator.kind === "import-function") return "function";
  if (locator.kind === "defined-global" || locator.kind === "import-global") return "global";
  return "type";
}

function cloneDraft(draft: ProgramAbiDraft): ProgramAbiDraft {
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

function intentsEqual(a: ProgramAbiDraft["intent"], b: ProgramAbiDraft["intent"]): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "callable" && b.kind === "callable") {
    return (
      a.origin === b.origin &&
      a.unitId === b.unitId &&
      a.classId === b.classId &&
      a.signature.params.length === b.signature.params.length &&
      a.signature.params.every((value, index) => value === b.signature.params[index]) &&
      a.signature.results.length === b.signature.results.length &&
      a.signature.results.every((value, index) => value === b.signature.results[index])
    );
  }
  if (a.kind === "global" && b.kind === "global") {
    return a.origin === b.origin && a.valueType === b.valueType && a.mutable === b.mutable;
  }
  if (a.kind === "type" && b.kind === "type") return a.shapeKey === b.shapeKey;
  if (a.kind === "export" && b.kind === "export") {
    return a.externalName === b.externalName && a.targetId === b.targetId;
  }
  if (a.kind === "class" && b.kind === "class") {
    return a.classId === b.classId && a.layoutKey === b.layoutKey;
  }
  return a.kind === "support" && b.kind === "support" && a.role === b.role;
}

function draftsEqual(a: ProgramAbiDraft, b: ProgramAbiDraft): boolean {
  const ar = a as ProgramAbiDraft & {
    readonly aliasOf?: IrBindingId;
    readonly slotSpace?: ProgramAbiSlotSpace;
  };
  const br = b as ProgramAbiDraft & {
    readonly aliasOf?: IrBindingId;
    readonly slotSpace?: ProgramAbiSlotSpace;
  };
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.structuralReferenceKey === b.structuralReferenceKey &&
    a.slotPolicy === b.slotPolicy &&
    ar.slotSpace === br.slotSpace &&
    ar.aliasOf === br.aliasOf &&
    a.structuralOrder.sourceId === b.structuralOrder.sourceId &&
    a.structuralOrder.declarationOrdinal === b.structuralOrder.declarationOrdinal &&
    a.structuralOrder.domainOrdinal === b.structuralOrder.domainOrdinal &&
    a.structuralOrder.roleOrdinal === b.structuralOrder.roleOrdinal &&
    a.structuralOrder.derivedOrdinal === b.structuralOrder.derivedOrdinal &&
    intentsEqual(a.intent, b.intent)
  );
}

function structuralOrderKey(sourceOrder: number, order: ProgramAbiDraftOrder): string {
  return [sourceOrder, order.declarationOrdinal, order.domainOrdinal, order.roleOrdinal, order.derivedOrdinal].join(
    ":",
  );
}

function compareDrafts(
  sourceOrderById: ReadonlyMap<IrSourceId, number>,
  a: ProgramAbiDraft,
  b: ProgramAbiDraft,
): number {
  const ao = a.structuralOrder;
  const bo = b.structuralOrder;
  return (
    sourceOrderById.get(ao.sourceId)! - sourceOrderById.get(bo.sourceId)! ||
    ao.declarationOrdinal - bo.declarationOrdinal ||
    ao.domainOrdinal - bo.domainOrdinal ||
    ao.roleOrdinal - bo.roleOrdinal ||
    ao.derivedOrdinal - bo.derivedOrdinal
  );
}

/**
 * Compilation-owned mutable staging area for ProgramAbiMap.
 *
 * Producers plan structural intentions and attach allocator-owned objects.
 * One publish boundary resolves those exact objects against the current module
 * layout, then seals the resulting ABI. This class never searches by a Wasm
 * or source label.
 */
export class ProgramAbiSession {
  private readonly sourceOrderById = new Map<IrSourceId, number>();
  private readonly inventoryUnitIds = new Set<IrUnitId>();
  private readonly drafts = new Map<IrBindingId, ProgramAbiDraft>();
  private readonly draftOrderOwners = new Map<string, IrBindingId>();
  private readonly derivedUnits = new Map<IrUnitId, ProgramAbiDerivedUnitRecord>();
  private readonly locators = new Map<IrBindingId, ProgramAbiSlotLocator>();
  private readonly locatorOwners = new Map<object, IrBindingId>();
  private readonly structuralReferenceKeys = new Map<IrBindingId, string>();
  private readonly typeCells = new Set<ProgramAbiTypeCell>();
  private readonly typeCellsByObject = new Map<TypeDef, MutableProgramAbiTypeCell>();
  private readonly callableTypeContracts = new Map<IrBindingId, ProgramAbiCallableTypeContract>();
  private readonly globalTypeContracts = new Map<IrBindingId, ProgramAbiGlobalTypeContract>();
  private state: SessionState = "open";
  private publishedValue: PublishedProgramAbi | undefined;
  readonly structuralOrder: ProgramAbiStructuralOrder;

  constructor(
    readonly inventory: IrUnitInventory,
    readonly module: WasmModule,
  ) {
    for (const source of inventory.sources) this.sourceOrderById.set(source.id, source.order);
    for (const unit of inventory.allUnits) this.inventoryUnitIds.add(unit.id);
    this.structuralOrder = new ProgramAbiStructuralOrder(inventory);
  }

  /** Fail early if a context/module attempts to adopt another compilation's session. */
  assertModule(module: WasmModule): void {
    if (module !== this.module) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        "ProgramAbiSession belongs to a different WasmModule",
      );
    }
  }

  get publication(): PublishedProgramAbi | undefined {
    return this.publishedValue;
  }

  hasPlan(id: IrBindingId): boolean {
    return this.drafts.has(id);
  }

  getDraft(id: IrBindingId): ProgramAbiDraft | undefined {
    return this.drafts.get(id);
  }

  hasKnownUnit(id: IrUnitId): boolean {
    return this.derivedUnits.has(id) || this.inventoryUnitIds.has(id);
  }

  registeredDerivedUnit(id: IrUnitId): ProgramAbiDerivedUnitRecord | undefined {
    return this.derivedUnits.get(id);
  }

  /**
   * Plan once or prove that a repeated producer observation is byte-for-byte
   * equivalent at the structural contract level.
   */
  ensurePlan(draft: ProgramAbiDraft): void {
    this.assertOpen(`ensure plan ${draft.id}`);
    const existing = this.drafts.get(draft.id);
    if (!existing) {
      this.plan(draft);
      return;
    }
    if (!draftsEqual(existing, cloneDraft(draft))) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `ABI draft ${draft.id} was observed with a different plan contract`,
      );
    }
  }

  hasLocator(id: IrBindingId, allocatorObject?: object): boolean {
    const locator = this.locators.get(id);
    return locator !== undefined && (allocatorObject === undefined || locatorObject(locator) === allocatorObject);
  }

  /** Return the canonical ABI binding that already owns an exact allocator object. */
  locatorBindingId(allocatorObject: object): IrBindingId | undefined {
    return this.locatorOwners.get(allocatorObject);
  }

  registerStructuralReference(id: IrBindingId, key: string): void {
    this.assertOpen(`register structural reference for ${id}`);
    this.assertStructuralReference(id, key, true);
  }

  plan(draft: ProgramAbiDraft): void {
    this.assertOpen(`plan ${draft.id}`);
    if (this.drafts.has(draft.id)) {
      throw new ProgramAbiInvariantError("duplicate-session-draft", `ABI draft ${draft.id} was planned more than once`);
    }
    const sourceOrder = this.sourceOrderById.get(draft.structuralOrder.sourceId);
    if (sourceOrder === undefined) {
      throw new ProgramAbiInvariantError(
        "unknown-draft-source",
        `ABI draft ${draft.id} references source ${draft.structuralOrder.sourceId} outside this inventory`,
      );
    }
    const components = [
      draft.structuralOrder.declarationOrdinal,
      draft.structuralOrder.domainOrdinal,
      draft.structuralOrder.roleOrdinal,
      draft.structuralOrder.derivedOrdinal,
    ];
    if (
      components.some((value) => !validOrdinal(value)) ||
      draft.structuralOrder.domainOrdinal !== programAbiDomainOrdinal(draft.intent.kind)
    ) {
      throw new ProgramAbiInvariantError("invalid-draft-order", `ABI draft ${draft.id} has invalid structural order`);
    }
    if (
      draft.structuralReferenceKey !== undefined &&
      (typeof draft.structuralReferenceKey !== "string" || draft.structuralReferenceKey.length === 0)
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `ABI draft ${draft.id} has an invalid structural reference key`,
      );
    }
    const key = structuralOrderKey(sourceOrder, draft.structuralOrder);
    const previous = this.draftOrderOwners.get(key);
    if (previous) {
      throw new ProgramAbiInvariantError(
        "duplicate-draft-order",
        `ABI drafts ${previous} and ${draft.id} share structural order ${key}`,
      );
    }
    this.drafts.set(draft.id, cloneDraft(draft));
    this.draftOrderOwners.set(key, draft.id);
  }

  registerDerivedUnit(record: ProgramAbiDerivedUnitRecord): void {
    this.assertOpen(`register derived unit ${record.id}`);
    if (this.derivedUnits.has(record.id)) {
      throw new ProgramAbiInvariantError(
        "duplicate-derived-unit",
        `derived unit ${record.id} was registered more than once`,
      );
    }
    const exactRecord = Object.freeze({ ...record });
    this.structuralOrder.registerDerivedUnit(exactRecord);
    this.derivedUnits.set(exactRecord.id, exactRecord);
  }

  /**
   * Retain the structured callable contract beside its frozen public draft.
   *
   * The structured sidecar follows explicit type-layout events; publication
   * canonicalizes it only after DCE and verifies the final exact locator
   * carries the same contract.
   */
  registerCallableTypeContract(
    id: IrBindingId,
    signature: Pick<FuncTypeDef, "params" | "results"> | ProgramAbiCallableTypeContract,
  ): void {
    this.assertOpen(`register callable type contract for ${id}`);
    const draft = this.drafts.get(id);
    if (!draft || draft.intent.kind !== "callable") {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `callable type contract targets non-callable or unknown ABI draft ${id}`,
      );
    }
    const contract = cloneProgramAbiCallableTypeContract(signature);
    if (!programAbiCallableSignaturesEqual(draft.intent.signature, canonicalProgramAbiCallableTypeContract(contract))) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `callable type contract for ${id} does not match its planned signature`,
      );
    }
    const existing = this.callableTypeContracts.get(id);
    if (existing) {
      if (
        !programAbiCallableSignaturesEqual(
          canonicalProgramAbiCallableTypeContract(existing),
          canonicalProgramAbiCallableTypeContract(contract),
        )
      ) {
        throw new ProgramAbiInvariantError(
          "session-draft-mismatch",
          `callable type contract for ${id} was observed with a different signature`,
        );
      }
      return;
    }
    this.callableTypeContracts.set(id, contract);
  }

  /** Retain one structured global storage contract through type compaction. */
  registerGlobalTypeContract(id: IrBindingId, type: ValType, mutable: boolean): void {
    this.assertOpen(`register global type contract for ${id}`);
    const draft = this.drafts.get(id);
    if (
      !draft ||
      draft.intent.kind !== "global" ||
      draft.intent.valueType !== canonicalProgramAbiValType(type) ||
      draft.intent.mutable !== mutable
    ) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `global type contract for ${id} does not match its planned storage contract`,
      );
    }
    const existing = this.globalTypeContracts.get(id);
    if (existing) {
      if (
        existing.mutable !== mutable ||
        canonicalProgramAbiValType(existing.type) !== canonicalProgramAbiValType(type)
      ) {
        throw new ProgramAbiInvariantError(
          "session-draft-mismatch",
          `global type contract for ${id} was observed with a different storage contract`,
        );
      }
      return;
    }
    this.globalTypeContracts.set(id, Object.freeze({ type: cloneProgramAbiValType(type), mutable }));
  }

  createTypeCell(type: TypeDef): ProgramAbiTypeCell {
    this.assertOpen("create a type cell");
    if (this.typeCellsByObject.has(type)) {
      throw new ProgramAbiInvariantError(
        "duplicate-type-cell",
        "allocator type object already belongs to an ABI type cell",
      );
    }
    const cell: MutableProgramAbiTypeCell = { current: type };
    this.typeCells.add(cell);
    this.typeCellsByObject.set(type, cell);
    return cell;
  }

  typeCellFor(type: TypeDef): ProgramAbiTypeCell | undefined {
    return this.typeCellsByObject.get(type);
  }

  /**
   * Follow one explicit allocator/DCE remap. Passing null records elimination;
   * publish then rejects a required slot rather than guessing by type name.
   */
  remapTypeCell(cell: ProgramAbiTypeCell, replacement: TypeDef | null): void {
    this.assertOpen("remap a type cell");
    if (!this.typeCells.has(cell)) {
      throw new ProgramAbiInvariantError("foreign-type-cell", "type cell belongs to another ABI session");
    }
    const current = cell.current;
    if (current === null) {
      throw new ProgramAbiInvariantError("type-remap-mismatch", "eliminated ABI type cell cannot be remapped again");
    }
    this.remapTypeObject(current, replacement);
  }

  /** Follow one exact old TypeDef object through an allocator/DCE remap. */
  remapTypeObject(previous: TypeDef, replacement: TypeDef | null): void {
    this.remapTypeObjects([[previous, replacement]]);
  }

  /**
   * Apply an allocator/DCE remap in linear time from the old type population.
   *
   * Historical old-object keys remain session-owned so stale or duplicate
   * remap reports reject instead of silently attaching to another cell.
   */
  remapTypeObjects(remaps: Iterable<readonly [TypeDef, TypeDef | null]>): void {
    this.assertOpen("remap type objects");
    const pending = [...remaps];
    const previousObjects = new Set<TypeDef>();
    const replacementOwners = new Map<TypeDef, MutableProgramAbiTypeCell>();
    const validated: Array<readonly [MutableProgramAbiTypeCell, TypeDef, TypeDef | null]> = [];

    for (const [previous, replacement] of pending) {
      if (previousObjects.has(previous)) {
        throw new ProgramAbiInvariantError("type-remap-mismatch", "allocator type object was remapped more than once");
      }
      previousObjects.add(previous);
      const cell = this.typeCellsByObject.get(previous);
      if (!cell) {
        throw new ProgramAbiInvariantError(
          "foreign-type-object",
          "allocator type object does not belong to this ABI session",
        );
      }
      if (cell.current !== previous) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          "allocator type remap does not start at the cell's current object",
        );
      }
      if (replacement !== null) {
        const historicalOwner = this.typeCellsByObject.get(replacement);
        const pendingOwner = replacementOwners.get(replacement);
        if (
          (historicalOwner !== undefined && historicalOwner !== cell) ||
          (pendingOwner !== undefined && pendingOwner !== cell)
        ) {
          throw new ProgramAbiInvariantError(
            "ambiguous-type-remap",
            "allocator replacement type object would belong to multiple ABI cells",
          );
        }
        replacementOwners.set(replacement, cell);
      }
      validated.push([cell, previous, replacement]);
    }

    for (const [cell, , replacement] of validated) {
      cell.current = replacement;
      if (replacement !== null) this.typeCellsByObject.set(replacement, cell);
    }
  }

  /**
   * Apply one complete allocator/DCE type-layout event.
   *
   * The full old population distinguishes identity survivors from eliminated
   * slots, which a sparse "changed index" map cannot do. All contracts are
   * validated and remapped before any session-owned state changes.
   */
  applyTypeLayoutRemap(layout: ProgramAbiTypeLayoutRemap): void {
    this.assertOpen("apply a type layout remap");
    const { previousTypes, nextTypes, targetsByOldIndex } = layout;
    if (this.module.types !== previousTypes || targetsByOldIndex.length !== previousTypes.length) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        "type layout remap does not describe the session module's exact current type population",
      );
    }

    const targetOwners = new Map<number, number>();
    for (let oldIndex = 0; oldIndex < targetsByOldIndex.length; oldIndex++) {
      const target = targetsByOldIndex[oldIndex]!;
      if (target === null) continue;
      if (!Number.isSafeInteger(target) || target < 0 || target >= nextTypes.length) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `type layout remap sends old index ${oldIndex} to invalid final index ${target}`,
        );
      }
      const previousOwner = targetOwners.get(target);
      if (previousOwner !== undefined) {
        throw new ProgramAbiInvariantError(
          "ambiguous-type-remap",
          `old type indices ${previousOwner} and ${oldIndex} share final type index ${target}`,
        );
      }
      targetOwners.set(target, oldIndex);
    }
    if (targetOwners.size !== nextTypes.length) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        "type layout remap does not populate every final type index exactly once",
      );
    }
    for (let target = 0; target < nextTypes.length; target++) {
      if (!targetOwners.has(target)) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `type layout remap leaves final type index ${target} unowned`,
        );
      }
    }

    const remappedCallableContracts = new Map<IrBindingId, ProgramAbiCallableTypeContract>();
    for (const [id, contract] of this.callableTypeContracts) {
      remappedCallableContracts.set(
        id,
        Object.freeze({
          params: Object.freeze(contract.params.map((type) => remapProgramAbiValType(type, targetsByOldIndex, id))),
          results: Object.freeze(contract.results.map((type) => remapProgramAbiValType(type, targetsByOldIndex, id))),
        }),
      );
    }
    const remappedGlobalContracts = new Map<IrBindingId, ProgramAbiGlobalTypeContract>();
    for (const [id, contract] of this.globalTypeContracts) {
      remappedGlobalContracts.set(
        id,
        Object.freeze({
          type: remapProgramAbiValType(contract.type, targetsByOldIndex, id),
          mutable: contract.mutable,
        }),
      );
    }

    const objectRemaps = new Map<TypeDef, TypeDef | null>();
    for (let oldIndex = 0; oldIndex < previousTypes.length; oldIndex++) {
      const previous = previousTypes[oldIndex]!;
      if (!this.typeCellsByObject.has(previous)) continue;
      const target = targetsByOldIndex[oldIndex]!;
      const replacement = target === null ? null : nextTypes[target]!;
      const existing = objectRemaps.get(previous);
      if (existing !== undefined && existing !== replacement) {
        throw new ProgramAbiInvariantError(
          "ambiguous-type-remap",
          "one allocator type object occupies multiple old indices with different final targets",
        );
      }
      objectRemaps.set(previous, replacement);
    }
    this.remapTypeObjects([...objectRemaps].filter(([previous, replacement]) => previous !== replacement));

    this.callableTypeContracts.clear();
    for (const [id, contract] of remappedCallableContracts) this.callableTypeContracts.set(id, contract);
    this.globalTypeContracts.clear();
    for (const [id, contract] of remappedGlobalContracts) this.globalTypeContracts.set(id, contract);
  }

  attachLocator(id: IrBindingId, locator: ProgramAbiSlotLocator): void {
    this.assertOpen(`attach slot locator for ${id}`);
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new ProgramAbiInvariantError("unknown-locator-binding", `slot locator targets unplanned ABI draft ${id}`);
    }
    if (draft.slotPolicy !== "required") {
      throw new ProgramAbiInvariantError(
        "locator-not-required",
        `ABI draft ${id} has ${draft.slotPolicy} slot policy and cannot own a locator`,
      );
    }
    const actualSpace = locatorSpace(locator);
    if (
      draft.slotSpace !== actualSpace ||
      (locator.kind === "import-function" && locator.value.desc.kind !== "func") ||
      (locator.kind === "import-global" && locator.value.desc.kind !== "global")
    ) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `ABI draft ${id} requires ${draft.slotSpace} but received ${locator.kind}`,
      );
    }
    if (locator.kind === "type-cell" && !this.typeCells.has(locator.cell)) {
      throw new ProgramAbiInvariantError("foreign-type-cell", `type locator for ${id} belongs to another session`);
    }
    const object = locatorObject(locator);
    const previousOwner = this.locatorOwners.get(object);
    if (this.locators.has(id) || previousOwner !== undefined) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `allocator locator for ${id} is already owned by ${previousOwner ?? id}`,
      );
    }
    this.locators.set(id, Object.freeze({ ...locator }) as ProgramAbiSlotLocator);
    this.locatorOwners.set(object, id);
  }

  replaceDefinedFunctionLocator(id: IrBindingId, previous: WasmFunction, replacement: WasmFunction): void {
    const contract = this.callableTypeContracts.get(id);
    if (contract) this.assertFunctionTypeContract(id, replacement, contract, this.module);
    this.replaceDefinedLocator(id, "defined-function", previous, replacement);
  }

  replaceDefinedGlobalLocator(id: IrBindingId, previous: GlobalDef, replacement: GlobalDef): void {
    const contract = this.globalTypeContracts.get(id);
    if (contract) this.assertGlobalTypeContract(id, replacement.type, replacement.mutable, contract);
    this.replaceDefinedLocator(id, "defined-global", previous, replacement);
  }

  /**
   * Resolve one planned binding against the module's current, provisional
   * layout. Publication deliberately repeats exact-object resolution after
   * index-space freeze and records that later result as authoritative.
   */
  resolveCurrentIndex(
    id: IrBindingId,
    expectedSpace: ProgramAbiSlotSpace,
    structuralReferenceKey: string,
    module: WasmModule = this.module,
  ): number {
    this.assertModule(module);
    this.assertStructuralReference(id, structuralReferenceKey, this.state === "open");
    if (this.state === "published") {
      const finalIndex = this.publishedValue!.abi.resolveFinalIndex(id);
      if (!finalIndex || finalIndex.space !== expectedSpace) {
        throw new ProgramAbiInvariantError(
          "final-index-space-mismatch",
          `published ABI binding ${id} does not resolve in ${expectedSpace} space`,
        );
      }
      return finalIndex.index;
    }
    this.assertOpen(`resolve current slot for ${id}`);
    const canonical = this.canonicalDraft(id);
    if (canonical.slotPolicy !== "required" || canonical.slotSpace !== expectedSpace) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `ABI binding ${id} does not resolve to a required ${expectedSpace} slot`,
      );
    }
    const locator = this.locators.get(canonical.id);
    if (!locator) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `ABI binding ${canonical.id} has no allocator locator`,
      );
    }
    if (locatorSpace(locator) !== expectedSpace) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `ABI binding ${canonical.id} owns ${locator.kind}, not ${expectedSpace}`,
      );
    }
    return this.resolveLocator(module, canonical.id, locator);
  }

  /**
   * Build, seal, bind, and complete the ABI exactly once.
   *
   * A failed publish closes the session too: callers must fix the producer and
   * rebuild the compilation instead of mutating a partially observed plan.
   */
  publish(module: WasmModule): PublishedProgramAbi {
    this.assertModule(module);
    if (this.state !== "open") {
      throw new ProgramAbiInvariantError(
        "session-publish-once",
        `ProgramAbiSession publish was already attempted (${this.state})`,
      );
    }
    this.state = "publishing";
    try {
      const abi = new ProgramAbiMap(this.inventory, [...this.derivedUnits.values()]);
      const drafts = [...this.drafts.values()].sort((a, b) => compareDrafts(this.sourceOrderById, a, b));
      const denseOrderBySource = new Map<IrSourceId, number>();
      for (const queuedDraft of drafts) {
        const draft = this.materializeTypeContract(queuedDraft, module);
        const { structuralOrder, ...planned } = draft;
        const declarationOrder = denseOrderBySource.get(structuralOrder.sourceId) ?? 0;
        denseOrderBySource.set(structuralOrder.sourceId, declarationOrder + 1);
        abi.plan({
          ...planned,
          order: {
            sourceOrder: this.sourceOrderById.get(structuralOrder.sourceId)!,
            declarationOrder,
          },
        } as ProgramAbiPlanEntry);
      }
      abi.sealPlan();

      for (const entry of abi.entries()) {
        if (entry.slotPolicy !== "required") continue;
        const locator = this.locators.get(entry.id);
        if (!locator) {
          throw new ProgramAbiInvariantError(
            "missing-required-locator",
            `required ABI binding ${entry.id} has no allocator locator`,
          );
        }
        abi.bindFinalIndex(entry.id, {
          space: entry.slotSpace,
          index: this.resolveLocator(module, entry.id, locator),
        });
      }
      abi.finishBinding();
      const publication = Object.freeze({
        abi,
        legacy: new LegacyAbiAdapter(abi),
      });
      this.publishedValue = publication;
      this.state = "published";
      return publication;
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  private materializeTypeContract(draft: ProgramAbiDraft, module: WasmModule): ProgramAbiDraft {
    if (draft.intent.kind === "callable") {
      const contract = this.callableTypeContractFor(draft);
      if (!contract) return draft;
      if (draft.slotPolicy === "required") {
        const locator = this.locators.get(draft.id);
        if (locator?.kind === "defined-function") {
          this.assertFunctionTypeContract(draft.id, locator.value, contract, module);
        } else if (locator?.kind === "import-function" && locator.value.desc.kind === "func") {
          this.assertFunctionTypeIndexContract(draft.id, locator.value.desc.typeIdx, contract, module);
        }
      }
      return cloneDraft({
        ...draft,
        intent: {
          ...draft.intent,
          signature: canonicalProgramAbiCallableTypeContract(contract),
        },
      });
    }
    if (draft.intent.kind === "global") {
      const contract = this.globalTypeContractFor(draft);
      if (!contract) return draft;
      if (draft.slotPolicy === "required") {
        const locator = this.locators.get(draft.id);
        if (locator?.kind === "defined-global") {
          this.assertGlobalTypeContract(draft.id, locator.value.type, locator.value.mutable, contract);
        } else if (locator?.kind === "import-global" && locator.value.desc.kind === "global") {
          this.assertGlobalTypeContract(draft.id, locator.value.desc.type, locator.value.desc.mutable, contract);
        }
      }
      return cloneDraft({
        ...draft,
        intent: {
          ...draft.intent,
          valueType: canonicalProgramAbiValType(contract.type),
          mutable: contract.mutable,
        },
      });
    }
    if ((draft.intent.kind === "type" || draft.intent.kind === "class") && draft.slotPolicy === "required") {
      const locator = this.locators.get(draft.id);
      if (locator?.kind !== "type-cell" || locator.cell.current === null) return draft;
      const shapeKey = canonicalProgramAbiTypeDef(locator.cell.current);
      return cloneDraft({
        ...draft,
        intent: draft.intent.kind === "type" ? { ...draft.intent, shapeKey } : { ...draft.intent, layoutKey: shapeKey },
      } as ProgramAbiDraft);
    }
    return draft;
  }

  private callableTypeContractFor(draft: ProgramAbiDraft): ProgramAbiCallableTypeContract | undefined {
    const own = this.callableTypeContracts.get(draft.id);
    if (own || draft.intent.kind !== "callable" || draft.slotPolicy !== "alias") return own;
    const canonical = this.canonicalDraft(draft.id);
    if (
      canonical.intent.kind !== "callable" ||
      !programAbiCallableSignaturesEqual(draft.intent.signature, canonical.intent.signature)
    ) {
      return undefined;
    }
    return this.callableTypeContracts.get(canonical.id);
  }

  private globalTypeContractFor(draft: ProgramAbiDraft): ProgramAbiGlobalTypeContract | undefined {
    const own = this.globalTypeContracts.get(draft.id);
    if (own || draft.intent.kind !== "global" || draft.slotPolicy !== "alias") return own;
    const canonical = this.canonicalDraft(draft.id);
    if (
      canonical.intent.kind !== "global" ||
      draft.intent.valueType !== canonical.intent.valueType ||
      draft.intent.mutable !== canonical.intent.mutable
    ) {
      return undefined;
    }
    return this.globalTypeContracts.get(canonical.id);
  }

  private assertFunctionTypeContract(
    id: IrBindingId,
    func: WasmFunction,
    contract: ProgramAbiCallableTypeContract,
    module: WasmModule,
  ): void {
    this.assertFunctionTypeIndexContract(id, func.typeIdx, contract, module);
  }

  private assertFunctionTypeIndexContract(
    id: IrBindingId,
    typeIdx: number,
    contract: ProgramAbiCallableTypeContract,
    module: WasmModule,
  ): void {
    const actual = module.types[typeIdx];
    if (
      !actual ||
      actual.kind !== "func" ||
      !programAbiCallableSignaturesEqual(
        canonicalProgramAbiCallableTypeContract(contract),
        canonicalProgramAbiCallableTypeContract(actual),
      )
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `callable ABI binding ${id} does not match final function type ${typeIdx}`,
      );
    }
  }

  private assertGlobalTypeContract(
    id: IrBindingId,
    type: ValType,
    mutable: boolean,
    contract: ProgramAbiGlobalTypeContract,
  ): void {
    if (
      mutable !== contract.mutable ||
      canonicalProgramAbiValType(type) !== canonicalProgramAbiValType(contract.type)
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `global ABI binding ${id} does not match its final storage type`,
      );
    }
  }

  private assertOpen(action: string): void {
    if (this.state !== "open") {
      throw new ProgramAbiInvariantError(
        "session-closed",
        `cannot ${action} after ProgramAbiSession left planning state (${this.state})`,
      );
    }
  }

  private assertStructuralReference(id: IrBindingId, key: string, record: boolean): void {
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new ProgramAbiInvariantError("unknown-binding", `structural reference targets unplanned ABI draft ${id}`);
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `ABI binding ${id} received an invalid structural reference key`,
      );
    }
    const canonicalKey = draft.structuralReferenceKey;
    if (canonicalKey === undefined) {
      throw new ProgramAbiInvariantError(
        "missing-binding-reference",
        `ABI binding ${id} did not plan canonical structural reference metadata`,
      );
    }
    const previous = this.structuralReferenceKeys.get(id);
    if (canonicalKey !== key || (previous !== undefined && previous !== key)) {
      throw new ProgramAbiInvariantError(
        "binding-reference-mismatch",
        `ABI binding ${id} does not match the supplied structural reference payload`,
      );
    }
    if (record) this.structuralReferenceKeys.set(id, key);
  }

  private canonicalDraft(id: IrBindingId): ProgramAbiDraft {
    let current = this.drafts.get(id);
    if (!current) throw new ProgramAbiInvariantError("unknown-binding", `ABI binding ${id} was not planned`);
    const visited = new Set<IrBindingId>();
    while (current.slotPolicy === "alias") {
      if (visited.has(current.id)) {
        throw new ProgramAbiInvariantError("alias-cycle", `ABI draft alias cycle includes ${current.id}`);
      }
      visited.add(current.id);
      const target = this.drafts.get(current.aliasOf);
      if (!target) {
        throw new ProgramAbiInvariantError(
          "missing-alias-target",
          `ABI draft alias ${current.id} targets unplanned binding ${current.aliasOf}`,
        );
      }
      current = target;
    }
    return current;
  }

  private replaceDefinedLocator<T extends WasmFunction | GlobalDef>(
    id: IrBindingId,
    kind: "defined-function" | "defined-global",
    previous: T,
    replacement: T,
  ): void {
    this.assertOpen(`replace slot locator for ${id}`);
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new ProgramAbiInvariantError("unknown-locator-binding", `slot locator targets unplanned ABI draft ${id}`);
    }
    const expectedSpace: ProgramAbiSlotSpace = kind === "defined-function" ? "function" : "global";
    if (draft.slotPolicy !== "required" || draft.slotSpace !== expectedSpace) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `ABI draft ${id} does not own a required ${expectedSpace} locator`,
      );
    }
    const current = this.locators.get(id);
    if (!current) {
      throw new ProgramAbiInvariantError("missing-required-locator", `ABI binding ${id} has no allocator locator`);
    }
    if (current.kind !== kind || current.value !== previous || this.locatorOwners.get(previous) !== id) {
      throw new ProgramAbiInvariantError(
        "locator-remap-mismatch",
        `ABI binding ${id} does not own the supplied previous ${kind} object`,
      );
    }
    if (replacement === previous) return;
    const replacementOwner = this.locatorOwners.get(replacement);
    if (replacementOwner !== undefined) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `replacement allocator object for ${id} is already owned by ${replacementOwner}`,
      );
    }
    this.locatorOwners.delete(previous);
    this.locatorOwners.set(replacement, id);
    this.locators.set(
      id,
      Object.freeze({ kind, value: replacement }) as Extract<ProgramAbiSlotLocator, { readonly kind: typeof kind }>,
    );
  }

  private resolveLocator(module: WasmModule, id: IrBindingId, locator: ProgramAbiSlotLocator): number {
    if (locator.kind === "defined-function") {
      const position = this.uniqueObjectPosition(module.functions, locator.value);
      if (position >= 0) return this.importCount(module, "func") + position;
    } else if (locator.kind === "import-function") {
      const position = this.importPosition(module, locator.value, "func");
      if (position >= 0) return position;
    } else if (locator.kind === "defined-global") {
      const position = this.uniqueObjectPosition(module.globals, locator.value);
      if (position >= 0) return this.importCount(module, "global") + position;
    } else if (locator.kind === "import-global") {
      const position = this.importPosition(module, locator.value, "global");
      if (position >= 0) return position;
    } else {
      const current = locator.cell.current;
      if (current !== null) {
        const position = this.uniqueObjectPosition(module.types, current);
        if (position >= 0) return position;
      }
    }
    throw new ProgramAbiInvariantError(
      "eliminated-required-locator",
      `required ABI binding ${id} no longer has its allocator object in the published module`,
    );
  }

  private importCount(module: WasmModule, kind: "func" | "global"): number {
    let count = 0;
    for (const entry of module.imports) if (entry.desc.kind === kind) count++;
    return count;
  }

  private importPosition(module: WasmModule, target: Import, kind: "func" | "global"): number {
    let position = 0;
    let result = -1;
    for (const entry of module.imports) {
      if (entry.desc.kind !== kind) continue;
      if (entry === target) {
        if (result >= 0) {
          throw new ProgramAbiInvariantError(
            "duplicate-slot-locator",
            `allocator import object appears more than once in ${kind} space`,
          );
        }
        result = position;
      }
      position++;
    }
    return result;
  }

  private uniqueObjectPosition<T extends object>(values: readonly T[], target: T): number {
    const position = values.indexOf(target);
    if (position >= 0 && values.lastIndexOf(target) !== position) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        "allocator object appears more than once in one module index space",
      );
    }
    return position;
  }
}
