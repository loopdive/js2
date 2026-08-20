// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  createDerivedIrUnitId,
  type IrBindingId,
  type IrClassId,
  type IrSourceId,
  type IrSyntheticUnitRole,
  type IrUnitId,
  type IrUnitInventory,
} from "./identity.js";
import { irGlobalBindingKey } from "./abi-bindings.js";

export type ProgramAbiSlotPolicy = "required" | "alias" | "none";
/** The three independent index spaces owned by ModuleAssembler. */
export type ProgramAbiSlotSpace = "function" | "global" | "type";
/** Namespaces exposed by the temporary string-keyed legacy compatibility view. */
export type ProgramAbiLegacyNamespace = ProgramAbiSlotSpace | "export";

export interface ProgramAbiCallableSignature {
  readonly params: readonly string[];
  readonly results: readonly string[];
}

/**
 * Explicit provenance for a pass-created executable unit that is not present
 * in the source inventory. Display names and encoded-ID parsing are
 * deliberately absent from this contract.
 */
export interface ProgramAbiDerivedUnitRecord {
  readonly id: IrUnitId;
  readonly parentId: IrUnitId;
  readonly terminalOwnerId: IrUnitId | null;
  readonly sourceId: IrSourceId;
  readonly role: IrSyntheticUnitRole;
  readonly ordinal: number;
}

export type ProgramAbiIntent =
  | {
      readonly kind: "callable";
      readonly origin: "source" | "import" | "runtime" | "intrinsic" | "support";
      readonly signature: ProgramAbiCallableSignature;
      readonly unitId?: IrUnitId;
      readonly classId?: IrClassId;
      readonly sourceId?: IrSourceId;
      /** Exact platform-capability allocator provenance for imported callables. */
      readonly capabilityId?: string;
      readonly providerId?: string;
    }
  | {
      readonly kind: "global";
      readonly origin: "source" | "import" | "runtime" | "support";
      readonly valueType: string;
      readonly mutable: boolean;
      /** Explicit provider provenance for capability-owned source storage. */
      readonly capability?: "dom";
      /** Exact source that structurally owns a source-global binding ID. */
      readonly sourceId?: IrSourceId;
      /** Terminal unit that owns initialization/storage lifetime for this global. */
      readonly unitId?: IrUnitId;
    }
  | {
      readonly kind: "type";
      readonly shapeKey: string;
    }
  | {
      readonly kind: "export";
      readonly externalName: string;
      readonly targetId: IrBindingId;
    }
  | {
      readonly kind: "class";
      readonly classId: IrClassId;
      readonly layoutKey: string;
    }
  | {
      readonly kind: "support";
      readonly role: string;
    };

type ProgramAbiSlottedIntent = Exclude<ProgramAbiIntent, { readonly kind: "export" | "support" }>;
type ProgramAbiAliasIntent = Exclude<ProgramAbiIntent, { readonly kind: "export" | "support" }>;
type ProgramAbiNonExportIntent = Exclude<ProgramAbiIntent, { readonly kind: "export" }>;
type ProgramAbiExportIntent = Extract<ProgramAbiIntent, { readonly kind: "export" }>;

interface ProgramAbiKnownUnitRecord {
  readonly id: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly terminalOwnerId: IrUnitId | null;
}

/** Numeric structural order supplied by the inventory/planning owner. */
export interface ProgramAbiOrderKey {
  /** Dependency-first source order from {@link IrUnitInventory.sources}. */
  readonly sourceOrder: number;
  /** Stable declaration/binding order within that source. */
  readonly declarationOrder: number;
}

interface ProgramAbiPlanBase<TIntent extends ProgramAbiIntent> {
  readonly id: IrBindingId;
  /** Stable whole-program planning order; never inferred from encoded IDs or insertion. */
  readonly order: ProgramAbiOrderKey;
  /** Diagnostic/legacy label only. Structural IDs remain the semantic key. */
  readonly displayName: string;
  /**
   * Canonical structural payload paired with this binding ID by IR references.
   *
   * The session treats this as an opaque, producer-owned key. It deliberately
   * excludes compatibility labels and must include any payload that could
   * otherwise lie beside a valid ID (for example an import module/field,
   * runtime symbol, or class identity).
   */
  readonly structuralReferenceKey?: string;
  readonly intent: TIntent;
}

