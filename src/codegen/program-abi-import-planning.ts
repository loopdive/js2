// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey, irImportGlobalRef, irPlannedImportGlobalRef } from "../ir/abi-bindings.js";
import { irCallableBindingKey, irCapabilityImportFuncRef, irImportFuncRef } from "../ir/callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrSourceId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { IrGlobalRef } from "../ir/nodes.js";
import type { FuncTypeDef, Import, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { programAbiIntentsEqual } from "./program-abi-intent-equality.js";
import {
  canonicalProgramAbiCallableTypeContract,
  cloneProgramAbiCallableTypeContract,
  programAbiCallableSignaturesEqual,
  type ProgramAbiCallableTypeContract,
} from "./program-abi-signatures.js";
import type {
  PreparedProgramAbiDescriptorLifecycle,
  PreparedProgramAbiDescriptorPart,
  PreparedProgramAbiMapWrite,
  PreparedProgramAbiProvisionalBinding,
} from "./program-abi-prepared-transaction.js";
import type { ProgramAbiDraft, ProgramAbiSession, ProgramAbiSlotLocator } from "./program-abi-session.js";

/** Source-anchored global roles not owned by source declaration planning. */
const PROGRAM_ABI_IMPORT_GLOBAL_ROLE = Object.freeze({
  stringConstant: 4,
} as const);

/** Source-anchored callable roles not owned by source declaration planning. */
const PROGRAM_ABI_IMPORT_CALLABLE_ROLE = Object.freeze({
  importedFunction: 4,
} as const);

const PROGRAM_ABI_IMPORT_CALLABLE_BINDING_ROLE = "imported-function";

class ImmutableProgramAbiImportCatalog<T> implements ReadonlyMap<string, T> {
  readonly #entries: ReadonlyMap<string, T>;

  constructor(entries: Iterable<readonly [string, T]>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): T | undefined {
    return this.#entries.get(key);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  entries(): MapIterator<[string, T]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<string> {
    return this.#entries.keys();
  }

  values(): MapIterator<T> {
    return this.#entries.values();
  }

  forEach(callbackfn: (value: T, key: string, map: ReadonlyMap<string, T>) => void, thisArg?: unknown): void {
    this.#entries.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  [Symbol.iterator](): MapIterator<[string, T]> {
    return this.entries();
  }
}

const EMPTY_PROGRAM_ABI_IMPORT_CATALOG: ReadonlyMap<string, IrBindingId> =
  new ImmutableProgramAbiImportCatalog<IrBindingId>([]);

interface ProgramAbiCallableImport {
  readonly baseKey: string;
  readonly key: string;
  readonly value: Import;
  readonly signature: FuncTypeDef;
  readonly capabilityId?: string;
  readonly providerId?: string;
}

function callableImportError(message: string): ProgramAbiInvariantError {
  return new ProgramAbiInvariantError("type-remap-mismatch", message);
}

function isValidProgramAbiValType(type: unknown, typeCount: number): type is ValType {
  if (typeof type !== "object" || type === null || typeof (type as { kind?: unknown }).kind !== "string") {
    return false;
  }
  const value = type as {
    readonly kind: string;
    readonly typeIdx?: unknown;
    readonly boolean?: unknown;
    readonly symbol?: unknown;
    readonly bigint?: unknown;
  };
  switch (value.kind) {
    case "i32":
      return (
        (value.boolean === undefined || value.boolean === true) && (value.symbol === undefined || value.symbol === true)
      );
    case "i64":
      return value.bigint === undefined || typeof value.bigint === "boolean";
    case "ref":
    case "ref_null":
      return (
        Number.isSafeInteger(value.typeIdx) && (value.typeIdx as number) >= 0 && (value.typeIdx as number) < typeCount
      );
    case "f32":
    case "f64":
    case "v128":
    case "i8":
    case "i16":
    case "funcref":
    case "externref":
    case "ref_extern":
    case "eqref":
    case "anyref":
      return true;
    default:
      return false;
  }
}

function callableImportSignature(ctx: CodegenContext, value: Import): FuncTypeDef {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.desc !== "object" ||
    value.desc === null ||
    value.desc.kind !== "func" ||
    !Number.isSafeInteger(value.desc.typeIdx) ||
    value.desc.typeIdx < 0 ||
    value.desc.typeIdx >= ctx.mod.types.length
  ) {
    throw callableImportError(
      `function import ${String(value?.module)}.${String(value?.name)} has malformed type index ${
        (value?.desc as { readonly typeIdx?: unknown } | undefined)?.typeIdx ?? "<missing>"
      }`,
    );
  }
  const signature = ctx.mod.types[value.desc.typeIdx];
  if (
    typeof signature !== "object" ||
    signature === null ||
    signature.kind !== "func" ||
    !Array.isArray(signature.params) ||
    !Array.isArray(signature.results) ||
    !signature.params.every((type) => isValidProgramAbiValType(type, ctx.mod.types.length)) ||
    !signature.results.every((type) => isValidProgramAbiValType(type, ctx.mod.types.length))
  ) {
    throw callableImportError(
      `function import ${String(value.module)}.${String(value.name)} references non-function or malformed type ${value.desc.typeIdx}`,
    );
  }
  return signature;
}

