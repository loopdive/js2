// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  FuncHandle,
  FuncTypeDef,
  GlobalDef,
  Import,
  TypeDef,
  ValType,
  WasmFunction,
  WasmModule,
} from "../ir/types.js";
import type { IrBindingId, IrClassId, IrSourceId, IrUnitId, IrUnitInventory } from "../ir/identity.js";
import { irUnitCallableBindingId } from "../ir/callable-bindings.js";
import { arePairedIrModuleGlobalBindingIds, irClassTypeRef } from "../ir/abi-bindings.js";
import {
  LegacyAbiAdapter,
  ProgramAbiInvariantError,
  ProgramAbiMap,
  type ProgramAbiDerivedUnitRecord,
  type ProgramAbiFinalIndex,
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
import { SHAPE_BRAND_FIELD } from "./shape-brand.js";
import { programAbiIntentsEqual } from "./program-abi-intent-equality.js";

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

interface PreparedImplicitConstructorSupportContract {
  readonly selfParamIndex: number;
  readonly parentInitFuncIdx?: FuncHandle;
  /**
   * (#3522) The exact containing terminal owner for a NESTED implicit
   * constructor, or `null`/absent for a top-level one.
   *
   * The preparer proves the containing owner belongs to the same transaction
   * before staging. Carrying the identity here keeps this guard fail-closed
   * and EXACT — it verifies the inventory records precisely the nesting the
   * caller claimed — instead of merely relaxing the old top-level-only
   * `terminalOwnerId === null` assumption into an unchecked allowance.
   */
  readonly containingTerminalOwnerId?: IrUnitId | null;
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

/**
 * Read-only evidence that the session's structural intentions were validated
 * and sealed. Final-index mutation remains private to ProgramAbiSession.
 */
export interface SealedProgramAbiPlan {
  readonly planningSealed: true;
  entries(): readonly ProgramAbiPlanEntry[];
  get(id: IrBindingId): ProgramAbiPlanEntry | undefined;
  canonicalId(id: IrBindingId): IrBindingId;
}

/**
 * Read-only ABI evidence for one prepared free-function component.
 *
 * Unlike {@link SealedProgramAbiPlan}, this seal leaves the containing session
 * open for unrelated direct-body producers. Its identities and reservations
 * are reconciled again at whole-program seal and publication.
 */
export interface SealedPreparedProgramAbiScope {
  readonly planningSealed: true;
  readonly scopeId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly bindingIds: readonly IrBindingId[];
  entries(): readonly ProgramAbiPlanEntry[];
  get(id: IrBindingId): ProgramAbiPlanEntry | undefined;
  canonicalId(id: IrBindingId): IrBindingId;
}

type PreparedScopeTransactionState = "open" | "sealed" | "aborted";

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

/**
 * One-shot discovery transaction for the ABI dependencies of one prepared
 * component. Failed sealing and explicit abort publish no partial scope.
 */
export class PreparedProgramAbiScopeTransaction {
  readonly #bindingIds = new Set<IrBindingId>();
  readonly #borrowedBindings = new Map<IrBindingId, PreparedProgramAbiBorrowedBindingEvidence>();
  readonly #sealScope: (
    bindingIds: ReadonlySet<IrBindingId>,
    borrowedBindings: ReadonlyMap<IrBindingId, PreparedProgramAbiBorrowedBindingEvidence>,
  ) => SealedPreparedProgramAbiScope;
  readonly #abortScope: () => void;
  #state: PreparedScopeTransactionState = "open";

  constructor(
    readonly scopeId: string,
    readonly terminalUnitIds: readonly IrUnitId[],
    sealScope: (
      bindingIds: ReadonlySet<IrBindingId>,
      borrowedBindings: ReadonlyMap<IrBindingId, PreparedProgramAbiBorrowedBindingEvidence>,
    ) => SealedPreparedProgramAbiScope,
    abortScope: () => void,
  ) {
    Object.freeze(this.terminalUnitIds);
    this.#sealScope = sealScope;
    this.#abortScope = abortScope;
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
    try {
      const sealed = this.#sealScope(this.#bindingIds, this.#borrowedBindings);
      this.#state = "sealed";
      return sealed;
    } catch (error) {
      this.#state = "aborted";
      throw error;
    }
  }

  abort(): void {
    this.#assertOpen("abort the prepared ABI scope");
    this.#state = "aborted";
    this.#abortScope();
  }

  #assertOpen(action: string): void {
    if (this.#state !== "open") {
      throw new ProgramAbiInvariantError(
        "session-closed",
        `cannot ${action} after prepared ABI scope ${this.scopeId} ${this.#state}`,
      );
    }
  }
}

type SessionState = "planning" | "sealing" | "sealed" | "binding" | "published" | "failed";

interface PreparedProgramAbiLocatorSnapshot {
  readonly kind: ProgramAbiSlotLocator["kind"];
  readonly object: object;
  readonly hostLinkage?: string;
}

interface PreparedProgramAbiScopeRecord {
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

function validOrdinal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isLeafFinalizationOnly(previousLayout: string, currentLayout: string): boolean {
  let previous: unknown;
  let current: unknown;
  try {
    previous = JSON.parse(previousLayout);
    current = JSON.parse(currentLayout);
  } catch {
    return false;
  }
  let changed = false;
  const compare = (left: unknown, right: unknown, key?: string): boolean => {
    if (left === right) return true;
    if (key === "final" && left === false && right === true) {
      changed = true;
      return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => compare(value, right[index]))
      );
    }
    if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (field) => Object.hasOwn(rightRecord, field) && compare(leftRecord[field], rightRecord[field], field),
      )
    );
  };
  return compare(previous, current) && changed;
}

function isTrailingShapeIdentityFieldOnly(
  previousLayout: string,
  currentLayout: string,
  fieldName: string,
  typeMatches: (type: Record<string, unknown>) => boolean,
): boolean {
  let previous: unknown;
  let current: unknown;
  try {
    previous = JSON.parse(previousLayout);
    current = JSON.parse(currentLayout);
  } catch {
    return false;
  }
  if (typeof previous !== "object" || previous === null || typeof current !== "object" || current === null) {
    return false;
  }
  const left = previous as Record<string, unknown>;
  const right = current as Record<string, unknown>;
  if (
    left.kind !== "struct" ||
    right.kind !== "struct" ||
    left.superTypeIdx !== right.superTypeIdx ||
    left.final !== right.final ||
    !Array.isArray(left.fields) ||
    !Array.isArray(right.fields)
  ) {
    return false;
  }
  const leftFields = left.fields;
  const rightFields = right.fields;
  if (
    rightFields.length !== leftFields.length + 1 ||
    !leftFields.every((field, index) => JSON.stringify(field) === JSON.stringify(rightFields[index]))
  ) {
    return false;
  }
  const brand = rightFields[rightFields.length - 1];
  if (typeof brand !== "object" || brand === null) return false;
  const field = brand as Record<string, unknown>;
  if (field.name !== fieldName || field.mutable !== false || typeof field.type !== "string") return false;
  try {
    const type = JSON.parse(field.type) as Record<string, unknown>;
    return typeMatches(type);
  } catch {
    return false;
  }
}

function isShapeStampingOnly(previousLayout: string, currentLayout: string): boolean {
  return isTrailingShapeIdentityFieldOnly(previousLayout, currentLayout, "$shape", (type) => type.kind === "i32");
}

function isShapeBrandingOnly(previousLayout: string, currentLayout: string): boolean {
  return isTrailingShapeIdentityFieldOnly(
    previousLayout,
    currentLayout,
    SHAPE_BRAND_FIELD,
    (type) => type.kind === "ref_null" && Number.isSafeInteger(type.typeIdx) && (type.typeIdx as number) >= 0,
  );
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

function remapProgramAbiTypeIndex(
  typeIdx: number,
  targetsByOldIndex: readonly (number | null)[],
  bindingId: IrBindingId,
): number {
  if (!Number.isSafeInteger(typeIdx) || typeIdx < 0 || typeIdx >= targetsByOldIndex.length) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `ABI binding ${bindingId} references type index ${typeIdx} outside the old type layout`,
    );
  }
  const target = targetsByOldIndex[typeIdx];
  if (target === null || target === undefined) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `ABI binding ${bindingId} references eliminated type index ${typeIdx}`,
    );
  }
  return target;
}

function remapProgramAbiTypeDef(
  type: TypeDef,
  targetsByOldIndex: readonly (number | null)[],
  bindingId: IrBindingId,
): TypeDef {
  switch (type.kind) {
    case "func":
      return {
        ...type,
        params: type.params.map((value) => remapProgramAbiValType(value, targetsByOldIndex, bindingId)),
        results: type.results.map((value) => remapProgramAbiValType(value, targetsByOldIndex, bindingId)),
      };
    case "struct":
      return {
        ...type,
        fields: type.fields.map((field) => ({
          ...field,
          type: remapProgramAbiValType(field.type, targetsByOldIndex, bindingId),
        })),
        ...(type.superTypeIdx === undefined || type.superTypeIdx < 0
          ? {}
          : { superTypeIdx: remapProgramAbiTypeIndex(type.superTypeIdx, targetsByOldIndex, bindingId) }),
      };
    case "array":
      return {
        ...type,
        element: remapProgramAbiValType(type.element, targetsByOldIndex, bindingId),
      };
    case "rec":
      return {
        ...type,
        types: type.types.map((nested) => remapProgramAbiTypeDef(nested, targetsByOldIndex, bindingId)),
      };
    case "sub":
      return {
        ...type,
        superType:
          type.superType === null ? null : remapProgramAbiTypeIndex(type.superType, targetsByOldIndex, bindingId),
        type: remapProgramAbiTypeDef(type.type, targetsByOldIndex, bindingId) as typeof type.type,
      };
  }
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
    programAbiIntentsEqual(a.intent, b.intent)
  );
}

function planEntriesEqualIgnoringDenseOrder(a: ProgramAbiPlanEntry, b: ProgramAbiPlanEntry): boolean {
  const ar = a as ProgramAbiPlanEntry & {
    readonly aliasOf?: IrBindingId;
    readonly slotSpace?: ProgramAbiSlotSpace;
  };
  const br = b as ProgramAbiPlanEntry & {
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
    programAbiIntentsEqual(a.intent, b.intent)
  );
}

function bindingOwnerIs(id: IrBindingId, ownerId: IrUnitId | IrClassId): boolean {
  const prefix = "ir-binding:v1:";
  if (!id.startsWith(prefix)) return false;
  const domainEnd = id.indexOf(":", prefix.length);
  if (domainEnd < 0) return false;
  const ownerEnd = id.indexOf(":", domainEnd + 1);
  if (ownerEnd < 0) return false;
  return id.slice(domainEnd + 1, ownerEnd) === encodeURIComponent(ownerId);
}