export type ProgramAbiPlanEntry =
  | (ProgramAbiPlanBase<ProgramAbiSlottedIntent> & {
      readonly slotPolicy: "required";
      readonly slotSpace: ProgramAbiSlotSpace;
      readonly aliasOf?: never;
    })
  | (ProgramAbiPlanBase<ProgramAbiAliasIntent> & {
      readonly slotPolicy: "alias";
      readonly aliasOf: IrBindingId;
      readonly slotSpace?: never;
    })
  | (ProgramAbiPlanBase<ProgramAbiNonExportIntent> & {
      readonly slotPolicy: "none";
      readonly slotSpace?: never;
      readonly aliasOf?: never;
    })
  | (ProgramAbiPlanBase<ProgramAbiExportIntent> & {
      readonly slotPolicy: "alias";
      readonly aliasOf: IrBindingId;
      readonly slotSpace?: never;
    });

/** A finalized raw index reported by ModuleAssembler; this seam never allocates. */
export interface ProgramAbiFinalIndex {
  readonly space: ProgramAbiSlotSpace;
  readonly index: number;
}

export type ProgramAbiInvariantCode =
  | "duplicate-binding-plan"
  | "invalid-plan-order"
  | "duplicate-plan-order"
  | "invalid-slot-policy"
  | "missing-source-unit"
  | "invalid-callable-provenance"
  | "unknown-inventory-unit"
  | "unknown-inventory-class"
  | "inventory-source-order-mismatch"
  | "duplicate-derived-unit"
  | "invalid-derived-unit"
  | "unknown-derived-parent"
  | "derived-unit-cycle"
  | "unknown-derived-source"
  | "derived-source-mismatch"
  | "unknown-derived-terminal-owner"
  | "derived-terminal-owner-mismatch"
  | "planning-sealed"
  | "planning-not-sealed"
  | "binding-complete"
  | "unknown-binding"
  | "missing-alias-target"
  | "alias-cycle"
  | "alias-intent-kind-mismatch"
  | "alias-signature-mismatch"
  | "alias-contract-mismatch"
  | "alias-slot-space-mismatch"
  | "intent-slot-space-mismatch"
  | "export-target-mismatch"
  | "invalid-export-target"
  | "duplicate-export-name"
  | "alias-final-binding"
  | "slotless-final-binding"
  | "duplicate-final-binding"
  | "final-index-space-mismatch"
  | "final-index-collision"
  | "unresolved-required-binding"
  | "missing-legacy-name"
  | "ambiguous-legacy-name"
  | "no-internal-wasm-name"
  | "duplicate-session-draft"
  | "session-draft-mismatch"
  | "invalid-draft-order"
  | "duplicate-draft-order"
  | "unknown-draft-source"
  | "unknown-order-anchor"
  | "ambiguous-order-anchor"
  | "session-closed"
  | "session-publish-once"
  | "context-session-mismatch"
  | "unknown-locator-binding"
  | "missing-binding-reference"
  | "invalid-binding-reference"
  | "binding-reference-mismatch"
  | "locator-not-required"
  | "duplicate-slot-locator"
  | "slot-locator-space-mismatch"
  | "locator-remap-mismatch"
  | "foreign-type-cell"
  | "duplicate-type-cell"
  | "foreign-type-object"
  | "ambiguous-type-remap"
  | "type-remap-mismatch"
  | "missing-required-locator"
  | "eliminated-required-locator"
  | "callable-provider-mismatch";

export class ProgramAbiInvariantError extends Error {
  constructor(
    readonly code: ProgramAbiInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "ProgramAbiInvariantError";
  }
}

const indexKey = (finalIndex: ProgramAbiFinalIndex): string => `${finalIndex.space}:${finalIndex.index}`;
const legacyKey = (namespace: ProgramAbiLegacyNamespace, name: string): string => `${namespace}\u0000${name}`;
const orderKey = (order: ProgramAbiOrderKey): string => `${order.sourceOrder}:${order.declarationOrder}`;

function compareOrder(a: ProgramAbiOrderKey, b: ProgramAbiOrderKey): number {
  return a.sourceOrder - b.sourceOrder || a.declarationOrder - b.declarationOrder;
}