function canonicalEntrySource(ctx: CodegenContext): IrSourceId {
  const entrySources = ctx.programAbiSession!.inventory.sources.filter((source) => source.kind === "entry");
  if (entrySources.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `callable-import ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
    );
  }
  return entrySources[0]!.id;
}

function collectProgramAbiCallableImports(ctx: CodegenContext): readonly ProgramAbiCallableImport[] {
  const importsByBaseKey = new Map<string, Array<Omit<ProgramAbiCallableImport, "key">>>();
  for (const value of ctx.mod.imports) {
    if (typeof value !== "object" || value === null || typeof value.desc !== "object" || value.desc === null) {
      throw callableImportError("module import population contains a malformed import descriptor");
    }
    if (value.desc.kind !== "func") continue;
    if (
      typeof value.module !== "string" ||
      value.module.length === 0 ||
      typeof value.name !== "string" ||
      value.name.length === 0
    ) {
      throw callableImportError("function import requires non-empty module and field strings");
    }
    const provenance = ctx.mod.platformCapabilityImportProvenance?.get(value);
    const ref = provenance
      ? irCapabilityImportFuncRef(value.module, value.name, provenance.capabilityId, provenance.providerId, value.name)
      : irImportFuncRef(value.module, value.name, value.name);
    const baseKey = irCallableBindingKey(ref.binding);
    let group = importsByBaseKey.get(baseKey);
    if (!group) {
      group = [];
      importsByBaseKey.set(baseKey, group);
    }
    group.push(
      Object.freeze({
        baseKey,
        value,
        signature: callableImportSignature(ctx, value),
        ...(provenance ? { capabilityId: provenance.capabilityId, providerId: provenance.providerId } : {}),
      }),
    );
  }

  const imports: ProgramAbiCallableImport[] = [];
  for (const [baseKey, group] of importsByBaseKey) {
    // `addImport` makes the most recently inserted duplicate the active
    // compatibility target. Preserve that allocator fact without consulting
    // `funcMap`: the module's exact import-object order is authoritative here.
    const canonical = group[group.length - 1]!;
    let duplicateOrdinal = 0;
    for (const imported of group) {
      imports.push(
        Object.freeze({
          ...imported,
          key: imported === canonical ? baseKey : `${baseKey}|allocator-duplicate|${duplicateOrdinal++}`,
        }),
      );
    }
  }
  return Object.freeze(imports.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)));
}

interface PlannedCallableImport {
  readonly key: string;
  readonly bindingId: IrBindingId;
  readonly ordinal: number;
}

interface PreparedCallableImportDenominatorEntry {
  readonly entry: ProgramAbiCallableImport;
  readonly descriptor: Import["desc"];
  readonly signature: FuncTypeDef;
  readonly typeContract: ProgramAbiCallableTypeContract;
}

interface PreparedCallableImportSessionSnapshot {
  readonly draft: ProgramAbiDraft | undefined;
  readonly structuralOrderOwner: IrBindingId | undefined;
  readonly structuralReferenceBindingIds: readonly IrBindingId[];
  readonly locatorOwner: IrBindingId | undefined;
  readonly hasExactLocator: boolean;
}

interface PreparedCallableImportEntry extends PreparedCallableImportDenominatorEntry {
  readonly ordinal: number;
  readonly bindingId: IrBindingId;
  readonly draft: ProgramAbiDraft;
  readonly locator: Extract<ProgramAbiSlotLocator, { readonly kind: "import-function" }>;
  readonly planned: PlannedCallableImport | undefined;
  readonly session: PreparedCallableImportSessionSnapshot;
}

interface PreparedCallableImportDescriptorPayload {
  readonly registry: ProgramAbiCallableImportRegistry;
  readonly lifecycle: PreparedProgramAbiDescriptorLifecycle;
  readonly sealedEntries: readonly ProgramAbiCallableImport[] | undefined;
  readonly denominator: readonly PreparedCallableImportDenominatorEntry[];
  readonly selected: readonly PreparedCallableImportEntry[];
}

/** Opaque registry-authenticated token; its payload never crosses this module. */
export interface PreparedCallableImportDescriptor {
  readonly kind: "prepared-callable-import-descriptor";
}

const preparedCallableImportDescriptors = new WeakMap<
  PreparedCallableImportDescriptor,
  PreparedCallableImportDescriptorPayload
>();

function callableTypeContractsEqual(
  left: ProgramAbiCallableTypeContract,
  right: ProgramAbiCallableTypeContract,
): boolean {
  return programAbiCallableSignaturesEqual(
    canonicalProgramAbiCallableTypeContract(left),
    canonicalProgramAbiCallableTypeContract(right),
  );
}

function callableDraftsEqual(left: ProgramAbiDraft | undefined, right: ProgramAbiDraft | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftAlias = left as ProgramAbiDraft & { readonly aliasOf?: IrBindingId; readonly slotSpace?: string };
  const rightAlias = right as ProgramAbiDraft & { readonly aliasOf?: IrBindingId; readonly slotSpace?: string };
  return (
    left.id === right.id &&
    left.displayName === right.displayName &&
    left.structuralReferenceKey === right.structuralReferenceKey &&
    left.slotPolicy === right.slotPolicy &&
    leftAlias.slotSpace === rightAlias.slotSpace &&
    leftAlias.aliasOf === rightAlias.aliasOf &&
    left.structuralOrder.sourceId === right.structuralOrder.sourceId &&
    left.structuralOrder.declarationOrdinal === right.structuralOrder.declarationOrdinal &&
    left.structuralOrder.domainOrdinal === right.structuralOrder.domainOrdinal &&
    left.structuralOrder.roleOrdinal === right.structuralOrder.roleOrdinal &&
    left.structuralOrder.derivedOrdinal === right.structuralOrder.derivedOrdinal &&
    programAbiIntentsEqual(left.intent, right.intent)
  );
}

function exactBindingIdsEqual(left: readonly IrBindingId[], right: readonly IrBindingId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function callableImportEntriesEqual(left: ProgramAbiCallableImport, right: ProgramAbiCallableImport): boolean {
  return (
    left.baseKey === right.baseKey &&
    left.key === right.key &&
    left.value === right.value &&
    left.signature === right.signature &&
    left.capabilityId === right.capabilityId &&
    left.providerId === right.providerId
  );
}

function draftStructuralOrderOwner(session: ProgramAbiSession, draft: ProgramAbiDraft): IrBindingId | undefined {
  const sourceOrder = session.inventory.sources.find(({ id }) => id === draft.structuralOrder.sourceId)?.order;
  if (sourceOrder === undefined) {
    throw new ProgramAbiInvariantError(
      "unknown-draft-source",
      `ABI draft ${draft.id} references source ${draft.structuralOrder.sourceId} outside this inventory`,
    );
  }
  const order = draft.structuralOrder;
  const key = [
    sourceOrder,
    order.declarationOrdinal,
    order.domainOrdinal,
    order.roleOrdinal,
    order.derivedOrdinal,
  ].join(":");
  const state = session as unknown as { readonly draftOrderOwners: ReadonlyMap<string, IrBindingId> };
  return state.draftOrderOwners.get(key);
}

/**
 * Compilation-wide callable-import planner with a selective pre-DCE seal.
 *
 * Ordinary compilations retain the historical dense, final-population order.
 * Once a prepared component needs an import, the complete current import
 * population becomes a stable sparse denominator: required imports can be
 * planned immediately, dead siblings remain unplanned, and imports registered
 * later receive deterministic trailing ordinals.
 */
export class ProgramAbiCallableImportRegistry {
  private readonly preparedPublication = new Map<"sealedEntries", readonly ProgramAbiCallableImport[]>();
  private readonly plannedByImport = new Map<Import, PlannedCallableImport>();
  private plannedValue: ReadonlyMap<string, IrBindingId> | undefined;

  private get sealedEntries(): readonly ProgramAbiCallableImport[] | undefined {
    return this.preparedPublication.get("sealedEntries");
  }

  private set sealedEntries(entries: readonly ProgramAbiCallableImport[] | undefined) {
    if (entries === undefined) this.preparedPublication.delete("sealedEntries");
    else this.preparedPublication.set("sealedEntries", entries);
  }

  constructor(
    readonly session: NonNullable<CodegenContext["programAbiSession"]>,
    readonly ctx: CodegenContext,
  ) {
    session.assertModule(ctx.mod);
  }

  catalog(): ReadonlyMap<string, Import> {
    const entries = this.sealedEntries ?? collectProgramAbiCallableImports(this.ctx);
    return new ImmutableProgramAbiImportCatalog(entries.map(({ key, value }) => Object.freeze([key, value] as const)));
  }

  describePrepared(values: ReadonlySet<Import>): PreparedCallableImportDescriptor {
    if (this.plannedValue) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot describe prepared callable imports after retained import planning",
      );
    }
    const sealedEntries = this.sealedEntries;
    const denominator = this.describeDenominator(sealedEntries ?? collectProgramAbiCallableImports(this.ctx));
    const current = collectProgramAbiCallableImports(this.ctx);
    const selected = Object.freeze([...values].map((value) => this.describeSelectedEntry(value, denominator, current)));
    const descriptor = Object.freeze({ kind: "prepared-callable-import-descriptor" as const });
    preparedCallableImportDescriptors.set(
      descriptor,
      Object.freeze({
        registry: this,
        lifecycle: Object.freeze({
          state: new Map<"state" | "scopeId", string>([["state", "fresh"]]),
        }),
        sealedEntries,
        denominator,
        selected,
      }),
    );
    return descriptor;
  }

  assertPreparedDescriptorCurrent(descriptor: PreparedCallableImportDescriptor): void {
    const payload = this.requirePreparedDescriptor(descriptor);
    if (this.plannedValue) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "prepared callable-import descriptor crossed retained import planning",
      );
    }
    if (payload.sealedEntries === undefined) {
      if (this.sealedEntries !== undefined) {
        throw callableImportError("prepared callable-import descriptor crossed a denominator seal");
      }
    } else if (this.sealedEntries !== payload.sealedEntries) {
      throw callableImportError("prepared callable-import descriptor no longer owns the exact sealed denominator");
    }

    const denominator = this.describeDenominator(payload.sealedEntries ?? collectProgramAbiCallableImports(this.ctx));
    this.assertSameDenominator(payload.denominator, denominator);
    const current = collectProgramAbiCallableImports(this.ctx);
    for (const expected of payload.selected) {
      const actual = this.describeSelectedEntry(expected.entry.value, denominator, current);
      this.assertSameSelectedEntry(expected, actual);
    }
  }

  preparedDescriptorBindingId(descriptor: PreparedCallableImportDescriptor, value: Import): IrBindingId | undefined {
    const payload = this.requirePreparedDescriptor(descriptor);
    const selected = payload.selected.find((entry) => entry.entry.value === value);
    if (!selected) {
      this.assertPreparedDescriptorCurrent(descriptor);
      return undefined;
    }
    const planned = this.plannedByImport.get(value);
    if (planned?.bindingId === selected.bindingId) {
      this.assertPreparedDescriptorPublished(payload);
    } else {
      this.assertPreparedDescriptorCurrent(descriptor);
    }
    return selected.bindingId;
  }

  publishPreparedDescriptor(descriptor: PreparedCallableImportDescriptor): void {
    const payload = this.requirePreparedDescriptor(descriptor);
    assertDescriptorFresh(payload.lifecycle, "callable-import");
    this.assertPreparedDescriptorCurrent(descriptor);
    if (payload.selected.length === 0) return;
    this.sealedEntries ??= Object.freeze(payload.denominator.map(({ entry }) => entry));
    for (const entry of payload.selected) this.planPreparedEntry(entry);
  }

  planPrepared(values: ReadonlySet<Import>): void {
    if (values.size === 0) return;
    this.publishPreparedDescriptor(this.describePrepared(values));
  }

  planRetained(): ReadonlyMap<string, IrBindingId> {
    if (this.plannedValue) return this.plannedValue;
    const current = collectProgramAbiCallableImports(this.ctx);
    if (!this.sealedEntries) {
      current.forEach((entry, ordinal) => this.planEntry(entry, ordinal));
    } else {
      const currentImports = new Set(current.map((entry) => entry.value));
      const sealedImports = new Set(this.sealedEntries.map((entry) => entry.value));
      this.sealedEntries.forEach((entry, ordinal) => {
        if (currentImports.has(entry.value)) {
          this.planEntry(entry, ordinal);
        } else if (this.plannedByImport.has(entry.value)) {
          throw callableImportError(`prepared callable import ${entry.key} was removed after its ABI scope sealed`);
        }
      });

      const reservedKeys = new Set(this.sealedEntries.map((entry) => entry.key));
      let ordinal = this.sealedEntries.length;
      for (const entry of current.filter((candidate) => !sealedImports.has(candidate.value))) {
        let key = entry.key;
        for (let duplicate = 0; reservedKeys.has(key); duplicate++) {
          key = `${entry.key}|post-preparation|${duplicate}`;
        }
        reservedKeys.add(key);
        this.planEntry(Object.freeze({ ...entry, key }), ordinal++);
      }
    }
    const retainedImports = new Set(current.map((entry) => entry.value));
    const planned = [...this.plannedByImport.entries()]
      .filter(([value]) => retainedImports.has(value))
      .map(([, entry]) => entry)
      .sort((left, right) => left.ordinal - right.ordinal);
    this.plannedValue = new ImmutableProgramAbiImportCatalog(
      planned.map(({ key, bindingId }) => Object.freeze([key, bindingId] as const)),
    );
    return this.plannedValue;
  }

  private requirePreparedDescriptor(
    descriptor: PreparedCallableImportDescriptor,
  ): PreparedCallableImportDescriptorPayload {
    const payload = preparedCallableImportDescriptors.get(descriptor);
    if (!payload || payload.registry !== this) {
      throw callableImportError("prepared callable-import descriptor is forged or belongs to another registry");
    }
    return payload;
  }

  private assertPreparedDescriptorPublished(payload: PreparedCallableImportDescriptorPayload): void {
    if (this.plannedValue || !this.sealedEntries) {
      throw callableImportError("prepared callable-import descriptor is neither fresh nor exactly published");
    }
    const denominator = this.describeDenominator(this.sealedEntries);
    this.assertSameDenominator(payload.denominator, denominator);
    const current = collectProgramAbiCallableImports(this.ctx);
    for (const expected of payload.selected) {
      const actual = this.describeSelectedEntry(expected.entry.value, denominator, current);
      if (
        !callableImportEntriesEqual(actual.entry, expected.entry) ||
        actual.ordinal !== expected.ordinal ||
        actual.bindingId !== expected.bindingId ||
        actual.descriptor !== expected.descriptor ||
        actual.signature !== expected.signature ||
        actual.locator.value !== expected.locator.value ||
        !callableTypeContractsEqual(actual.typeContract, expected.typeContract) ||
        !callableDraftsEqual(actual.draft, expected.draft) ||
        actual.planned?.key !== expected.entry.key ||
        actual.planned.bindingId !== expected.bindingId ||
        actual.planned.ordinal !== expected.ordinal ||
        !callableDraftsEqual(actual.session.draft, expected.draft) ||
        actual.session.structuralOrderOwner !== expected.bindingId ||
        !exactBindingIdsEqual(actual.session.structuralReferenceBindingIds, [expected.bindingId]) ||
        actual.session.locatorOwner !== expected.bindingId ||
        !actual.session.hasExactLocator
      ) {
        throw callableImportError(`published callable import ${expected.entry.key} no longer matches its descriptor`);
      }
    }
  }

  private describeDenominator(
    entries: readonly ProgramAbiCallableImport[],
  ): readonly PreparedCallableImportDenominatorEntry[] {
    const entrySourceId = canonicalEntrySource(this.ctx);
    const exactImports = new Set<Import>();
    const exactKeys = new Set<string>();
    const exactBindingIds = new Set<IrBindingId>();
    return Object.freeze(
      entries.map((entry, ordinal) => {
        if (exactImports.has(entry.value)) {
          throw callableImportError(`callable import ${entry.key} reuses one allocator object in multiple slots`);
        }
        if (exactKeys.has(entry.key)) {
          throw callableImportError(`callable import denominator repeats structural key ${entry.key}`);
        }
        exactImports.add(entry.value);
        exactKeys.add(entry.key);
        const signature = callableImportSignature(this.ctx, entry.value);
        if (signature !== entry.signature) {
          throw callableImportError(`callable import ${entry.key} changed its exact function type object`);
        }
        const bindingId = createIrBindingId({
          ownerId: entrySourceId,
          domain: "callable",
          role: PROGRAM_ABI_IMPORT_CALLABLE_BINDING_ROLE,
          ordinal,
        });
        if (exactBindingIds.has(bindingId)) {
          throw callableImportError(`callable import ${entry.key} collides on projected binding ${bindingId}`);
        }
        exactBindingIds.add(bindingId);
        return Object.freeze({
          entry,
          descriptor: entry.value.desc,
          signature,
          typeContract: cloneProgramAbiCallableTypeContract(signature),
        });
      }),
    );
  }

  private describeSelectedEntry(
    value: Import,
    denominator: readonly PreparedCallableImportDenominatorEntry[],
    current: readonly ProgramAbiCallableImport[],
  ): PreparedCallableImportEntry {
    const ordinal = denominator.findIndex((entry) => entry.entry.value === value);
    if (ordinal < 0) {
      throw callableImportError("prepared callable import is outside the sealed pre-DCE import population");
    }
    const currentEntries = current.filter((entry) => entry.value === value);
    if (currentEntries.length !== 1) {
      throw callableImportError(
        `prepared callable import ${denominator[ordinal]!.entry.key} must appear exactly once in the current population`,
      );
    }
    const denominatorEntry = denominator[ordinal]!;
    const currentEntry = currentEntries[0]!;
    if (
      currentEntry.key !== denominatorEntry.entry.key ||
      currentEntry.baseKey !== denominatorEntry.entry.baseKey ||
      currentEntry.signature !== denominatorEntry.signature ||
      currentEntry.value.desc !== denominatorEntry.descriptor ||
      currentEntry.capabilityId !== denominatorEntry.entry.capabilityId ||
      currentEntry.providerId !== denominatorEntry.entry.providerId ||
      !callableTypeContractsEqual(
        denominatorEntry.typeContract,
        cloneProgramAbiCallableTypeContract(currentEntry.signature),
      )
    ) {
      throw callableImportError(`prepared callable import ${denominatorEntry.entry.key} changed structural identity`);
    }

    const entrySourceId = canonicalEntrySource(this.ctx);
    const bindingId = createIrBindingId({
      ownerId: entrySourceId,
      domain: "callable",
      role: PROGRAM_ABI_IMPORT_CALLABLE_BINDING_ROLE,
      ordinal,
    });
    const draft = Object.freeze({
      id: bindingId,
      structuralOrder: Object.freeze({
        ...this.session.structuralOrder.forSource(entrySourceId, {
          domain: "callable",
          roleOrdinal: PROGRAM_ABI_IMPORT_CALLABLE_ROLE.importedFunction,
          derivedOrdinal: ordinal,
        }),
      }),
      structuralReferenceKey: denominatorEntry.entry.key,
      displayName: value.name,
      slotPolicy: "required" as const,
      slotSpace: "function" as const,
      intent: Object.freeze({
        kind: "callable" as const,
        origin: "import" as const,
        signature: canonicalProgramAbiCallableTypeContract(denominatorEntry.typeContract),
        ...(denominatorEntry.entry.capabilityId
          ? {
              capabilityId: denominatorEntry.entry.capabilityId,
              providerId: denominatorEntry.entry.providerId,
            }
          : {}),
      }),
    }) satisfies ProgramAbiDraft;
    const planned = this.plannedByImport.get(value);
    if (planned && (planned.key !== denominatorEntry.entry.key || planned.ordinal !== ordinal)) {
      throw callableImportError(`callable import ${denominatorEntry.entry.key} changed its sealed structural identity`);
    }
    const session = Object.freeze({
      draft: this.session.getDraft(bindingId),
      structuralOrderOwner: draftStructuralOrderOwner(this.session, draft),
      structuralReferenceBindingIds: Object.freeze([
        ...this.session.bindingIdsForStructuralReference(denominatorEntry.entry.key),
      ]),
      locatorOwner: this.session.locatorBindingId(value),
      hasExactLocator: this.session.hasLocator(bindingId, value),
    });
    const expectedIds = planned ? Object.freeze([bindingId]) : Object.freeze([]);
    if (
      !callableDraftsEqual(session.draft, planned ? draft : undefined) ||
      session.structuralOrderOwner !== (planned ? bindingId : undefined) ||
      !exactBindingIdsEqual(session.structuralReferenceBindingIds, expectedIds) ||
      session.locatorOwner !== (planned ? bindingId : undefined) ||
      session.hasExactLocator !== (planned !== undefined)
    ) {
      throw callableImportError(
        `prepared callable import ${denominatorEntry.entry.key} disagrees with current session ownership`,
      );
    }
    return Object.freeze({
      ...denominatorEntry,
      ordinal,
      bindingId,
      draft,
      locator: Object.freeze({ kind: "import-function" as const, value }),
      planned,
      session,
    });
  }

  private assertSameDenominator(
    expected: readonly PreparedCallableImportDenominatorEntry[],
    actual: readonly PreparedCallableImportDenominatorEntry[],
  ): void {
    if (
      expected.length !== actual.length ||
      expected.some((entry, index) => {
        const current = actual[index]!;
        return (
          !callableImportEntriesEqual(entry.entry, current.entry) ||
          entry.descriptor !== current.descriptor ||
          entry.signature !== current.signature ||
          entry.entry.capabilityId !== current.entry.capabilityId ||
          entry.entry.providerId !== current.entry.providerId ||
          !callableTypeContractsEqual(entry.typeContract, current.typeContract)
        );
      })
    ) {
      throw callableImportError("prepared callable-import descriptor denominator is stale");
    }
  }

  private assertSameSelectedEntry(expected: PreparedCallableImportEntry, actual: PreparedCallableImportEntry): void {
    if (
      !callableImportEntriesEqual(expected.entry, actual.entry) ||
      expected.ordinal !== actual.ordinal ||
      expected.bindingId !== actual.bindingId ||
      expected.descriptor !== actual.descriptor ||
      expected.signature !== actual.signature ||
      expected.planned !== actual.planned ||
      expected.locator.value !== actual.locator.value ||
      !callableTypeContractsEqual(expected.typeContract, actual.typeContract) ||
      !callableDraftsEqual(expected.draft, actual.draft) ||
      !callableDraftsEqual(expected.session.draft, actual.session.draft) ||
      expected.session.structuralOrderOwner !== actual.session.structuralOrderOwner ||
      !exactBindingIdsEqual(
        expected.session.structuralReferenceBindingIds,
        actual.session.structuralReferenceBindingIds,
      ) ||
      expected.session.locatorOwner !== actual.session.locatorOwner ||
      expected.session.hasExactLocator !== actual.session.hasExactLocator
    ) {
      throw callableImportError(`prepared callable import ${expected.entry.key} descriptor is stale`);
    }
  }

  private planPreparedEntry(entry: PreparedCallableImportEntry): IrBindingId {
    const existing = this.plannedByImport.get(entry.entry.value);
    if (existing) return existing.bindingId;
    this.session.ensurePlan(entry.draft);
    this.session.registerCallableTypeContract(entry.bindingId, entry.typeContract);
    this.session.registerStructuralReference(entry.bindingId, entry.entry.key);
    this.session.attachLocator(entry.bindingId, entry.locator);
    this.plannedByImport.set(
      entry.entry.value,
      Object.freeze({ key: entry.entry.key, bindingId: entry.bindingId, ordinal: entry.ordinal }),
    );
    return entry.bindingId;
  }

  /** Build one scope-authenticated write set without publishing it. */
  prepareDescriptorForScope(
    descriptor: PreparedCallableImportDescriptor,
    session: ProgramAbiSession,
    scopeId: string,
  ): PreparedProgramAbiDescriptorPart {
    const payload = this.requirePreparedDescriptor(descriptor);
    if (session !== this.session || scopeId.length === 0) {
      throw callableImportError("prepared callable-import descriptor targets a foreign session or empty scope");
    }
    assertDescriptorFresh(payload.lifecycle, "callable-import");
    payload.lifecycle.state.set("scopeId", scopeId);
    payload.lifecycle.state.set("state", "claimed");
    try {
      this.assertPreparedDescriptorCurrent(descriptor);
      const bindings = Object.freeze(
        payload.selected.map(
          (entry): PreparedProgramAbiProvisionalBinding =>
            Object.freeze({
              draft: entry.draft,
              structuralReferenceKey: entry.entry.key,
              locator: entry.locator,
              callableTypeContract: entry.typeContract,
            }),
        ),
      );
      const registryWrites: PreparedProgramAbiMapWrite[] = [];
      if (payload.selected.length > 0 && this.sealedEntries === undefined) {
        registryWrites.push(
          Object.freeze({
            target: this.preparedPublication as Map<unknown, unknown>,
            key: "sealedEntries",
            value: Object.freeze(payload.denominator.map(({ entry }) => entry)),
          }),
        );
      }
      for (const entry of payload.selected) {
        if (entry.planned !== undefined) continue;
        registryWrites.push(
          Object.freeze({
            target: this.plannedByImport as Map<unknown, unknown>,
            key: entry.entry.value,
            value: Object.freeze({ key: entry.entry.key, bindingId: entry.bindingId, ordinal: entry.ordinal }),
          }),
        );
      }
      const keys = Object.freeze(payload.selected.map((entry) => entry.entry.key));
      return Object.freeze({
        kind: "callable-imports" as const,
        session,
        descriptor,
        lifecycle: payload.lifecycle,
        bindings,
        requestedStructuralReferenceKeys: keys,
        closureStructuralReferenceKeys: Object.freeze([]),
        registryWrites: Object.freeze(registryWrites),
        assertCurrent: () => {
          assertDescriptorClaimed(payload.lifecycle, scopeId, "callable-import");
          this.assertPreparedDescriptorCurrent(descriptor);
        },
      });
    } catch (error) {
      payload.lifecycle.state.set("state", "consumed");
      throw error;
    }
  }

  private planEntry(entry: ProgramAbiCallableImport, ordinal: number): IrBindingId {
    const existing = this.plannedByImport.get(entry.value);
    if (existing) {
      if (existing.key !== entry.key || existing.ordinal !== ordinal) {
        throw callableImportError(`callable import ${entry.key} changed its sealed structural identity`);
      }
      return existing.bindingId;
    }
    const entrySourceId = canonicalEntrySource(this.ctx);
    const bindingId = createIrBindingId({
      ownerId: entrySourceId,
      domain: "callable",
      role: PROGRAM_ABI_IMPORT_CALLABLE_BINDING_ROLE,
      ordinal,
    });
    const typeContract = cloneProgramAbiCallableTypeContract(callableImportSignature(this.ctx, entry.value));
    this.session.ensurePlan({
      id: bindingId,
      structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
        domain: "callable",
        roleOrdinal: PROGRAM_ABI_IMPORT_CALLABLE_ROLE.importedFunction,
        derivedOrdinal: ordinal,
      }),
      structuralReferenceKey: entry.key,
      displayName: entry.value.name,
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "import",
        signature: canonicalProgramAbiCallableTypeContract(typeContract),
        ...(entry.capabilityId ? { capabilityId: entry.capabilityId, providerId: entry.providerId } : {}),
      },
    });
    this.session.registerCallableTypeContract(bindingId, typeContract);
    this.session.registerStructuralReference(bindingId, entry.key);
    if (!this.session.hasLocator(bindingId, entry.value)) {
      this.session.attachLocator(bindingId, { kind: "import-function", value: entry.value });
    }
    this.plannedByImport.set(entry.value, Object.freeze({ key: entry.key, bindingId, ordinal }));
    return bindingId;
  }
}

function descriptorLifecycleState(lifecycle: PreparedProgramAbiDescriptorLifecycle): string | undefined {
  return lifecycle.state.get("state");
}

function assertDescriptorFresh(lifecycle: PreparedProgramAbiDescriptorLifecycle, kind: string): void {
  if (descriptorLifecycleState(lifecycle) !== "fresh" || lifecycle.state.has("scopeId")) {
    throw callableImportError(`prepared ${kind} descriptor is not fresh`);
  }
}

function assertDescriptorClaimed(
  lifecycle: PreparedProgramAbiDescriptorLifecycle,
  scopeId: string,
  kind: string,
): void {
  if (descriptorLifecycleState(lifecycle) !== "claimed" || lifecycle.state.get("scopeId") !== scopeId) {
    throw callableImportError(`prepared ${kind} descriptor is not claimed by exact scope ${scopeId}`);
  }
}

export function prepareCallableImportDescriptorForScope(
  descriptor: PreparedCallableImportDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): PreparedProgramAbiDescriptorPart {
  const payload = preparedCallableImportDescriptors.get(descriptor);
  if (!payload) throw callableImportError("prepared callable-import descriptor is forged");
  return payload.registry.prepareDescriptorForScope(descriptor, session, scopeId);
}

export function consumePreparedCallableImportDescriptor(
  descriptor: PreparedCallableImportDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): void {
  const payload = preparedCallableImportDescriptors.get(descriptor);
  if (!payload || payload.registry.session !== session) {
    throw callableImportError("prepared callable-import descriptor is forged or belongs to another session");
  }
  assertDescriptorClaimed(payload.lifecycle, scopeId, "callable-import");
  payload.lifecycle.state.set("state", "consumed");
}

function callableImportRegistry(ctx: CodegenContext): ProgramAbiCallableImportRegistry | undefined {
  const session = ctx.programAbiSession;
  if (!session) return undefined;
  return (ctx.programAbiCallableImports ??= new ProgramAbiCallableImportRegistry(session, ctx));
}

/**
 * Snapshot the exact function-import objects available to pre-DCE lowering.
 *
 * This catalog deliberately creates no ABI drafts: dead-import elimination may
 * remove members of this population. Integration can still resolve a symbolic
 * import through the exact object without making an eliminated slot required
 * at final publication.
 */
export function catalogProgramAbiCallableImports(ctx: CodegenContext): ReadonlyMap<string, Import> {
  const registry = callableImportRegistry(ctx);
  if (registry) return registry.catalog();
  return new ImmutableProgramAbiImportCatalog(
    collectProgramAbiCallableImports(ctx).map(({ key, value }) => Object.freeze([key, value] as const)),
  );
}

/**
 * Plan every retained function import after dead-import elimination.
 *
 * Import identity is the exact module/field pair. The compatibility label is
 * excluded from both lookup and allocation: canonical keys are sorted before
 * opaque entry-source-owned binding IDs and ABI order are assigned. The
 * returned catalog exposes only ReadonlyMap operations, so integration cannot
 * accidentally mutate or re-key the authoritative population.
 */
export function planProgramAbiCallableImports(ctx: CodegenContext): ReadonlyMap<string, IrBindingId> {
  return callableImportRegistry(ctx)?.planRetained() ?? EMPTY_PROGRAM_ABI_IMPORT_CATALOG;
}

/**
 * Plan one successfully inserted host string-constant import.
 *
 * String constants are program support owned by the canonical entry source.
 * Their stable literal ordinal disambiguates structural plan order, while the
 * binding itself is keyed by the exact import module/field payload rather than
 * its temporary `__str_N` compatibility label.
 */
export function planProgramAbiStringConstantImport(ctx: CodegenContext, value: Import, stableOrdinal: number): void {
  const session = ctx.programAbiSession;
  if (!session) return;
  if (value.desc.kind !== "global") {
    throw new ProgramAbiInvariantError(
      "slot-locator-space-mismatch",
      "string-constant ABI planning requires a global import object",
    );
  }
  const entrySources = session.inventory.sources.filter((source) => source.kind === "entry");
  if (entrySources.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `string-constant ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
    );
  }
  const entrySource = entrySources[0]!;
  const adapterName = `__str_${stableOrdinal}`;
  const ref = irImportGlobalRef(entrySource.id, value.module, value.name, adapterName, stableOrdinal);
  const structuralReferenceKey = irGlobalBindingKey(ref.binding);
  session.ensurePlan({
    id: ref.binding.bindingId,
    structuralOrder: session.structuralOrder.forSource(entrySource.id, {
      domain: "global",
      roleOrdinal: PROGRAM_ABI_IMPORT_GLOBAL_ROLE.stringConstant,
      derivedOrdinal: stableOrdinal,
    }),
    structuralReferenceKey,
    displayName: ref.name,
    slotPolicy: "required",
    slotSpace: "global",
    intent: {
      kind: "global",
      origin: "import",
      valueType: JSON.stringify(value.desc.type),
      mutable: value.desc.mutable,
    },
  });
  session.registerGlobalTypeContract(ref.binding.bindingId, value.desc.type, value.desc.mutable);
  session.registerStructuralReference(ref.binding.bindingId, structuralReferenceKey);
  if (!session.hasLocator(ref.binding.bindingId, value)) {
    session.attachLocator(ref.binding.bindingId, { kind: "import-global", value });
  }
}