function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  return new Set(values);
}

function readonlyMap<K, V>(values: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new Map(values);
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

function createSealedProgramAbiPlanView(
  abi: ProgramAbiMap,
  currentEntries: () => readonly ProgramAbiPlanEntry[],
): SealedProgramAbiPlan {
  const canonicalIds = new Map(abi.entries().map((entry) => [entry.id, abi.canonicalId(entry.id)] as const));
  return Object.freeze({
    planningSealed: true as const,
    entries: currentEntries,
    get: (id: IrBindingId) => currentEntries().find((entry) => entry.id === id),
    canonicalId: (id: IrBindingId) => {
      const canonicalId = canonicalIds.get(id);
      if (canonicalId === undefined) {
        throw new ProgramAbiInvariantError("unknown-binding", `binding ${id} was not planned`);
      }
      return canonicalId;
    },
  });
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
  private readonly inventorySourceIds = new Set<IrSourceId>();
  private readonly inventoryUnitIds = new Set<IrUnitId>();
  private readonly inventoryClassIds = new Set<IrClassId>();
  private readonly preparedTerminalUnitIds = new Set<IrUnitId>();
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
  private readonly preparedScopes = new Map<string, PreparedProgramAbiScopeRecord>();
  private readonly preparedScopeByUnitId = new Map<IrUnitId, string>();
  private readonly preparedScopeByClassId = new Map<IrClassId, string>();
  private readonly preparedScopeIdsByBindingId = new Map<IrBindingId, Set<string>>();
  private readonly preparedImplicitConstructorSupportContracts = new Map<
    IrUnitId,
    PreparedImplicitConstructorSupportContract
  >();
  private readonly openPreparedScopeIds = new Set<string>();
  private applyingPreparedTypeLayoutRemap = false;
  private state: SessionState = "planning";
  private sealedDrafts: readonly ProgramAbiDraft[] | undefined;
  private sealedPlanView: SealedProgramAbiPlan | undefined;
  private publishedValue: PublishedProgramAbi | undefined;
  readonly structuralOrder: ProgramAbiStructuralOrder;

  constructor(
    readonly inventory: IrUnitInventory,
    readonly module: WasmModule,
  ) {
    for (const source of inventory.sources) {
      this.sourceOrderById.set(source.id, source.order);
      this.inventorySourceIds.add(source.id);
    }
    for (const unit of inventory.allUnits) this.inventoryUnitIds.add(unit.id);
    for (const classRecord of inventory.classes) this.inventoryClassIds.add(classRecord.id);
    for (const unit of inventory.terminalUnits) this.preparedTerminalUnitIds.add(unit.id);
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

  /** Record the exact AST-free body contract for one implicit constructor support unit. */
  recordPreparedImplicitConstructorSupport(
    unitId: IrUnitId,
    contract: PreparedImplicitConstructorSupportContract,
  ): void {
    this.assertPlanning(`record implicit constructor support ${unitId}`);
    const unit = this.inventory.allUnits.find(({ id }) => id === unitId);
    if (
      unit?.kind !== "class-implicit-constructor" ||
      unit.terminalOwnerId !== (contract.containingTerminalOwnerId ?? null) ||
      contract.selfParamIndex < 0 ||
      !Number.isInteger(contract.selfParamIndex)
    ) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `implicit constructor support ${unitId} has no exact non-terminal inventory contract`,
      );
    }
    const existing = this.preparedImplicitConstructorSupportContracts.get(unitId);
    if (
      existing &&
      (existing.selfParamIndex !== contract.selfParamIndex ||
        existing.parentInitFuncIdx !== contract.parentInitFuncIdx ||
        (existing.containingTerminalOwnerId ?? null) !== (contract.containingTerminalOwnerId ?? null))
    ) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `implicit constructor support ${unitId} was prepared with a different forwarding contract`,
      );
    }
    if (!existing) this.preparedImplicitConstructorSupportContracts.set(unitId, Object.freeze({ ...contract }));
  }

  get publication(): PublishedProgramAbi | undefined {
    return this.publishedValue;
  }

  /**
   * Start exact dependency discovery for one prepared executable component.
   *
   * Source and derived callables are inferred from terminal ownership. The
   * caller adds only already-discovered external/support dependencies; alias
   * and export closure is derived by the session when the transaction seals.
   */
  beginPreparedComponentScope(
    scopeId: string,
    terminalUnitIds: readonly IrUnitId[],
  ): PreparedProgramAbiScopeTransaction {
    this.assertPlanning(`begin prepared ABI scope ${scopeId}`);
    if (scopeId.length === 0 || this.preparedScopes.has(scopeId) || this.openPreparedScopeIds.has(scopeId)) {
      throw new ProgramAbiInvariantError(
        "duplicate-session-draft",
        `prepared ABI scope ID ${scopeId || "<empty>"} is invalid or already owned`,
      );
    }
    const exactTerminalUnitIds = Object.freeze([...terminalUnitIds]);
    if (exactTerminalUnitIds.length === 0 || new Set(exactTerminalUnitIds).size !== exactTerminalUnitIds.length) {
      throw new ProgramAbiInvariantError(
        "invalid-derived-unit",
        `prepared ABI scope ${scopeId} requires a non-empty unique terminal denominator`,
      );
    }
    for (const unitId of exactTerminalUnitIds) {
      if (!this.preparedTerminalUnitIds.has(unitId)) {
        throw new ProgramAbiInvariantError(
          "unknown-inventory-unit",
          `prepared ABI scope ${scopeId} references an unknown terminal ${unitId}`,
        );
      }
      const owner = this.preparedScopeByUnitId.get(unitId);
      if (owner !== undefined) {
        throw new ProgramAbiInvariantError(
          "duplicate-session-draft",
          `prepared ABI terminal ${unitId} is already sealed by scope ${owner}`,
        );
      }
    }

    this.openPreparedScopeIds.add(scopeId);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      this.openPreparedScopeIds.delete(scopeId);
    };
    return new PreparedProgramAbiScopeTransaction(
      scopeId,
      exactTerminalUnitIds,
      (bindingIds, borrowedBindings) => {
        try {
          return this.sealPreparedComponentScope(scopeId, exactTerminalUnitIds, bindingIds, borrowedBindings);
        } finally {
          close();
        }
      },
      close,
    );
  }

  hasPlan(id: IrBindingId): boolean {
    return this.drafts.has(id);
  }

  getDraft(id: IrBindingId): ProgramAbiDraft | undefined {
    return this.drafts.get(id);
  }

  /** Resolve every exact pre-publication ABI identity in structural plan order. */
  bindingIdsForStructuralReference(key: string): readonly IrBindingId[] {
    if (typeof key !== "string" || key.length === 0) return Object.freeze([]);
    return Object.freeze(
      [...this.drafts.values()]
        .filter((draft) => draft.structuralReferenceKey === key)
        .sort((left, right) => compareDrafts(this.sourceOrderById, left, right))
        .map((draft) => draft.id),
    );
  }

  hasKnownUnit(id: IrUnitId): boolean {
    return this.derivedUnits.has(id) || this.inventoryUnitIds.has(id);
  }

  registeredDerivedUnit(id: IrUnitId): ProgramAbiDerivedUnitRecord | undefined {
    return this.derivedUnits.get(id);
  }

  derivedUnitRecords(): IterableIterator<ProgramAbiDerivedUnitRecord> {
    return this.derivedUnits.values();
  }

  /**
   * Plan once or prove that a repeated producer observation is byte-for-byte
   * equivalent at the structural contract level.
   */
  ensurePlan(draft: ProgramAbiDraft): void {
    this.assertPlanning(`ensure plan ${draft.id}`);
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
    this.assertPlanning(`register structural reference for ${id}`);
    this.assertStructuralReference(id, key, true);
  }

  plan(draft: ProgramAbiDraft): void {
    this.assertPlanning(`plan ${draft.id}`);
    const preparedScopeId = this.preparedScopeAffectedByDraft(draft);
    if (preparedScopeId !== undefined) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `ABI draft ${draft.id} would mutate sealed prepared scope ${preparedScopeId}`,
      );
    }
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
    this.assertPlanning(`register derived unit ${record.id}`);
    const preparedScopeId =
      this.preparedScopeByUnitId.get(record.parentId) ??
      (record.terminalOwnerId === null ? undefined : this.preparedScopeByUnitId.get(record.terminalOwnerId));
    if (preparedScopeId !== undefined) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `derived unit ${record.id} would mutate sealed prepared scope ${preparedScopeId}`,
      );
    }
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
    this.assertPlanning(`register callable type contract for ${id}`);
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
    const preparedScopeId = this.preparedScopeForBinding(id);
    if (preparedScopeId !== undefined) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `callable type contract for ${id} was requested after prepared scope ${preparedScopeId} sealed`,
      );
    }
    this.callableTypeContracts.set(id, contract);
  }

  /** Retain one structured global storage contract through type compaction. */
  registerGlobalTypeContract(id: IrBindingId, type: ValType, mutable: boolean): void {
    this.assertPlanning(`register global type contract for ${id}`);
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
    const preparedScopeId = this.preparedScopeForBinding(id);
    if (preparedScopeId !== undefined) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `global type contract for ${id} was requested after prepared scope ${preparedScopeId} sealed`,
      );
    }
    this.globalTypeContracts.set(id, Object.freeze({ type: cloneProgramAbiValType(type), mutable }));
  }

  createTypeCell(type: TypeDef): ProgramAbiTypeCell {
    this.assertPlanning("create a type cell");
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
    this.assertLayoutMutable("remap a type cell");
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
    this.assertLayoutMutable("remap type objects");
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
      const preparedScopeId = this.preparedScopeForTypeCell(cell);
      if (preparedScopeId !== undefined && !this.applyingPreparedTypeLayoutRemap) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `prepared type cell belongs to sealed scope ${preparedScopeId} and may change only through an exact layout remap`,
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
    this.assertLayoutMutable("apply a type layout remap");
    const { previousTypes, nextTypes, targetsByOldIndex } = layout;
    if (this.module.types !== previousTypes || targetsByOldIndex.length !== previousTypes.length) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        "type layout remap does not describe the session module's exact current type population",
      );
    }
    this.assertPreparedTypeLayoutsCurrent();

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
    this.assertPreparedTypeLayoutRemap(previousTypes, nextTypes, targetsByOldIndex);

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
    this.applyingPreparedTypeLayoutRemap = true;
    try {
      this.remapTypeObjects([...objectRemaps].filter(([previous, replacement]) => previous !== replacement));
    } finally {
      this.applyingPreparedTypeLayoutRemap = false;
    }

    this.callableTypeContracts.clear();
    for (const [id, contract] of remappedCallableContracts) this.callableTypeContracts.set(id, contract);
    this.globalTypeContracts.clear();
    for (const [id, contract] of remappedGlobalContracts) this.globalTypeContracts.set(id, contract);
    const remappedTypeDrafts = new Map<IrBindingId, ProgramAbiDraft>();
    for (const scope of this.preparedScopes.values()) {
      for (const id of scope.callableTypeContracts.keys()) {
        const draft = this.drafts.get(id);
        const contract = draft === undefined ? undefined : this.callableTypeContractFor(draft);
        if (contract) scope.callableTypeContracts.set(id, cloneProgramAbiCallableTypeContract(contract));
      }
      for (const id of scope.globalTypeContracts.keys()) {
        const draft = this.drafts.get(id);
        const contract = draft === undefined ? undefined : this.globalTypeContractFor(draft);
        if (contract) {
          scope.globalTypeContracts.set(
            id,
            Object.freeze({ type: cloneProgramAbiValType(contract.type), mutable: contract.mutable }),
          );
        }
      }
      for (const id of scope.typeLayouts.keys()) {
        const locator = this.locators.get(id);
        if (locator?.kind === "type-cell" && locator.cell.current !== null) {
          const currentLayout = canonicalProgramAbiTypeDef(locator.cell.current);
          scope.typeLayouts.set(id, currentLayout);
          const draft = this.drafts.get(id);
          if (draft?.intent.kind === "type") {
            remappedTypeDrafts.set(id, { ...draft, intent: { ...draft.intent, shapeKey: currentLayout } });
          } else if (draft?.intent.kind === "class") {
            remappedTypeDrafts.set(id, { ...draft, intent: { ...draft.intent, layoutKey: currentLayout } });
          }
        }
      }
      const remappedReachableLayouts = new Map<number, string>();
      for (const oldIndex of scope.reachableTypeLayouts.keys()) {
        const target = targetsByOldIndex[oldIndex];
        if (target === null || target === undefined || !nextTypes[target]) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `prepared type graph for scope ${scope.scopeId} was eliminated after validation`,
          );
        }
        remappedReachableLayouts.set(target, canonicalProgramAbiTypeDef(nextTypes[target]!));
      }
      scope.reachableTypeLayouts.clear();
      for (const [index, layoutValue] of remappedReachableLayouts) {
        scope.reachableTypeLayouts.set(index, layoutValue);
      }
    }
    for (const [id, draft] of remappedTypeDrafts) this.drafts.set(id, draft);
    for (const scope of this.preparedScopes.values()) {
      for (const [id, draft] of remappedTypeDrafts) {
        if (scope.drafts.has(id)) scope.drafts.set(id, cloneDraft(draft));
      }
    }
  }

  /**
   * Record the deterministic trailing identity fields added to colliding
   * anonymous object layouts after prepared scopes are sealed.
   *
   * Both passes preserve every source field and index. Stamping appends an
   * i32 identity and cannot expand the reachable type graph. Branding appends
   * a nullable type reference, so it may make the deterministic backward
   * brand chain reachable. Accept only the exact transition reported by each
   * pass, then refresh prepared layout evidence before leaf finalization and
   * DCE.
   */
  recordShapeStamping(stampedTypeIndices: readonly number[]): void {
    this.recordTrailingShapeIdentity("shape stamping", stampedTypeIndices, isShapeStampingOnly, false);
  }

  recordShapeBranding(brandedTypeIndices: readonly number[]): void {
    this.recordTrailingShapeIdentity("shape branding", brandedTypeIndices, isShapeBrandingOnly, true);
  }

  private recordTrailingShapeIdentity(
    operation: string,
    affectedTypeIndices: readonly number[],
    mutationMatches: (previousLayout: string, currentLayout: string) => boolean,
    allowReachableExpansion: boolean,
  ): void {
    this.assertLayoutMutable(`record ${operation}`);
    if (affectedTypeIndices.length === 0 || this.preparedScopes.size === 0) return;
    const affected = new Set(affectedTypeIndices);
    for (const index of affected) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.module.types.length) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `${operation} reports invalid module type index ${index}`,
        );
      }
    }

    const refreshedDrafts = new Map<IrBindingId, ProgramAbiDraft>();
    const refreshed: Array<{
      readonly scope: PreparedProgramAbiScopeRecord;
      readonly typeLayouts: Map<IrBindingId, string>;
      readonly reachableTypeLayouts: Map<number, string>;
    }> = [];
    for (const scope of this.preparedScopes.values()) {
      const typeLayouts = new Map(scope.typeLayouts);
      for (const [id, expectedLayout] of scope.typeLayouts) {
        const locator = this.locators.get(id);
        if (locator?.kind !== "type-cell" || locator.cell.current === null) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `${operation} changed explicit prepared type/class binding ${id}`,
          );
        }
        const currentLayout = canonicalProgramAbiTypeDef(locator.cell.current);
        if (currentLayout === expectedLayout) continue;
        const draft = this.drafts.get(id);
        const index = this.module.types.indexOf(locator.cell.current);
        if (
          (draft?.intent.kind !== "type" && draft?.intent.kind !== "class") ||
          index < 0 ||
          !affected.has(index) ||
          !mutationMatches(expectedLayout, currentLayout)
        ) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `${operation} changed explicit prepared type/class binding ${id}`,
          );
        }
        typeLayouts.set(id, currentLayout);
        const refreshedDraft: ProgramAbiDraft =
          draft.intent.kind === "type"
            ? { ...draft, intent: { ...draft.intent, shapeKey: currentLayout } }
            : { ...draft, intent: { ...draft.intent, layoutKey: currentLayout } };
        const previousRefresh = refreshedDrafts.get(id);
        if (previousRefresh && !draftsEqual(previousRefresh, refreshedDraft)) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `${operation} produced conflicting prepared draft refreshes for ${id}`,
          );
        }
        refreshedDrafts.set(id, refreshedDraft);
      }

      const currentReachableTypeLayouts = this.collectPreparedReachableTypeLayouts(
        this.module,
        typeLayouts.keys(),
        scope.callableTypeContracts,
        scope.globalTypeContracts,
      );
      for (const [index, expectedLayout] of scope.reachableTypeLayouts) {
        const currentLayout = currentReachableTypeLayouts.get(index);
        if (currentLayout === undefined) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `${operation} removed prepared reachable type ${index}`,
          );
        }
        if (currentLayout === expectedLayout) continue;
        if (!affected.has(index) || !mutationMatches(expectedLayout, currentLayout)) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `${operation} changed prepared reachable type ${index} outside its trailing-field contract`,
          );
        }
      }
      const addedReachableTypeIndices = [...currentReachableTypeLayouts.keys()].filter(
        (index) => !scope.reachableTypeLayouts.has(index),
      );
      if (!allowReachableExpansion && addedReachableTypeIndices.length > 0) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `${operation} expanded the reachable type graph for prepared scope ${scope.scopeId}`,
        );
      }
      refreshed.push({ scope, typeLayouts, reachableTypeLayouts: currentReachableTypeLayouts });
    }
    for (const [id, draft] of refreshedDrafts) this.drafts.set(id, draft);
    for (const { scope, typeLayouts, reachableTypeLayouts } of refreshed) {
      for (const [id, draft] of refreshedDrafts) {
        if (scope.drafts.has(id)) scope.drafts.set(id, cloneDraft(draft));
      }
      scope.typeLayouts.clear();
      for (const [id, layout] of typeLayouts) scope.typeLayouts.set(id, layout);
      scope.reachableTypeLayouts.clear();
      for (const [index, layout] of reachableTypeLayouts) scope.reachableTypeLayouts.set(index, layout);
    }
  }

  /**
   * Record the backend's deterministic leaf-struct finalization pass.
   *
   * Finality is a physical type property, so prepared scopes must not observe
   * it as an unexplained in-place mutation. This narrowly accepts only
   * `final: false -> true` changes at indices reported by
   * `markLeafStructsFinal`. Explicit support-type roots participate in the
   * same refresh because finality is a backend layout optimization applied
   * after scope sealing. Source class layouts use the same exact type cells,
   * so a reported leaf-only transition is safe for them as well.
   */
  recordLeafTypeFinalization(finalizedTypeIndices: readonly number[]): void {
    this.assertLayoutMutable("record leaf type finalization");
    if (finalizedTypeIndices.length === 0 || this.preparedScopes.size === 0) return;
    const finalized = new Set(finalizedTypeIndices);
    for (const index of finalized) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.module.types.length) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `leaf type finalization reports invalid module type index ${index}`,
        );
      }
    }

    const refreshedDrafts = new Map<IrBindingId, ProgramAbiDraft>();
    const refreshed: Array<{
      readonly scope: PreparedProgramAbiScopeRecord;
      readonly typeLayouts: Map<IrBindingId, string>;
      readonly reachableTypeLayouts: Map<number, string>;
    }> = [];
    for (const scope of this.preparedScopes.values()) {
      const typeLayouts = new Map(scope.typeLayouts);
      for (const [id, expectedLayout] of scope.typeLayouts) {
        const locator = this.locators.get(id);
        if (locator?.kind !== "type-cell" || locator.cell.current === null) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `leaf finalization changed explicit prepared type/class binding ${id}`,
          );
        }
        const currentLayout = canonicalProgramAbiTypeDef(locator.cell.current);
        if (currentLayout === expectedLayout) continue;
        const draft = this.drafts.get(id);
        const index = this.module.types.indexOf(locator.cell.current);
        if (
          (draft?.intent.kind !== "type" && draft?.intent.kind !== "class") ||
          index < 0 ||
          !finalized.has(index) ||
          !isLeafFinalizationOnly(expectedLayout, currentLayout)
        ) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `leaf finalization changed explicit prepared type/class binding ${id}`,
          );
        }
        typeLayouts.set(id, currentLayout);
        const refreshedDraft: ProgramAbiDraft =
          draft.intent.kind === "type"
            ? { ...draft, intent: { ...draft.intent, shapeKey: currentLayout } }
            : { ...draft, intent: { ...draft.intent, layoutKey: currentLayout } };
        const previousRefresh = refreshedDrafts.get(id);
        if (previousRefresh && !draftsEqual(previousRefresh, refreshedDraft)) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `leaf finalization produced conflicting prepared draft refreshes for ${id}`,
          );
        }
        refreshedDrafts.set(id, refreshedDraft);
      }
      const current = this.collectPreparedReachableTypeLayouts(
        this.module,
        scope.typeLayouts.keys(),
        scope.callableTypeContracts,
        scope.globalTypeContracts,
      );
      if (
        current.size !== scope.reachableTypeLayouts.size ||
        [...scope.reachableTypeLayouts.keys()].some((index) => !current.has(index))
      ) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `leaf finalization changed the reachable type denominator for prepared scope ${scope.scopeId}`,
        );
      }
      for (const [index, previousLayout] of scope.reachableTypeLayouts) {
        const currentLayout = current.get(index)!;
        if (currentLayout === previousLayout) continue;
        if (!finalized.has(index) || !isLeafFinalizationOnly(previousLayout, currentLayout)) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `leaf finalization changed prepared type ${index} beyond final: false -> true`,
          );
        }
      }
      refreshed.push({ scope, typeLayouts, reachableTypeLayouts: current });
    }
    for (const [id, draft] of refreshedDrafts) this.drafts.set(id, draft);
    for (const { scope, typeLayouts, reachableTypeLayouts } of refreshed) {
      for (const [id, draft] of refreshedDrafts) {
        if (scope.drafts.has(id)) scope.drafts.set(id, cloneDraft(draft));
      }
      scope.typeLayouts.clear();
      for (const [id, layout] of typeLayouts) scope.typeLayouts.set(id, layout);
      scope.reachableTypeLayouts.clear();
      for (const [index, layout] of reachableTypeLayouts) scope.reachableTypeLayouts.set(index, layout);
    }
  }

  attachLocator(id: IrBindingId, locator: ProgramAbiSlotLocator): void {
    this.assertPlanning(`attach slot locator for ${id}`);
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
    this.assertStructuralReference(id, structuralReferenceKey, this.state === "planning");
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
    this.assertLayoutMutable(`resolve current slot for ${id}`);
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
   * Materialize and seal the deterministic ABI intention map without binding
   * any concrete ModuleAssembler indices.
   *
   * Planning producers are closed after this boundary. Exact allocator
   * locators may still follow body replacement or layout compaction before
   * final binding.
   */
  sealPlan(module: WasmModule = this.module): SealedProgramAbiPlan {
    this.assertModule(module);
    if (this.state === "sealed" || this.state === "published") return this.sealedPlanView!;
    if (this.state !== "planning") {
      throw new ProgramAbiInvariantError(
        "session-closed",
        `ProgramAbiSession planning cannot be sealed from state ${this.state}`,
      );
    }
    if (this.openPreparedScopeIds.size > 0) {
      throw new ProgramAbiInvariantError(
        "planning-not-sealed",
        `ProgramAbiSession has open prepared ABI scopes: ${[...this.openPreparedScopeIds].join(", ")}`,
      );
    }
    this.state = "sealing";
    try {
      const drafts = [...this.drafts.values()].sort((a, b) => compareDrafts(this.sourceOrderById, a, b));
      const abi = this.buildSealedAbi(drafts, module);
      this.reconcilePreparedScopes(abi, module);
      for (const entry of abi.entries()) {
        if (entry.slotPolicy === "required" && !this.locators.has(entry.id)) {
          throw new ProgramAbiInvariantError(
            "missing-required-locator",
            `required ABI binding ${entry.id} has no allocator locator at the planning seal`,
          );
        }
      }
      this.sealedDrafts = Object.freeze([...drafts]);
      const view = createSealedProgramAbiPlanView(abi, () =>
        this.buildSealedAbi(this.sealedDrafts!, this.module).entries(),
      );
      this.sealedPlanView = view;
      this.state = "sealed";
      return view;
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  /**
   * Resolve the sealed plan against the module's final exact object layout,
   * bind every required index, and publish the compatibility view once.
   */
  bindAndPublish(module: WasmModule = this.module): PublishedProgramAbi {
    this.assertModule(module);
    if (this.state !== "sealed") {
      throw new ProgramAbiInvariantError(
        this.state === "planning" ? "planning-not-sealed" : "session-publish-once",
        `ProgramAbiSession final binding requires a sealed unpublished plan (${this.state})`,
      );
    }
    this.state = "binding";
    try {
      const abi = this.buildSealedAbi(this.sealedDrafts!, module);
      this.reconcilePreparedScopes(abi, module);
      const pendingBindings: Array<{
        readonly id: IrBindingId;
        readonly finalIndex: ProgramAbiFinalIndex;
      }> = [];
      const pendingOwners = new Map<string, IrBindingId>();
      for (const entry of abi.entries()) {
        if (entry.slotPolicy !== "required") continue;
        const locator = this.locators.get(entry.id);
        if (!locator) {
          throw new ProgramAbiInvariantError(
            "missing-required-locator",
            `required ABI binding ${entry.id} has no allocator locator`,
          );
        }
        const finalIndex: ProgramAbiFinalIndex = Object.freeze({
          space: entry.slotSpace,
          index: this.resolveLocator(module, entry.id, locator),
        });
        const key = `${finalIndex.space}:${finalIndex.index}`;
        const previousOwner = pendingOwners.get(key);
        if (previousOwner !== undefined) {
          throw new ProgramAbiInvariantError(
            "final-index-collision",
            `bindings ${previousOwner} and ${entry.id} cannot share non-alias index ${key}`,
          );
        }
        pendingOwners.set(key, entry.id);
        pendingBindings.push(Object.freeze({ id: entry.id, finalIndex }));
      }
      for (const binding of pendingBindings) abi.bindFinalIndex(binding.id, binding.finalIndex);
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

  /**
   * Compatibility wrapper that seals planning and publishes final bindings in
   * one call.
   *
   * A failed seal or publication closes the session: callers must fix the
   * producer and rebuild instead of mutating a partially observed plan.
   */
  publish(module: WasmModule): PublishedProgramAbi {
    this.assertModule(module);
    if (this.state !== "planning" && this.state !== "sealed") {
      throw new ProgramAbiInvariantError(
        "session-publish-once",
        `ProgramAbiSession publish was already attempted (${this.state})`,
      );
    }
    this.sealPlan(module);
    return this.bindAndPublish(module);
  }

  private sealPreparedComponentScope(
    scopeId: string,
    terminalUnitIds: readonly IrUnitId[],
    requestedBindingIds: ReadonlySet<IrBindingId>,
    borrowedBindings: ReadonlyMap<IrBindingId, PreparedProgramAbiBorrowedBindingEvidence>,
  ): SealedPreparedProgramAbiScope {
    this.assertPlanning(`seal prepared ABI scope ${scopeId}`);
    if (!this.openPreparedScopeIds.has(scopeId) || this.preparedScopes.has(scopeId)) {
      throw new ProgramAbiInvariantError(
        "session-closed",
        `prepared ABI scope ${scopeId} is not an open session transaction`,
      );
    }
    for (const terminalUnitId of terminalUnitIds) {
      const previous = this.preparedScopeByUnitId.get(terminalUnitId);
      if (previous !== undefined) {
        throw new ProgramAbiInvariantError(
          "duplicate-session-draft",
          `prepared ABI terminal ${terminalUnitId} is already sealed by scope ${previous}`,
        );
      }
    }
    for (const id of requestedBindingIds) {
      const draft = this.drafts.get(id);
      if (!draft) {
        throw new ProgramAbiInvariantError(
          "unknown-binding",
          `prepared ABI scope ${scopeId} requests unplanned binding ${id}`,
        );
      }
      this.assertPreparedDependencyRequest(scopeId, new Set(terminalUnitIds), draft, borrowedBindings.get(id));
    }

    const terminalUnitIdSet = new Set(terminalUnitIds);
    const unitIds = this.collectPreparedUnitIds(terminalUnitIdSet);
    const classIds = this.collectPreparedClassIds(terminalUnitIdSet);
    for (const unitId of unitIds) {
      const previous = this.preparedScopeByUnitId.get(unitId);
      if (previous !== undefined) {
        throw new ProgramAbiInvariantError(
          "duplicate-session-draft",
          `prepared ABI unit ${unitId} overlaps sealed scope ${previous}`,
        );
      }
    }
    for (const classId of classIds) {
      const previous = this.preparedScopeByClassId.get(classId);
      if (previous !== undefined) {
        throw new ProgramAbiInvariantError(
          "duplicate-session-draft",
          `prepared ABI class ${classId} overlaps sealed scope ${previous}`,
        );
      }
    }
    const derivedUnits = this.collectPreparedDerivedUnits(unitIds);
    const bindingIds = this.collectPreparedBindingClosure(unitIds, requestedBindingIds);
    for (const unitId of unitIds) {
      const callableReservations = [...bindingIds].filter((id) => {
        const draft = this.drafts.get(id)!;
        return (
          draft.intent.kind === "callable" &&
          draft.intent.origin === "source" &&
          draft.intent.unitId === unitId &&
          draft.slotPolicy === "required" &&
          draft.slotSpace === "function"
        );
      });
      const inventoryUnit = this.inventory.allUnits.find((unit) => unit.id === unitId);
      const requiresCallable = inventoryUnit?.terminal === true || this.derivedUnits.has(unitId);
      if (callableReservations.length > 1 || (requiresCallable && callableReservations.length !== 1)) {
        throw new ProgramAbiInvariantError(
          callableReservations.length === 0 ? "missing-source-unit" : "duplicate-session-draft",
          `prepared ABI scope ${scopeId} ${
            requiresCallable ? "requires exactly one" : "allows at most one existing"
          } callable reservation for executable unit ${unitId}; found ${callableReservations.length}`,
        );
      }
    }
    const bindingTerminalOwnerIds = new Map<IrBindingId, IrUnitId | null>();
    for (const id of bindingIds) {
      const draft = this.drafts.get(id)!;
      const ownerId = this.assertCanonicalPreparedBindingId(draft);
      const ownerTerminalId = this.terminalOwnerForPreparedDraft(draft, ownerId);
      bindingTerminalOwnerIds.set(id, ownerTerminalId);
      const borrowing = borrowedBindings.get(id);
      if (ownerTerminalId !== null && !terminalUnitIdSet.has(ownerTerminalId) && borrowing === undefined) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `prepared ABI scope ${scopeId} reaches binding ${id} structurally owned by terminal ${ownerTerminalId}`,
        );
      }
      if (
        draft.intent.kind === "callable" &&
        draft.intent.origin === "source" &&
        draft.intent.unitId !== undefined &&
        !unitIds.has(draft.intent.unitId) &&
        !this.isPreparedImplicitConstructorSupportDraft(draft)
      ) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `prepared ABI scope ${scopeId} reaches source callable ${id} owned by another component`,
        );
      }
      if (
        draft.intent.kind === "global" &&
        draft.intent.origin === "source" &&
        (draft.intent.unitId === undefined || !unitIds.has(draft.intent.unitId)) &&
        borrowing === undefined
      ) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `prepared ABI scope ${scopeId} reaches source global ${id} owned by another component`,
        );
      }
      const previousScope = this.preparedScopeForBinding(id);
      const structuralOwnerId = this.assertCanonicalPreparedBindingId(draft);
      const dependencyTerminalOwnerId = this.terminalOwnerForPreparedDraft(draft, structuralOwnerId);
      // Entry/runtime-owned dependencies are immutable compilation-wide
      // snapshots and may be consumed by more than one component. Anything
      // with a terminal source owner remains exclusive to that component.
      if (previousScope !== undefined && dependencyTerminalOwnerId !== null) {
        throw new ProgramAbiInvariantError(
          "duplicate-session-draft",
          `prepared ABI binding ${id} overlaps sealed scope ${previousScope}`,
        );
      }
    }

    const drafts = [...bindingIds]
      .map((id) => this.drafts.get(id)!)
      .sort((left, right) => compareDrafts(this.sourceOrderById, left, right));
    const scopedAbi = this.buildSealedAbi(drafts, this.module, derivedUnits);
    const locatorSnapshots = new Map<IrBindingId, PreparedProgramAbiLocatorSnapshot>();
    const structuralReferences = new Map<IrBindingId, string>();
    const callableTypeContracts = new Map<IrBindingId, ProgramAbiCallableTypeContract>();
    const globalTypeContracts = new Map<IrBindingId, ProgramAbiGlobalTypeContract>();
    const typeLayouts = new Map<IrBindingId, string>();

    for (const draft of drafts) {
      if (draft.intent.kind === "callable") {
        const contract = this.callableTypeContractFor(draft);
        if (!contract) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `prepared callable ${draft.id} has no structured type contract at scope seal`,
          );
        }
        callableTypeContracts.set(draft.id, cloneProgramAbiCallableTypeContract(contract));
      } else if (draft.intent.kind === "global") {
        const contract = this.globalTypeContractFor(draft);
        if (!contract) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `prepared global ${draft.id} has no structured storage contract at scope seal`,
          );
        }
        globalTypeContracts.set(
          draft.id,
          Object.freeze({ type: cloneProgramAbiValType(contract.type), mutable: contract.mutable }),
        );
      }
      if (draft.slotPolicy !== "required") continue;
      const locator = this.locators.get(draft.id);
      if (!locator) {
        throw new ProgramAbiInvariantError(
          "missing-required-locator",
          `prepared ABI binding ${draft.id} has no allocator locator at scope seal`,
        );
      }
      const structuralReference = draft.structuralReferenceKey;
      if (structuralReference === undefined || this.structuralReferenceKeys.get(draft.id) !== structuralReference) {
        throw new ProgramAbiInvariantError(
          "missing-binding-reference",
          `prepared ABI binding ${draft.id} has no observed structural reservation`,
        );
      }
      this.resolveLocator(this.module, draft.id, locator);
      if (locator.kind === "type-cell") {
        if (locator.cell.current === null) {
          throw new ProgramAbiInvariantError(
            "eliminated-required-locator",
            `prepared type/class binding ${draft.id} has an eliminated allocator cell at scope seal`,
          );
        }
        typeLayouts.set(draft.id, canonicalProgramAbiTypeDef(locator.cell.current));
      }
      const hostLinkage = this.preparedHostLinkage(locator);
      locatorSnapshots.set(
        draft.id,
        Object.freeze({
          kind: locator.kind,
          object: locatorObject(locator),
          ...(hostLinkage === undefined ? {} : { hostLinkage }),
        }),
      );
      structuralReferences.set(draft.id, structuralReference);
    }
    const reachableTypeLayouts = this.collectPreparedReachableTypeLayouts(
      this.module,
      typeLayouts.keys(),
      callableTypeContracts,
      globalTypeContracts,
    );

    const exactTerminalUnitIds = Object.freeze([...terminalUnitIds]);
    const exactDerivedUnits = Object.freeze(derivedUnits.map((record) => Object.freeze({ ...record })));
    const exactBindingIds = Object.freeze(drafts.map((draft) => draft.id));
    const canonicalIds = new Map(exactBindingIds.map((id) => [id, scopedAbi.canonicalId(id)] as const));
    const recordHolder: { value?: PreparedProgramAbiScopeRecord } = {};
    const currentRecord = (): PreparedProgramAbiScopeRecord => {
      if (!recordHolder.value) {
        throw new ProgramAbiInvariantError(
          "session-closed",
          `prepared ABI scope ${scopeId} was observed before atomic publication`,
        );
      }
      return recordHolder.value;
    };
    const view: SealedPreparedProgramAbiScope = Object.freeze({
      planningSealed: true as const,
      scopeId,
      terminalUnitIds: exactTerminalUnitIds,
      derivedUnits: exactDerivedUnits,
      bindingIds: exactBindingIds,
      entries: () => this.buildPreparedScopeAbi(currentRecord(), this.module).entries(),
      get: (id: IrBindingId) => this.buildPreparedScopeAbi(currentRecord(), this.module).get(id),
      canonicalId: (id: IrBindingId) => {
        const canonicalId = canonicalIds.get(id);
        if (canonicalId === undefined) {
          throw new ProgramAbiInvariantError(
            "unknown-binding",
            `binding ${id} is outside prepared ABI scope ${scopeId}`,
          );
        }
        return canonicalId;
      },
    });
    const record: PreparedProgramAbiScopeRecord = {
      scopeId,
      terminalUnitIds: exactTerminalUnitIds,
      unitIds: readonlySet(unitIds),
      classIds: readonlySet(classIds),
      derivedUnits: exactDerivedUnits,
      requestedBindingIds: readonlySet(requestedBindingIds),
      bindingIds: readonlySet(exactBindingIds),
      bindingTerminalOwnerIds: readonlyMap(bindingTerminalOwnerIds),
      drafts: new Map(drafts.map((draft) => [draft.id, cloneDraft(draft)] as const)),
      locators: readonlyMap(locatorSnapshots),
      structuralReferences: readonlyMap(structuralReferences),
      callableTypeContracts,
      globalTypeContracts,
      typeLayouts,
      reachableTypeLayouts,
      view,
    };
    recordHolder.value = record;

    // All validation above is side-effect free. Publish the scope only after
    // every identity, contract, reservation, and locator is known-good.
    this.preparedScopes.set(scopeId, record);
    for (const unitId of unitIds) this.preparedScopeByUnitId.set(unitId, scopeId);
    for (const classId of classIds) this.preparedScopeByClassId.set(classId, scopeId);
    for (const bindingId of exactBindingIds) this.addPreparedScopeBinding(bindingId, scopeId);
    return view;
  }

  private collectPreparedUnitIds(terminalUnitIds: ReadonlySet<IrUnitId>): Set<IrUnitId> {
    const included = new Set<IrUnitId>();
    for (const unit of this.inventory.allUnits) {
      const terminalOwnerId = this.terminalOwnerForKnownUnit(unit.id);
      if (terminalOwnerId !== null && terminalUnitIds.has(terminalOwnerId)) included.add(unit.id);
    }
    for (const terminalUnitId of terminalUnitIds) included.add(terminalUnitId);
    for (let changed = true; changed; ) {
      changed = false;
      for (const record of this.derivedUnits.values()) {
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

  private collectPreparedClassIds(terminalUnitIds: ReadonlySet<IrUnitId>): Set<IrClassId> {
    const included = new Set<IrClassId>();
    for (const classRecord of this.inventory.classes) {
      const terminalOwnerId = this.terminalOwnerForKnownClass(classRecord.id);
      if (terminalOwnerId !== null && terminalUnitIds.has(terminalOwnerId)) included.add(classRecord.id);
    }
    return included;
  }

  private collectPreparedDerivedUnits(unitIds: ReadonlySet<IrUnitId>): readonly ProgramAbiDerivedUnitRecord[] {
    const records: ProgramAbiDerivedUnitRecord[] = [];
    for (const record of this.derivedUnits.values()) if (unitIds.has(record.id)) records.push(record);
    return Object.freeze(
      records.sort((left, right) => {
        const leftDraft = [...this.drafts.values()].find(
          (draft) => draft.intent.kind === "callable" && draft.intent.unitId === left.id,
        );
        const rightDraft = [...this.drafts.values()].find(
          (draft) => draft.intent.kind === "callable" && draft.intent.unitId === right.id,
        );
        if (leftDraft && rightDraft) return compareDrafts(this.sourceOrderById, leftDraft, rightDraft);
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      }),
    );
  }

  private collectPreparedBindingClosure(
    unitIds: ReadonlySet<IrUnitId>,
    requestedBindingIds: ReadonlySet<IrBindingId>,
  ): Set<IrBindingId> {
    const included = new Set<IrBindingId>(requestedBindingIds);
    for (const draft of this.drafts.values()) {
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
        const draft = this.drafts.get(id);
        if (!draft) continue;
        const target = draft.slotPolicy === "alias" ? draft.aliasOf : undefined;
        if (target !== undefined && !included.has(target)) {
          included.add(target);
          changed = true;
        }
      }
      for (const draft of this.drafts.values()) {
        const pointsIntoScope = draft.slotPolicy === "alias" && included.has(draft.aliasOf);
        if (pointsIntoScope && !included.has(draft.id)) {
          included.add(draft.id);
          changed = true;
        }
      }
    }
    return included;
  }

  private assertPreparedDependencyRequest(
    scopeId: string,
    terminalUnitIds: ReadonlySet<IrUnitId>,
    draft: ProgramAbiDraft,
    borrowing?: PreparedProgramAbiBorrowedBindingEvidence,
  ): void {
    const ownerId = this.assertCanonicalPreparedBindingId(draft);
    if (borrowing) {
      this.assertPreparedBorrowedDependency(scopeId, terminalUnitIds, draft, borrowing);
      return;
    }
    const implicitConstructorSupport = this.isPreparedImplicitConstructorSupportDraft(draft);
    if (
      draft.intent.kind === "export" ||
      (draft.intent.kind === "callable" && draft.intent.origin === "source" && !implicitConstructorSupport)
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-callable-provenance",
        `prepared ABI scope ${scopeId} may request only external/support dependencies, not ${draft.intent.kind} binding ${draft.id}`,
      );
    }
    if (draft.intent.kind === "callable" && draft.intent.unitId) {
      const terminalOwnerId = this.terminalOwnerForKnownUnit(draft.intent.unitId);
      if (terminalOwnerId !== null && !terminalUnitIds.has(terminalOwnerId)) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `prepared ABI scope ${scopeId} requested callable ${draft.id} from terminal ${terminalOwnerId}`,
        );
      }
    }
    if (draft.intent.kind === "global" && draft.intent.origin === "source") {
      const terminalOwnerId =
        draft.intent.unitId === undefined ? null : this.terminalOwnerForKnownUnit(draft.intent.unitId);
      if (terminalOwnerId === null || !terminalUnitIds.has(terminalOwnerId)) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `prepared ABI scope ${scopeId} requested source global ${draft.id} from ${
            terminalOwnerId === null ? "no terminal owner" : `terminal ${terminalOwnerId}`
          }`,
        );
      }
    }
    const ownerTerminalId = this.terminalOwnerForStructuralOwner(ownerId);
    if (ownerTerminalId !== null && !terminalUnitIds.has(ownerTerminalId)) {
      throw new ProgramAbiInvariantError(
        "invalid-callable-provenance",
        `prepared ABI scope ${scopeId} requested dependency ${draft.id} owned by terminal ${ownerTerminalId}`,
      );
    }
  }

  /** Exact AST-free implicit `_init` body allowed as a shared prepared dependency. */
  private isPreparedImplicitConstructorSupportDraft(draft: ProgramAbiDraft): boolean {
    const intent = draft.intent;
    if (intent.kind !== "callable" || intent.origin !== "source" || !intent.unitId) return false;
    const unit = this.inventory.allUnits.find(({ id }) => id === intent.unitId);
    const locator = this.locators.get(draft.id);
    const contract = this.preparedImplicitConstructorSupportContracts.get(intent.unitId);
    if (
      unit?.kind !== "class-implicit-constructor" ||
      // (#3522) A top-level implicit constructor has no containing terminal; a
      // nested one records its enclosing executable. The recorded contract is
      // the authority for which of the two this unit is, so the nesting is
      // VERIFIED against the preparer's claim rather than assumed absent.
      unit.terminalOwnerId !== (contract?.containingTerminalOwnerId ?? null) ||
      locator?.kind !== "defined-function"
    ) {
      return false;
    }
    const func = locator.value;
    const signature = this.module.types[func.typeIdx];
    if (
      !contract ||
      func.locals.length !== 0 ||
      signature?.kind !== "func" ||
      signature.params.length !== contract.selfParamIndex + 1 ||
      signature.results.length !== 1 ||
      canonicalProgramAbiValType(signature.params[contract.selfParamIndex]!) !==
        canonicalProgramAbiValType(signature.results[0]!)
    ) {
      return false;
    }
    if (contract.parentInitFuncIdx === undefined) {
      return (
        contract.selfParamIndex === 0 &&
        func.body.length === 1 &&
        func.body[0]?.op === "local.get" &&
        func.body[0].index === 0
      );
    }
    if (func.body.length !== contract.selfParamIndex + 4) return false;
    for (let index = 0; index < contract.selfParamIndex; index++) {
      const instr = func.body[index];
      if (instr?.op !== "local.get" || instr.index !== index) return false;
    }
    const selfBeforeCall = func.body[contract.selfParamIndex];
    const parentCall = func.body[contract.selfParamIndex + 1];
    const dropParentResult = func.body[contract.selfParamIndex + 2];
    const returnedSelf = func.body[contract.selfParamIndex + 3];
    return (
      selfBeforeCall?.op === "local.get" &&
      selfBeforeCall.index === contract.selfParamIndex &&
      parentCall?.op === "call" &&
      parentCall.funcIdx === contract.parentInitFuncIdx &&
      dropParentResult?.op === "drop" &&
      returnedSelf?.op === "local.get" &&
      returnedSelf.index === contract.selfParamIndex
    );
  }

  private assertPreparedBorrowedDependency(
    scopeId: string,
    terminalUnitIds: ReadonlySet<IrUnitId>,
    draft: ProgramAbiDraft,
    borrowing: PreparedProgramAbiBorrowedBindingEvidence,
  ): void {
    if (
      borrowing.consumerUnitIds.length === 0 ||
      new Set(borrowing.consumerUnitIds).size !== borrowing.consumerUnitIds.length ||
      borrowing.consumerUnitIds.some((unitId) => !terminalUnitIds.has(unitId))
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-callable-provenance",
        `prepared ABI scope ${scopeId} borrowed ${draft.id} without a unique exact component consumer set`,
      );
    }
    const terminals = borrowing.consumerUnitIds.map((unitId) =>
      this.inventory.terminalUnits.find(({ id }) => id === unitId),
    );
    if (terminals.some((terminal) => !terminal || terminal.observedKind !== "class-member")) {
      throw new ProgramAbiInvariantError(
        "invalid-callable-provenance",
        `prepared ABI scope ${scopeId} borrowed ${draft.id} for a non-class terminal`,
      );
    }
    if (borrowing.kind === "nested-accessor-class-layout") {
      const classIntent = draft.intent.kind === "class" ? draft.intent : undefined;
      const canonicalClass = classIntent ? this.canonicalDraft(draft.id) : undefined;
      const classLocator = canonicalClass ? this.locators.get(canonicalClass.id) : undefined;
      const classType = classLocator?.kind === "type-cell" ? classLocator.cell.current : undefined;
      const classTypeIdx = classType ? this.module.types.indexOf(classType) : -1;
      const exactConsumers = terminals.every((terminal) => {
        if (!terminal || !classIntent) return false;
        const exactNestedMember =
          terminal.kind === "class-constructor" ||
          terminal.kind === "class-instance-method" ||
          terminal.kind === "class-instance-getter" ||
          terminal.kind === "class-static-getter" ||
          terminal.kind === "class-instance-setter" ||
          terminal.kind === "class-static-setter";
        const callableId = irUnitCallableBindingId(terminal.id);
        const requestedCallable = this.drafts.get(callableId);
        const callable = requestedCallable ? this.canonicalDraft(callableId) : undefined;
        const firstParam = callable?.intent.kind === "callable" ? callable.intent.signature.params[0] : undefined;
        let parsedFirstParam: { readonly kind?: unknown; readonly typeIdx?: unknown } | undefined;
        try {
          parsedFirstParam = firstParam === undefined ? undefined : JSON.parse(firstParam);
        } catch {
          parsedFirstParam = undefined;
        }
        return (
          exactNestedMember &&
          terminal.containingTerminalOwnerId !== undefined &&
          terminal.lexicalOwnerId === classIntent.classId &&
          this.terminalOwnerForKnownClass(classIntent.classId) === terminal.containingTerminalOwnerId &&
          classTypeIdx >= 0 &&
          requestedCallable?.intent.kind === "callable" &&
          requestedCallable.intent.origin === "source" &&
          requestedCallable.intent.unitId === terminal.id &&
          callable?.intent.kind === "callable" &&
          callable.intent.origin === "source" &&
          callable.intent.unitId === terminal.id &&
          (parsedFirstParam?.kind === "ref" || parsedFirstParam?.kind === "ref_null") &&
          parsedFirstParam.typeIdx === classTypeIdx
        );
      });
      if (!exactConsumers) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `prepared ABI scope ${scopeId} has no exact nested-accessor layout relation for ${draft.id}`,
        );
      }
      return;
    }

    if (terminals.length !== 1 || !terminals[0]) {
      throw new ProgramAbiInvariantError(
        "invalid-callable-provenance",
        `prepared ABI scope ${scopeId} borrowed setter binding ${draft.id} for ${terminals.length} consumers`,
      );
    }
    const terminal = terminals[0];
    const consumerUnitId = terminal.id;
    const setter = terminal.kind === "class-instance-setter" || terminal.kind === "class-static-setter";
    if (borrowing.kind === "class-setter-writeback-tdz-global") {
      const tdzIntent = draft.intent.kind === "global" && draft.intent.origin === "source" ? draft.intent : undefined;
      const value = this.drafts.get(borrowing.valueGlobalBindingId);
      const valueIntent =
        value?.intent.kind === "global" && value.intent.origin === "source" ? value.intent : undefined;
      const canonicalTdz = tdzIntent ? this.canonicalDraft(draft.id) : undefined;
      const canonicalValue = valueIntent ? this.canonicalDraft(borrowing.valueGlobalBindingId) : undefined;
      if (
        !setter ||
        terminal.lexicalOwnerId === null ||
        !tdzIntent ||
        !tdzIntent.mutable ||
        tdzIntent.valueType !== canonicalProgramAbiValType({ kind: "i32" }) ||
        !valueIntent ||
        !valueIntent.mutable ||
        !arePairedIrModuleGlobalBindingIds(borrowing.valueGlobalBindingId, draft.id) ||
        !canonicalValue ||
        !canonicalTdz ||
        !arePairedIrModuleGlobalBindingIds(canonicalValue.id, canonicalTdz.id) ||
        valueIntent.sourceId !== tdzIntent.sourceId ||
        valueIntent.unitId !== tdzIntent.unitId
      ) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `prepared ABI scope ${scopeId} has no exact setter TDZ contract for ${draft.id}`,
        );
      }
      return;
    }

    const callableId = irUnitCallableBindingId(consumerUnitId);
    const requestedCallable = this.drafts.get(callableId);
    const callable = requestedCallable ? this.canonicalDraft(callableId) : undefined;
    const requestedCarrier = this.drafts.get(borrowing.dynamicCarrierBindingId);
    const carrier = requestedCarrier ? this.canonicalDraft(borrowing.dynamicCarrierBindingId) : undefined;
    const sourceGlobalIntent =
      draft.intent.kind === "global" && draft.intent.origin === "source" ? draft.intent : undefined;
    const classId = terminal.lexicalOwnerId as IrClassId;
    const classBindingId = irClassTypeRef(classId, "<prepared-class>").binding.bindingId;
    const requestedClass = this.drafts.get(classBindingId);
    const classLayout = requestedClass ? this.canonicalDraft(classBindingId) : undefined;
    const classParamMatchesLayout = (): boolean => {
      if (
        requestedClass?.intent.kind !== "class" ||
        requestedClass.intent.classId !== classId ||
        classLayout?.intent.kind !== "class" ||
        classLayout.intent.classId !== classId ||
        callable?.intent.kind !== "callable"
      ) {
        return false;
      }
      const locator = this.locators.get(classLayout.id);
      const current = locator?.kind === "type-cell" ? locator.cell.current : undefined;
      const typeIdx = current ? this.module.types.indexOf(current) : -1;
      if (typeIdx < 0) return false;
      let parsed: { readonly kind?: unknown; readonly typeIdx?: unknown };
      try {
        parsed = JSON.parse(callable.intent.signature.params[0] ?? "") as typeof parsed;
      } catch {
        return false;
      }
      return (parsed.kind === "ref" || parsed.kind === "ref_null") && parsed.typeIdx === typeIdx;
    };
    const carrierMatchesValueType = (): boolean => {
      if (
        requestedCarrier?.intent.kind !== "type" ||
        carrier?.intent.kind !== "type" ||
        requestedCarrier.structuralReferenceKey === undefined
      ) {
        return false;
      }
      if (carrier.slotPolicy === "none") {
        return sourceGlobalIntent !== undefined && carrier.intent.shapeKey === sourceGlobalIntent.valueType;
      }
      const locator = this.locators.get(carrier.id);
      const current = locator?.kind === "type-cell" ? locator.cell.current : undefined;
      const typeIdx = current ? this.module.types.indexOf(current) : -1;
      if (typeIdx < 0) return false;
      let parsed: { readonly kind?: unknown; readonly typeIdx?: unknown };
      try {
        parsed = JSON.parse(sourceGlobalIntent?.valueType ?? "") as typeof parsed;
      } catch {
        return false;
      }
      if ((parsed.kind !== "ref" && parsed.kind !== "ref_null") || parsed.typeIdx !== typeIdx) return false;
      return canonicalProgramAbiValType({ kind: parsed.kind, typeIdx }) === sourceGlobalIntent?.valueType;
    };
    if (
      !setter ||
      terminal.lexicalOwnerId === null ||
      sourceGlobalIntent === undefined ||
      sourceGlobalIntent.mutable !== true ||
      sourceGlobalIntent.unitId === undefined ||
      requestedCallable?.intent.kind !== "callable" ||
      requestedCallable.intent.origin !== "source" ||
      requestedCallable.intent.unitId !== consumerUnitId ||
      requestedCallable.intent.signature.params.length !== 2 ||
      requestedCallable.intent.signature.params[1] !== sourceGlobalIntent.valueType ||
      requestedCallable.intent.signature.results.length !== 0 ||
      callable?.intent.kind !== "callable" ||
      callable.intent.origin !== "source" ||
      callable.intent.unitId !== consumerUnitId ||
      callable.intent.signature.params.length !== 2 ||
      callable.intent.signature.params[1] !== sourceGlobalIntent.valueType ||
      callable.intent.signature.results.length !== 0 ||
      !classParamMatchesLayout() ||
      !carrierMatchesValueType()
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-callable-provenance",
        `prepared ABI scope ${scopeId} has no exact dynamic setter writeback contract for ${draft.id}`,
      );
    }
  }

  private assertCanonicalPreparedBindingId(draft: ProgramAbiDraft): IrSourceId | IrUnitId | IrClassId {
    const parts = String(draft.id).split(":");
    if (parts.length !== 6 || parts[0] !== "ir-binding" || parts[1] !== "v1") {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `prepared ABI draft ${draft.id} does not use the canonical binding identity format`,
      );
    }
    const domain = parts[2]!;
    const encodedOwner = parts[3]!;
    const encodedRole = parts[4]!;
    const ordinal = parts[5]!;
    let ownerId: string;
    let role: string;
    try {
      ownerId = decodeURIComponent(encodedOwner);
      role = decodeURIComponent(encodedRole);
    } catch {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `prepared ABI draft ${draft.id} contains invalid encoded identity components`,
      );
    }
    const expectedDomain =
      draft.intent.kind === "callable"
        ? draft.intent.origin === "support"
          ? "support"
          : "callable"
        : draft.intent.kind;
    const ordinalValue = Number(ordinal);
    if (
      domain !== expectedDomain ||
      role.length === 0 ||
      encodeURIComponent(ownerId) !== encodedOwner ||
      encodeURIComponent(role) !== encodedRole ||
      !/^\d{16}$/.test(ordinal) ||
      !Number.isSafeInteger(ordinalValue) ||
      ordinalValue < 0 ||
      ordinalValue.toString(10).padStart(16, "0") !== ordinal
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `prepared ABI draft ${draft.id} is not canonical for its ${draft.intent.kind} intent`,
      );
    }
    const knownOwner =
      this.inventorySourceIds.has(ownerId as IrSourceId) ||
      this.inventoryUnitIds.has(ownerId as IrUnitId) ||
      this.derivedUnits.has(ownerId as IrUnitId) ||
      this.inventoryClassIds.has(ownerId as IrClassId);
    if (!knownOwner) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `prepared ABI draft ${draft.id} has unknown structural owner ${ownerId}`,
      );
    }
    const provenanceOwner =
      draft.intent.kind === "callable"
        ? (draft.intent.unitId ?? draft.intent.classId ?? draft.intent.sourceId)
        : draft.intent.kind === "global" && draft.intent.origin === "source"
          ? draft.intent.sourceId
          : draft.intent.kind === "class"
            ? draft.intent.classId
            : undefined;
    if (provenanceOwner !== undefined && provenanceOwner !== ownerId) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `prepared ABI draft ${draft.id} owner disagrees with its intent provenance`,
      );
    }
    if (draft.intent.kind === "global" && draft.intent.origin === "source") {
      const sourceId = draft.intent.sourceId;
      const storageOwnerUnitId = draft.intent.unitId;
      const storageOwner =
        storageOwnerUnitId === undefined
          ? undefined
          : (this.inventory.allUnits.find((unit) => unit.id === storageOwnerUnitId) ??
            this.derivedUnits.get(storageOwnerUnitId));
      if (
        sourceId === undefined ||
        storageOwnerUnitId === undefined ||
        storageOwner === undefined ||
        storageOwner.sourceId !== sourceId
      ) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `prepared ABI source global ${draft.id} has no exact same-source storage owner`,
        );
      }
    }
    return ownerId as IrSourceId | IrUnitId | IrClassId;
  }

  private terminalOwnerForKnownUnit(id: IrUnitId, visited = new Set<IrUnitId>()): IrUnitId | null {
    if (visited.has(id)) {
      throw new ProgramAbiInvariantError("invalid-callable-provenance", `unit ownership cycle includes ${id}`);
    }
    visited.add(id);
    const inventoryUnit = this.inventory.allUnits.find((unit) => unit.id === id);
    const directOwner = inventoryUnit?.terminalOwnerId ?? this.derivedUnits.get(id)?.terminalOwnerId ?? null;
    if (directOwner === null || directOwner === id) return directOwner;
    const ownerRecord =
      this.inventory.allUnits.find((unit) => unit.id === directOwner) ?? this.derivedUnits.get(directOwner);
    if (!ownerRecord) return directOwner;
    return this.terminalOwnerForKnownUnit(directOwner, visited);
  }

  private terminalOwnerForKnownClass(id: IrClassId, visited = new Set<IrClassId>()): IrUnitId | null {
    if (visited.has(id)) {
      throw new ProgramAbiInvariantError("invalid-callable-provenance", `class ownership cycle includes ${id}`);
    }
    visited.add(id);
    const record = this.inventory.classes.find((candidate) => candidate.id === id);
    if (!record || record.lexicalOwnerId === null) return null;
    if (this.inventoryClassIds.has(record.lexicalOwnerId as IrClassId)) {
      return this.terminalOwnerForKnownClass(record.lexicalOwnerId as IrClassId, visited);
    }
    return this.terminalOwnerForKnownUnit(record.lexicalOwnerId as IrUnitId);
  }

  private terminalOwnerForStructuralOwner(ownerId: IrSourceId | IrUnitId | IrClassId): IrUnitId | null {
    if (this.inventorySourceIds.has(ownerId as IrSourceId)) return null;
    if (this.inventoryClassIds.has(ownerId as IrClassId)) {
      return this.terminalOwnerForKnownClass(ownerId as IrClassId);
    }
    return this.terminalOwnerForKnownUnit(ownerId as IrUnitId);
  }

  private terminalOwnerForPreparedDraft(
    draft: ProgramAbiDraft,
    structuralOwnerId: IrSourceId | IrUnitId | IrClassId,
  ): IrUnitId | null {
    if (draft.intent.kind === "global" && draft.intent.origin === "source" && draft.intent.unitId !== undefined) {
      return this.terminalOwnerForKnownUnit(draft.intent.unitId);
    }
    return this.terminalOwnerForStructuralOwner(structuralOwnerId);
  }

  private preparedHostLinkage(locator: ProgramAbiSlotLocator): string | undefined {
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

  private preparedScopeForTypeCell(cell: ProgramAbiTypeCell): string | undefined {
    for (const scope of this.preparedScopes.values()) {
      for (const locator of scope.locators.values()) {
        if (locator.kind === "type-cell" && locator.object === cell) return scope.scopeId;
      }
    }
    return undefined;
  }

  private assertPreparedTypeLayoutsCurrent(): void {
    for (const scope of this.preparedScopes.values()) {
      for (const [id, expectedLayout] of scope.typeLayouts) {
        const locator = this.locators.get(id);
        if (
          locator?.kind !== "type-cell" ||
          locator.cell.current === null ||
          canonicalProgramAbiTypeDef(locator.cell.current) !== expectedLayout
        ) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `prepared type/class layout ${id} drifted before exact layout remapping`,
          );
        }
      }
      const currentReachableLayouts = this.collectPreparedReachableTypeLayouts(
        this.module,
        scope.typeLayouts.keys(),
        scope.callableTypeContracts,
        scope.globalTypeContracts,
      );
      if (
        currentReachableLayouts.size !== scope.reachableTypeLayouts.size ||
        [...scope.reachableTypeLayouts].some(([index, layout]) => currentReachableLayouts.get(index) !== layout)
      ) {
        const changed = [...scope.reachableTypeLayouts]
          .filter(([index, layout]) => currentReachableLayouts.get(index) !== layout)
          .map(([index]) => index);
        const added = [...currentReachableLayouts.keys()].filter((index) => !scope.reachableTypeLayouts.has(index));
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `prepared type graph for scope ${scope.scopeId} drifted before exact layout remapping ` +
            `(changed/missing: ${changed.slice(0, 8).join(",") || "none"}; added: ${added.slice(0, 8).join(",") || "none"})`,
        );
      }
    }
  }

  private collectPreparedReachableTypeLayouts(
    module: WasmModule,
    typeBindingIds: Iterable<IrBindingId>,
    callableContracts: ReadonlyMap<IrBindingId, ProgramAbiCallableTypeContract>,
    globalContracts: ReadonlyMap<IrBindingId, ProgramAbiGlobalTypeContract>,
  ): Map<number, string> {
    const roots = new Set<number>();
    const addValue = (value: ValType): void => {
      if (value.kind === "ref" || value.kind === "ref_null") roots.add(value.typeIdx);
    };
    for (const id of typeBindingIds) {
      const locator = this.locators.get(id);
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

  private assertPreparedTypeLayoutRemap(
    previousTypes: readonly TypeDef[],
    nextTypes: readonly TypeDef[],
    targetsByOldIndex: readonly (number | null)[],
  ): void {
    for (const scope of this.preparedScopes.values()) {
      for (const [oldIndex, pinnedLayout] of scope.reachableTypeLayouts) {
        const oldType = previousTypes[oldIndex];
        if (!oldType || canonicalProgramAbiTypeDef(oldType) !== pinnedLayout) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `prepared type graph for scope ${scope.scopeId} changed at old index ${oldIndex}`,
          );
        }
        const target = targetsByOldIndex[oldIndex];
        if (target === null || target === undefined || !nextTypes[target]) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `prepared type graph for scope ${scope.scopeId} eliminated old index ${oldIndex}`,
          );
        }
        const expectedLayout = canonicalProgramAbiTypeDef(
          remapProgramAbiTypeDef(oldType, targetsByOldIndex, scope.bindingIds.values().next().value!),
        );
        const actualLayout = canonicalProgramAbiTypeDef(nextTypes[target]);
        if (actualLayout !== expectedLayout) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `prepared type graph for scope ${scope.scopeId} changed reachable shape during an exact layout remap`,
          );
        }
      }
    }
  }

  private preparedScopeForBinding(id: IrBindingId): string | undefined {
    return this.preparedScopeIdsByBindingId.get(id)?.values().next().value;
  }

  private addPreparedScopeBinding(id: IrBindingId, scopeId: string): void {
    const scopeIds = this.preparedScopeIdsByBindingId.get(id) ?? new Set<string>();
    scopeIds.add(scopeId);
    this.preparedScopeIdsByBindingId.set(id, scopeIds);
  }

  private preparedScopeAffectedByDraft(draft: ProgramAbiDraft): string | undefined {
    const exactOwner = this.preparedScopeForBinding(draft.id);
    if (exactOwner !== undefined) return exactOwner;
    if (draft.intent.kind === "callable" && draft.intent.unitId) {
      const unitOwner = this.preparedScopeByUnitId.get(draft.intent.unitId);
      if (unitOwner !== undefined) return unitOwner;
    }
    if (draft.intent.kind === "callable" && draft.intent.classId) {
      const classOwner = this.preparedScopeByClassId.get(draft.intent.classId);
      if (classOwner !== undefined) return classOwner;
    }
    if (draft.intent.kind === "class") {
      const classOwner = this.preparedScopeByClassId.get(draft.intent.classId);
      if (classOwner !== undefined) return classOwner;
    }
    if (draft.slotPolicy === "alias") {
      const aliasOwner = this.preparedScopeForBinding(draft.aliasOf);
      if (aliasOwner !== undefined) return aliasOwner;
    }
    if (draft.intent.kind === "export") {
      const exportOwner = this.preparedScopeForBinding(draft.intent.targetId);
      if (exportOwner !== undefined) return exportOwner;
    }
    for (const [unitId, scopeId] of this.preparedScopeByUnitId) {
      if (bindingOwnerIs(draft.id, unitId)) return scopeId;
    }
    for (const [classId, scopeId] of this.preparedScopeByClassId) {
      if (bindingOwnerIs(draft.id, classId)) return scopeId;
    }
    return undefined;
  }

  private buildPreparedScopeAbi(record: PreparedProgramAbiScopeRecord, module: WasmModule): ProgramAbiMap {
    this.assertPreparedScopeCurrent(record, module);
    const drafts = [...record.bindingIds]
      .map((id) => this.drafts.get(id)!)
      .sort((left, right) => compareDrafts(this.sourceOrderById, left, right));
    return this.buildSealedAbi(drafts, module, record.derivedUnits);
  }

  private assertPreparedScopeCurrent(record: PreparedProgramAbiScopeRecord, module: WasmModule): void {
    const terminalUnitIds = new Set(record.terminalUnitIds);
    const unitIds = this.collectPreparedUnitIds(terminalUnitIds);
    if (unitIds.size !== record.unitIds.size || [...record.unitIds].some((id) => !unitIds.has(id))) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `source-unit ownership closure drifted after prepared ABI scope ${record.scopeId} sealed`,
      );
    }
    const classIds = this.collectPreparedClassIds(terminalUnitIds);
    if (classIds.size !== record.classIds.size || [...record.classIds].some((id) => !classIds.has(id))) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `class ownership closure drifted after prepared ABI scope ${record.scopeId} sealed`,
      );
    }
    const derivedUnits = this.collectPreparedDerivedUnits(unitIds);
    if (
      derivedUnits.length !== record.derivedUnits.length ||
      derivedUnits.some((current, index) => {
        const expected = record.derivedUnits[index]!;
        return (
          current.id !== expected.id ||
          current.parentId !== expected.parentId ||
          current.terminalOwnerId !== expected.terminalOwnerId ||
          current.sourceId !== expected.sourceId ||
          current.role !== expected.role ||
          current.ordinal !== expected.ordinal
        );
      })
    ) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `derived-unit closure drifted after prepared ABI scope ${record.scopeId} sealed`,
      );
    }
    const currentBindingIds = this.collectPreparedBindingClosure(record.unitIds, record.requestedBindingIds);
    if (
      currentBindingIds.size !== record.bindingIds.size ||
      [...record.bindingIds].some((id) => !currentBindingIds.has(id))
    ) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `binding closure drifted after prepared ABI scope ${record.scopeId} sealed`,
      );
    }
    for (const [id, expectedDraft] of record.drafts) {
      const currentDraft = this.drafts.get(id);
      if (!currentDraft || !draftsEqual(expectedDraft, currentDraft)) {
        throw new ProgramAbiInvariantError(
          "session-draft-mismatch",
          `ABI draft ${id} drifted after prepared scope ${record.scopeId} sealed`,
        );
      }
      const currentOwnerId = this.assertCanonicalPreparedBindingId(currentDraft);
      if (this.terminalOwnerForPreparedDraft(currentDraft, currentOwnerId) !== record.bindingTerminalOwnerIds.get(id)) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `ABI draft ${id} structural owner drifted after prepared scope ${record.scopeId} sealed`,
        );
      }
      const expectedLocator = record.locators.get(id);
      if (expectedLocator) {
        const locator = this.locators.get(id);
        if (!locator || locator.kind !== expectedLocator.kind || locatorObject(locator) !== expectedLocator.object) {
          throw new ProgramAbiInvariantError(
            "locator-remap-mismatch",
            `allocator locator for ${id} drifted after prepared scope ${record.scopeId} sealed`,
          );
        }
        if (this.preparedHostLinkage(locator) !== expectedLocator.hostLinkage) {
          throw new ProgramAbiInvariantError(
            "binding-reference-mismatch",
            `host linkage for ${id} drifted after prepared scope ${record.scopeId} sealed`,
          );
        }
        const expectedLayout = record.typeLayouts.get(id);
        if (
          expectedLayout !== undefined &&
          (locator.kind !== "type-cell" ||
            locator.cell.current === null ||
            canonicalProgramAbiTypeDef(locator.cell.current) !== expectedLayout)
        ) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `type/class layout for ${id} drifted after prepared scope ${record.scopeId} sealed`,
          );
        }
        const locatorCallable = record.callableTypeContracts.get(id);
        if (locatorCallable) {
          if (locator.kind === "defined-function") {
            this.assertFunctionTypeContract(id, locator.value, locatorCallable, module);
          } else if (locator.kind === "import-function" && locator.value.desc.kind === "func") {
            this.assertFunctionTypeIndexContract(id, locator.value.desc.typeIdx, locatorCallable, module);
          }
        }
        const locatorGlobal = record.globalTypeContracts.get(id);
        if (locatorGlobal) {
          if (locator.kind === "defined-global") {
            this.assertGlobalTypeContract(id, locator.value.type, locator.value.mutable, locatorGlobal);
          } else if (locator.kind === "import-global" && locator.value.desc.kind === "global") {
            this.assertGlobalTypeContract(id, locator.value.desc.type, locator.value.desc.mutable, locatorGlobal);
          }
        }
        this.resolveLocator(module, id, locator);
      }
      const expectedReference = record.structuralReferences.get(id);
      if (expectedReference !== undefined && this.structuralReferenceKeys.get(id) !== expectedReference) {
        throw new ProgramAbiInvariantError(
          "binding-reference-mismatch",
          `structural reservation for ${id} drifted after prepared scope ${record.scopeId} sealed`,
        );
      }
      const expectedCallable = record.callableTypeContracts.get(id);
      if (expectedCallable) {
        const currentCallable = this.callableTypeContractFor(currentDraft);
        if (
          !currentCallable ||
          !programAbiCallableSignaturesEqual(
            canonicalProgramAbiCallableTypeContract(expectedCallable),
            canonicalProgramAbiCallableTypeContract(currentCallable),
          )
        ) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `callable type contract for ${id} drifted after prepared scope ${record.scopeId} sealed`,
          );
        }
      }
      const expectedGlobal = record.globalTypeContracts.get(id);
      if (expectedGlobal) {
        const currentGlobal = this.globalTypeContractFor(currentDraft);
        if (
          !currentGlobal ||
          currentGlobal.mutable !== expectedGlobal.mutable ||
          canonicalProgramAbiValType(currentGlobal.type) !== canonicalProgramAbiValType(expectedGlobal.type)
        ) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `global type contract for ${id} drifted after prepared scope ${record.scopeId} sealed`,
          );
        }
      }
    }
    const currentReachableLayouts = this.collectPreparedReachableTypeLayouts(
      module,
      record.typeLayouts.keys(),
      record.callableTypeContracts,
      record.globalTypeContracts,
    );
    if (
      currentReachableLayouts.size !== record.reachableTypeLayouts.size ||
      [...record.reachableTypeLayouts].some(([index, layout]) => currentReachableLayouts.get(index) !== layout)
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `reachable type graph drifted after prepared ABI scope ${record.scopeId} sealed`,
      );
    }
  }

  private reconcilePreparedScopes(wholeProgramAbi: ProgramAbiMap, module: WasmModule): void {
    for (const record of this.preparedScopes.values()) {
      const scopedAbi = this.buildPreparedScopeAbi(record, module);
      for (const scopedEntry of scopedAbi.entries()) {
        const wholeProgramEntry = wholeProgramAbi.get(scopedEntry.id);
        if (!wholeProgramEntry || !planEntriesEqualIgnoringDenseOrder(scopedEntry, wholeProgramEntry)) {
          throw new ProgramAbiInvariantError(
            "session-draft-mismatch",
            `whole-program ABI does not reconcile prepared binding ${scopedEntry.id} from scope ${record.scopeId}`,
          );
        }
      }
    }
  }

  private buildSealedAbi(
    drafts: readonly ProgramAbiDraft[],
    module: WasmModule,
    derivedUnits: readonly ProgramAbiDerivedUnitRecord[] = [...this.derivedUnits.values()],
  ): ProgramAbiMap {
    const abi = new ProgramAbiMap(this.inventory, derivedUnits);
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
    return abi;
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

  private assertPlanning(action: string): void {
    if (this.state !== "planning") {
      throw new ProgramAbiInvariantError(
        "session-closed",
        `cannot ${action} after ProgramAbiSession left planning state (${this.state})`,
      );
    }
  }

  private assertLayoutMutable(action: string): void {
    if (this.state !== "planning" && this.state !== "sealed") {
      throw new ProgramAbiInvariantError(
        "session-closed",
        `cannot ${action} after ProgramAbiSession left the layout phase (${this.state})`,
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
    this.assertLayoutMutable(`replace slot locator for ${id}`);
    const preparedScopeId = this.preparedScopeForBinding(id);
    if (preparedScopeId !== undefined) {
      throw new ProgramAbiInvariantError(
        "locator-remap-mismatch",
        `ABI binding ${id} belongs to sealed prepared scope ${preparedScopeId} and cannot replace its reserved locator`,
      );
    }
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