function validOrderComponent(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function intentSlotSpace(intent: ProgramAbiIntent): ProgramAbiSlotSpace | null {
  if (intent.kind === "callable") return "function";
  if (intent.kind === "global") return "global";
  if (intent.kind === "type" || intent.kind === "class") return "type";
  return null;
}

function intentLegacyNamespace(intent: ProgramAbiIntent): ProgramAbiLegacyNamespace | null {
  if (intent.kind === "export") return "export";
  return intentSlotSpace(intent);
}

function callableSignaturesEqual(a: ProgramAbiCallableSignature, b: ProgramAbiCallableSignature): boolean {
  return (
    a.params.length === b.params.length &&
    a.params.every((param, i) => param === b.params[i]) &&
    a.results.length === b.results.length &&
    a.results.every((result, i) => result === b.results[i])
  );
}

function freezePlan(entry: ProgramAbiPlanEntry): ProgramAbiPlanEntry {
  const intent =
    entry.intent.kind === "callable"
      ? {
          ...entry.intent,
          signature: {
            params: Object.freeze([...entry.intent.signature.params]),
            results: Object.freeze([...entry.intent.signature.results]),
          },
        }
      : { ...entry.intent };
  return Object.freeze({
    ...entry,
    order: Object.freeze({ ...entry.order }),
    intent: Object.freeze(intent),
  }) as ProgramAbiPlanEntry;
}

function aliasContractsMatch(alias: ProgramAbiIntent, canonical: ProgramAbiIntent): boolean {
  if (alias.kind !== canonical.kind) return false;
  if (alias.kind === "callable" && canonical.kind === "callable") {
    return (
      callableSignaturesEqual(alias.signature, canonical.signature) &&
      alias.capabilityId === canonical.capabilityId &&
      alias.providerId === canonical.providerId
    );
  }
  if (alias.kind === "global" && canonical.kind === "global") {
    return (
      alias.valueType === canonical.valueType &&
      alias.mutable === canonical.mutable &&
      alias.capability === canonical.capability
    );
  }
  if (alias.kind === "type" && canonical.kind === "type") return alias.shapeKey === canonical.shapeKey;
  if (alias.kind === "class" && canonical.kind === "class") {
    return alias.classId === canonical.classId && alias.layoutKey === canonical.layoutKey;
  }
  return alias.kind !== "support" && alias.kind !== "export";
}

/**
 * Structural identity/intention ledger for the whole-program ABI.
 *
 * ProgramAbiSession owns the planning/final-index boundary without changing
 * allocation or routing. ModuleAssembler remains the sole owner of every Wasm
 * index space; production producer threading lands at the later cutover.
 */
export class ProgramAbiMap {
  private readonly planned = new Map<IrBindingId, ProgramAbiPlanEntry>();
  private readonly orderOwners = new Map<string, IrBindingId>();
  private readonly finalIndices = new Map<IrBindingId, ProgramAbiFinalIndex>();
  private readonly finalIndexOwners = new Map<string, IrBindingId>();
  private readonly sourceOrders = new Map<IrUnitInventory["sources"][number]["id"], number>();
  private readonly units = new Map<IrUnitId, ProgramAbiKnownUnitRecord>();
  private readonly classes = new Map<IrClassId, IrUnitInventory["classes"][number]>();
  private readonly terminalUnits = new Set<IrUnitId>();
  private sealed = false;
  private complete = false;

  constructor(
    readonly inventory: IrUnitInventory,
    derivedUnits: readonly ProgramAbiDerivedUnitRecord[] = [],
  ) {
    for (const source of inventory.sources) this.sourceOrders.set(source.id, source.order);
    for (const unit of inventory.allUnits) this.units.set(unit.id, unit);
    for (const classRecord of inventory.classes) this.classes.set(classRecord.id, classRecord);
    for (const unit of inventory.terminalUnits) this.terminalUnits.add(unit.id);
    this.registerDerivedUnits(derivedUnits);
  }

  plan(entry: ProgramAbiPlanEntry): void {
    if (this.sealed) {
      throw new ProgramAbiInvariantError("planning-sealed", `cannot plan ${entry.id} after ABI planning was sealed`);
    }
    if (this.planned.has(entry.id)) {
      throw new ProgramAbiInvariantError("duplicate-binding-plan", `binding ${entry.id} was planned more than once`);
    }
    if (
      !entry.order ||
      !validOrderComponent(entry.order.sourceOrder) ||
      !validOrderComponent(entry.order.declarationOrder)
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-plan-order",
        `binding ${entry.id} has invalid structural order ${JSON.stringify(entry.order)}`,
      );
    }
    if (
      entry.structuralReferenceKey !== undefined &&
      (typeof entry.structuralReferenceKey !== "string" || entry.structuralReferenceKey.length === 0)
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `binding ${entry.id} has an invalid structural reference key`,
      );
    }
    const structuralOrder = orderKey(entry.order);
    const previousOrderOwner = this.orderOwners.get(structuralOrder);
    if (previousOrderOwner) {
      throw new ProgramAbiInvariantError(
        "duplicate-plan-order",
        `bindings ${previousOrderOwner} and ${entry.id} share structural order ${structuralOrder}`,
      );
    }

    if (entry.intent.kind === "support" && entry.slotPolicy !== "none") {
      throw new ProgramAbiInvariantError(
        "invalid-slot-policy",
        `support binding ${entry.id} must use slot policy none`,
      );
    }
    if (entry.intent.kind === "export" && entry.slotPolicy !== "alias") {
      throw new ProgramAbiInvariantError(
        "invalid-slot-policy",
        `export binding ${entry.id} must alias a callable or global binding`,
      );
    }
    const runtimeEntry = entry as ProgramAbiPlanEntry & {
      readonly aliasOf?: IrBindingId;
      readonly slotSpace?: ProgramAbiSlotSpace;
    };
    if (entry.slotPolicy !== "required" && runtimeEntry.slotSpace !== undefined) {
      throw new ProgramAbiInvariantError(
        "invalid-slot-policy",
        `non-allocating binding ${entry.id} cannot reserve ${runtimeEntry.slotSpace} index space`,
      );
    }
    if (entry.slotPolicy !== "alias" && runtimeEntry.aliasOf !== undefined) {
      throw new ProgramAbiInvariantError(
        "invalid-slot-policy",
        `non-alias binding ${entry.id} cannot target ${runtimeEntry.aliasOf}`,
      );
    }
    if (entry.slotPolicy === "required") {
      const expectedSpace = intentSlotSpace(entry.intent);
      if (expectedSpace === null || entry.slotSpace !== expectedSpace) {
        throw new ProgramAbiInvariantError(
          "intent-slot-space-mismatch",
          `binding ${entry.id} has ${entry.intent.kind} intent but plans ${entry.slotSpace}`,
        );
      }
    }
    this.validateInventoryMembership(entry);
    this.planned.set(entry.id, freezePlan(entry));
    this.orderOwners.set(structuralOrder, entry.id);
  }

  entries(): readonly ProgramAbiPlanEntry[] {
    return Object.freeze([...this.planned.values()].sort((a, b) => compareOrder(a.order, b.order)));
  }

  get(id: IrBindingId): ProgramAbiPlanEntry | undefined {
    return this.planned.get(id);
  }

  sealPlan(): void {
    if (this.sealed) return;
    const entries = this.entries();
    const exportNames = new Map<string, IrBindingId>();
    for (const entry of entries) {
      if (entry.intent.kind !== "export") continue;
      const previous = exportNames.get(entry.intent.externalName);
      if (previous) {
        throw new ProgramAbiInvariantError(
          "duplicate-export-name",
          `exports ${previous} and ${entry.id} share external name ${entry.intent.externalName}`,
        );
      }
      exportNames.set(entry.intent.externalName, entry.id);
    }

    for (const entry of entries) {
      if (entry.slotPolicy !== "alias") continue;
      const directTarget = this.planned.get(entry.aliasOf);
      if (!directTarget) {
        throw new ProgramAbiInvariantError(
          "missing-alias-target",
          `alias ${entry.id} targets unplanned binding ${entry.aliasOf}`,
        );
      }
      const canonical = this.canonicalEntry(entry.id);
      if (canonical.slotPolicy !== "required") {
        throw new ProgramAbiInvariantError(
          "alias-slot-space-mismatch",
          `alias ${entry.id} resolves to slotless binding ${canonical.id}`,
        );
      }

      if (entry.intent.kind === "export") {
        const declaredTarget = this.planned.get(entry.intent.targetId);
        if (!declaredTarget) {
          throw new ProgramAbiInvariantError(
            "missing-alias-target",
            `export ${entry.id} declares unplanned target ${entry.intent.targetId}`,
          );
        }
        if (entry.intent.targetId !== entry.aliasOf) {
          throw new ProgramAbiInvariantError(
            "export-target-mismatch",
            `export ${entry.id} target ${entry.intent.targetId} disagrees with alias ${entry.aliasOf}`,
          );
        }
        if (declaredTarget.intent.kind !== "callable" && declaredTarget.intent.kind !== "global") {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            `export ${entry.id} directly targets ${declaredTarget.intent.kind} binding ${declaredTarget.id}`,
          );
        }
        if (canonical.intent.kind !== "callable" && canonical.intent.kind !== "global") {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            `export ${entry.id} resolves to ${canonical.intent.kind} binding ${canonical.id}`,
          );
        }
        continue;
      }

      if (entry.intent.kind !== canonical.intent.kind) {
        throw new ProgramAbiInvariantError(
          "alias-intent-kind-mismatch",
          `alias ${entry.id} has ${entry.intent.kind} intent but resolves to ${canonical.intent.kind} binding ${canonical.id}`,
        );
      }
      const expectedSpace = intentSlotSpace(entry.intent);
      if (expectedSpace === null || canonical.slotSpace !== expectedSpace) {
        throw new ProgramAbiInvariantError(
          "alias-slot-space-mismatch",
          `alias ${entry.id} expects ${expectedSpace ?? "no index"} but resolves to ${canonical.slotSpace}`,
        );
      }
      if (!aliasContractsMatch(entry.intent, canonical.intent)) {
        const code = entry.intent.kind === "callable" ? "alias-signature-mismatch" : "alias-contract-mismatch";
        throw new ProgramAbiInvariantError(
          code,
          `${entry.intent.kind} alias ${entry.id} does not match canonical binding ${canonical.id}`,
        );
      }
    }
    this.sealed = true;
  }

  get planningSealed(): boolean {
    return this.sealed;
  }

  assertPlanSealed(): void {
    if (!this.sealed) {
      throw new ProgramAbiInvariantError("planning-not-sealed", "legacy ABI view requires a sealed ProgramAbiMap plan");
    }
  }

  /** Record a finalized allocator-owned index; this method never allocates. */
  bindFinalIndex(id: IrBindingId, finalIndex: ProgramAbiFinalIndex): void {
    if (!this.sealed) {
      throw new ProgramAbiInvariantError("planning-not-sealed", `cannot bind ${id} before ABI planning is sealed`);
    }
    if (this.complete) {
      throw new ProgramAbiInvariantError("binding-complete", `cannot bind ${id} after ABI binding completed`);
    }
    const entry = this.requireEntry(id);
    if (entry.slotPolicy === "alias") {
      throw new ProgramAbiInvariantError(
        "alias-final-binding",
        `alias ${id} must resolve through ${entry.aliasOf}; it cannot own a final index`,
      );
    }
    if (entry.slotPolicy === "none") {
      throw new ProgramAbiInvariantError("slotless-final-binding", `slotless binding ${id} cannot own a final index`);
    }
    if (entry.slotSpace !== finalIndex.space || !Number.isSafeInteger(finalIndex.index) || finalIndex.index < 0) {
      throw new ProgramAbiInvariantError(
        "final-index-space-mismatch",
        `binding ${id} planned ${entry.slotSpace} but received ${finalIndex.space}:${finalIndex.index}`,
      );
    }
    if (this.finalIndices.has(id)) {
      throw new ProgramAbiInvariantError("duplicate-final-binding", `binding ${id} was bound more than once`);
    }
    const occupant = this.finalIndexOwners.get(indexKey(finalIndex));
    if (occupant) {
      throw new ProgramAbiInvariantError(
        "final-index-collision",
        `bindings ${occupant} and ${id} cannot share non-alias index ${indexKey(finalIndex)}`,
      );
    }
    const frozen = Object.freeze({ ...finalIndex });
    this.finalIndices.set(id, frozen);
    this.finalIndexOwners.set(indexKey(finalIndex), id);
  }

  /** Require every canonical required intention to have a finalized index. */
  finishBinding(): void {
    if (!this.sealed) {
      throw new ProgramAbiInvariantError("planning-not-sealed", "cannot finish ABI binding before planning is sealed");
    }
    for (const entry of this.entries()) {
      if (entry.slotPolicy === "required" && !this.finalIndices.has(entry.id)) {
        throw new ProgramAbiInvariantError(
          "unresolved-required-binding",
          `required binding ${entry.id} has no final ModuleAssembler index`,
        );
      }
    }
    this.complete = true;
  }

  canonicalId(id: IrBindingId): IrBindingId {
    return this.canonicalEntry(id).id;
  }

  resolveFinalIndex(id: IrBindingId): ProgramAbiFinalIndex | undefined {
    const canonical = this.canonicalEntry(id);
    return canonical.slotPolicy === "required" ? this.finalIndices.get(canonical.id) : undefined;
  }

  private registerDerivedUnits(records: readonly ProgramAbiDerivedUnitRecord[]): void {
    const pending = new Map<IrUnitId, ProgramAbiDerivedUnitRecord>();
    for (const record of records) {
      if (this.units.has(record.id) || pending.has(record.id)) {
        throw new ProgramAbiInvariantError(
          "duplicate-derived-unit",
          `derived unit ${record.id} was registered more than once`,
        );
      }
      if (!Number.isSafeInteger(record.ordinal) || record.ordinal < 0 || record.role.length === 0) {
        throw new ProgramAbiInvariantError(
          "invalid-derived-unit",
          `derived unit ${record.id} has invalid role/ordinal provenance`,
        );
      }
      const expectedId = createDerivedIrUnitId({
        parentId: record.parentId,
        role: record.role,
        ordinal: record.ordinal,
      });
      if (record.id !== expectedId) {
        throw new ProgramAbiInvariantError(
          "invalid-derived-unit",
          `derived unit ${record.id} does not match its explicit parent/role/ordinal provenance`,
        );
      }
      if (!this.sourceOrders.has(record.sourceId)) {
        throw new ProgramAbiInvariantError(
          "unknown-derived-source",
          `derived unit ${record.id} references source ${record.sourceId} outside this inventory`,
        );
      }
      pending.set(record.id, Object.freeze({ ...record }));
    }

    const visiting = new Set<IrUnitId>();
    const resolve = (id: IrUnitId, childId: IrUnitId): ProgramAbiKnownUnitRecord => {
      const known = this.units.get(id);
      if (known) return known;
      const record = pending.get(id);
      if (!record) {
        throw new ProgramAbiInvariantError(
          "unknown-derived-parent",
          `derived unit ${childId} references unknown parent ${id}`,
        );
      }
      if (visiting.has(id)) {
        throw new ProgramAbiInvariantError("derived-unit-cycle", `derived unit parent cycle includes ${id}`);
      }
      visiting.add(id);
      const parent = resolve(record.parentId, record.id);
      if (record.sourceId !== parent.sourceId) {
        throw new ProgramAbiInvariantError(
          "derived-source-mismatch",
          `derived unit ${record.id} source ${record.sourceId} disagrees with parent source ${parent.sourceId}`,
        );
      }
      if (record.terminalOwnerId !== null && !this.terminalUnits.has(record.terminalOwnerId)) {
        throw new ProgramAbiInvariantError(
          "unknown-derived-terminal-owner",
          `derived unit ${record.id} references non-terminal owner ${record.terminalOwnerId}`,
        );
      }
      if (record.terminalOwnerId !== parent.terminalOwnerId) {
        throw new ProgramAbiInvariantError(
          "derived-terminal-owner-mismatch",
          `derived unit ${record.id} terminal owner ${record.terminalOwnerId ?? "none"} disagrees with parent owner ${parent.terminalOwnerId ?? "none"}`,
        );
      }
      visiting.delete(id);
      this.units.set(record.id, record);
      return record;
    };

    for (const record of records) resolve(record.id, record.id);
  }

  private validateInventoryMembership(entry: ProgramAbiPlanEntry): void {
    if (entry.intent.kind === "callable") {
      const hasUnit = entry.intent.unitId !== undefined;
      const hasClass = entry.intent.classId !== undefined;
      const hasSource = entry.intent.sourceId !== undefined;
      const hasCapability = entry.intent.capabilityId !== undefined;
      const hasProvider = entry.intent.providerId !== undefined;
      if (hasCapability !== hasProvider || (hasCapability && entry.intent.origin !== "import")) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `callable binding ${entry.id} has invalid platform-capability provenance`,
        );
      }
      if (entry.intent.origin === "source") {
        if (!hasUnit) {
          throw new ProgramAbiInvariantError(
            "missing-source-unit",
            `source callable binding ${entry.id} must identify its inventoried unit`,
          );
        }
        if (hasClass || hasSource) {
          throw new ProgramAbiInvariantError(
            "invalid-callable-provenance",
            `source callable binding ${entry.id} cannot identify a class or support source`,
          );
        }
      } else if (entry.intent.origin === "support") {
        if (Number(hasUnit) + Number(hasClass) + Number(hasSource) !== 1) {
          throw new ProgramAbiInvariantError(
            "invalid-callable-provenance",
            `support callable binding ${entry.id} must identify exactly one unit, class, or source owner`,
          );
        }
      } else if (hasUnit || hasClass || hasSource) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `${entry.intent.origin} callable binding ${entry.id} cannot identify a source unit, class, or support source owner`,
        );
      }

      if (hasUnit) {
        const unit = this.units.get(entry.intent.unitId);
        if (!unit) {
          throw new ProgramAbiInvariantError(
            "unknown-inventory-unit",
            `callable binding ${entry.id} references unit ${entry.intent.unitId} outside this inventory`,
          );
        }
        this.assertInventorySourceOrder(entry, unit.sourceId);
      }
      if (hasClass) {
        const classRecord = this.classes.get(entry.intent.classId);
        if (!classRecord) {
          throw new ProgramAbiInvariantError(
            "unknown-inventory-class",
            `callable binding ${entry.id} references class ${entry.intent.classId} outside this inventory`,
          );
        }
        this.assertInventorySourceOrder(entry, classRecord.sourceId);
      }
      if (hasSource) {
        if (!this.sourceOrders.has(entry.intent.sourceId!)) {
          throw new ProgramAbiInvariantError(
            "unknown-draft-source",
            `callable binding ${entry.id} references source ${entry.intent.sourceId} outside this inventory`,
          );
        }
        this.assertInventorySourceOrder(entry, entry.intent.sourceId!);
      }
    }

    if (entry.intent.kind === "global" && entry.intent.capability !== undefined) {
      if (
        entry.intent.capability !== "dom" ||
        entry.intent.origin !== "source" ||
        entry.intent.sourceId === undefined ||
        entry.intent.unitId === undefined ||
        entry.slotPolicy !== "required" ||
        entry.aliasOf !== undefined
      ) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `capability global binding ${entry.id} requires an exact source-owned allocator and storage-terminal provenance`,
        );
      }
      const unit = this.units.get(entry.intent.unitId);
      if (!unit) {
        throw new ProgramAbiInvariantError(
          "unknown-inventory-unit",
          `capability global binding ${entry.id} references unit ${entry.intent.unitId} outside this inventory`,
        );
      }
      if (unit.sourceId !== entry.intent.sourceId || !this.sourceOrders.has(entry.intent.sourceId)) {
        throw new ProgramAbiInvariantError(
          "invalid-callable-provenance",
          `capability global binding ${entry.id} source and storage-terminal provenance disagree`,
        );
      }
      const exactReferenceKey = irGlobalBindingKey({
        kind: "source",
        bindingId: entry.id,
        capability: entry.intent.capability,
      });
      if (entry.structuralReferenceKey !== exactReferenceKey) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `capability global binding ${entry.id} does not name its exact capability allocator reference`,
        );
      }
      this.assertInventorySourceOrder(entry, entry.intent.sourceId);
    }

    if (entry.intent.kind === "class") {
      const classRecord = this.classes.get(entry.intent.classId);
      if (!classRecord) {
        throw new ProgramAbiInvariantError(
          "unknown-inventory-class",
          `class binding ${entry.id} references class ${entry.intent.classId} outside this inventory`,
        );
      }
      this.assertInventorySourceOrder(entry, classRecord.sourceId);
    }
  }

  private assertInventorySourceOrder(
    entry: ProgramAbiPlanEntry,
    sourceId: IrUnitInventory["sources"][number]["id"],
  ): void {
    const inventoryOrder = this.sourceOrders.get(sourceId);
    if (inventoryOrder !== entry.order.sourceOrder) {
      throw new ProgramAbiInvariantError(
        "inventory-source-order-mismatch",
        `binding ${entry.id} plans source order ${entry.order.sourceOrder}, expected ${inventoryOrder ?? "unknown"}`,
      );
    }
  }

  private requireEntry(id: IrBindingId): ProgramAbiPlanEntry {
    const entry = this.planned.get(id);
    if (!entry) throw new ProgramAbiInvariantError("unknown-binding", `binding ${id} was not planned`);
    return entry;
  }

  private canonicalEntry(id: IrBindingId): ProgramAbiPlanEntry {
    let current = this.requireEntry(id);
    const visited = new Set<IrBindingId>();
    while (current.slotPolicy === "alias") {
      if (visited.has(current.id)) {
        throw new ProgramAbiInvariantError("alias-cycle", `alias cycle includes binding ${current.id}`);
      }
      visited.add(current.id);
      const target = this.planned.get(current.aliasOf);
      if (!target) {
        throw new ProgramAbiInvariantError(
          "missing-alias-target",
          `alias ${current.id} targets unplanned binding ${current.aliasOf}`,
        );
      }
      current = target;
    }
    return current;
  }
}