/**
 * Recover the exact symbolic ref for a previously registered host string
 * constant. The allocator object and its Program-ABI owner are authoritative;
 * `stringGlobalMap` is used only to find that object in the current import
 * population.
 */
export function programAbiStringConstantRef(ctx: CodegenContext, literal: string): IrGlobalRef | undefined {
  const session = ctx.programAbiSession;
  const globalIndex = ctx.stringGlobalMap.get(literal);
  if (!session || globalIndex === undefined || globalIndex < 0) return undefined;

  let currentGlobalIndex = 0;
  let imported: Import | undefined;
  for (const value of ctx.mod.imports) {
    if (value.desc.kind !== "global") continue;
    if (currentGlobalIndex++ === globalIndex) {
      imported = value;
      break;
    }
  }
  if (!imported || imported.desc.kind !== "global") {
    throw new ProgramAbiInvariantError(
      "missing-required-locator",
      `string constant ${JSON.stringify(literal)} has no exact imported-global allocator object`,
    );
  }
  const bindingId = session.locatorBindingId(imported);
  if (!bindingId) {
    throw new ProgramAbiInvariantError(
      "unknown-locator-binding",
      `string constant ${JSON.stringify(literal)} has no Program ABI owner`,
    );
  }
  const adapterName = ctx.stringLiteralMap.get(literal) ?? `__str_${globalIndex}`;
  const ref = irPlannedImportGlobalRef(bindingId, imported.module, imported.name, adapterName);
  const structuralReferenceKey = irGlobalBindingKey(ref.binding);
  if (!session.bindingIdsForStructuralReference(structuralReferenceKey).includes(bindingId)) {
    throw new ProgramAbiInvariantError(
      "binding-reference-mismatch",
      `string constant ${JSON.stringify(literal)} does not match its planned import identity`,
    );
  }
  return ref;
}