/**
 * The only name-keyed compatibility view intended for the legacy frontend.
 * It is namespace-aware and observes finalized indices without mutating codegen.
 */
export class LegacyAbiAdapter {
  private readonly byLegacyName = new Map<string, readonly IrBindingId[]>();
  private readonly internalNames = new Map<IrBindingId, string>();

  constructor(readonly abi: ProgramAbiMap) {
    abi.assertPlanSealed();
    const entries = abi.entries();
    const grouped = new Map<string, IrBindingId[]>();
    for (const entry of entries) {
      const namespace = intentLegacyNamespace(entry.intent);
      if (namespace === null) continue;
      const name = entry.intent.kind === "export" ? entry.intent.externalName : entry.displayName;
      const key = legacyKey(namespace, name);
      const ids = grouped.get(key);
      if (ids) ids.push(entry.id);
      else grouped.set(key, [entry.id]);
    }
    for (const [key, ids] of grouped) this.byLegacyName.set(key, Object.freeze([...ids]));

    const canonicalBySpaceAndName = new Map<string, IrBindingId[]>();
    const reservedBySpace = new Map<ProgramAbiSlotSpace, Set<string>>();
    const usedBySpace = new Map<ProgramAbiSlotSpace, Set<string>>();
    for (const space of ["function", "global", "type"] as const) {
      reservedBySpace.set(space, new Set());
      usedBySpace.set(space, new Set());
    }
    for (const entry of entries) {
      if (entry.slotPolicy !== "required") continue;
      const key = legacyKey(entry.slotSpace, entry.displayName);
      const ids = canonicalBySpaceAndName.get(key);
      if (ids) ids.push(entry.id);
      else canonicalBySpaceAndName.set(key, [entry.id]);
      reservedBySpace.get(entry.slotSpace)!.add(entry.displayName);
    }
    for (const [key, ids] of canonicalBySpaceAndName) {
      const separator = key.indexOf("\u0000");
      const space = key.slice(0, separator) as ProgramAbiSlotSpace;
      const name = key.slice(separator + 1);
      const reserved = reservedBySpace.get(space)!;
      const used = usedBySpace.get(space)!;
      if (ids.length === 1) {
        this.internalNames.set(ids[0]!, name);
        used.add(name);
        continue;
      }
      for (const id of ids) {
        const encoded = encodeURIComponent(id);
        let candidate = `${name}__ir_${encoded}`;
        let discriminator = 0;
        while (reserved.has(candidate) || used.has(candidate)) {
          candidate = `__ir_identity_${encoded}_${discriminator++}`;
        }
        this.internalNames.set(id, candidate);
        used.add(candidate);
      }
    }
  }

  /** Resolve one namespace/name to its canonical structural owner, never an alias record. */
  resolveUniqueLegacyName(namespace: ProgramAbiLegacyNamespace, name: string): IrBindingId {
    const ids = this.byLegacyName.get(legacyKey(namespace, name)) ?? [];
    if (ids.length === 0) {
      throw new ProgramAbiInvariantError("missing-legacy-name", `legacy ABI ${namespace} name ${name} was not planned`);
    }
    const canonicalIds = new Set(ids.map((id) => this.abi.canonicalId(id)));
    if (canonicalIds.size !== 1) {
      throw new ProgramAbiInvariantError(
        "ambiguous-legacy-name",
        `legacy ABI ${namespace} name ${name} matches ${canonicalIds.size} canonical structural owners`,
      );
    }
    return canonicalIds.values().next().value!;
  }

  resolveFinalIndex(namespace: ProgramAbiLegacyNamespace, name: string): ProgramAbiFinalIndex | undefined {
    return this.abi.resolveFinalIndex(this.resolveUniqueLegacyName(namespace, name));
  }

  /** Preserve a canonical spelling; qualify only same-index-space collisions. */
  internalWasmName(id: IrBindingId): string {
    const entry = this.abi.get(id);
    if (!entry) throw new ProgramAbiInvariantError("unknown-binding", `binding ${id} was not planned`);
    const canonicalId = this.abi.canonicalId(id);
    const name = this.internalNames.get(canonicalId);
    if (!name) {
      throw new ProgramAbiInvariantError(
        "no-internal-wasm-name",
        `binding ${id} does not resolve to a canonical allocator-owned index`,
      );
    }
    return name;
  }
}
