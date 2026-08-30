// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey } from "../ir/callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrSourceId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { IrFuncRef } from "../ir/nodes.js";
import type { FuncTypeDef, Import, WasmFunction, WasmModule } from "../ir/types.js";
import { definedFuncAt, definedFuncHandleOf, isImportFuncIdx } from "./func-space.js";
import { programAbiIntentsEqual } from "./program-abi-intent-equality.js";
import type { ProgramAbiCallableImportRegistry } from "./program-abi-import-planning.js";
import { PROGRAM_ABI_CALLABLE_ROLE } from "./program-abi-callable-roles.js";
import type { CodegenContext } from "./context/types.js";
import type {
  PreparedProgramAbiDescriptorLifecycle,
  PreparedProgramAbiDescriptorPart,
  PreparedProgramAbiMapWrite,
  PreparedProgramAbiProvisionalBinding,
} from "./program-abi-prepared-transaction.js";
import type { ProgramAbiDraft, ProgramAbiSession, ProgramAbiSlotLocator } from "./program-abi-session.js";
import {
  canonicalProgramAbiCallableTypeContract,
  cloneProgramAbiCallableTypeContract,
  programAbiCallableSignaturesEqual,
  type ProgramAbiCallableTypeContract,
} from "./program-abi-signatures.js";

// (#4033) Sourced from the shared role table, NOT a local literal. This was
// `= 5`, which silently duplicated `PROGRAM_ABI_CALLABLE_ROLE.moduleInit`.
const PROGRAM_ABI_PROVIDER_ROLE_ORDINAL = PROGRAM_ABI_CALLABLE_ROLE.callableProvider;

type ProviderBinding = Extract<IrFuncRef["binding"], { readonly kind: "runtime" | "intrinsic" }>;
type ProviderLocator =
  | { readonly kind: "import-function"; readonly value: Import }
  | { readonly kind: "defined-function"; readonly value: WasmFunction };

interface ObservedProvider {
  readonly binding: ProviderBinding;
  readonly structuralReferenceKey: string;
  readonly locator: ProviderLocator;
}

type PreparedCallableImportDescriptor = ReturnType<ProgramAbiCallableImportRegistry["describePrepared"]>;

interface PreparedCallableProviderDenominatorEntry {
  readonly provider: ObservedProvider;
  readonly ordinal: number;
  readonly typeIndex: number;
  readonly signature: FuncTypeDef;
  readonly typeContract: ProgramAbiCallableTypeContract;
}

interface PreparedCallableProviderSessionSnapshot {
  readonly draft: ProgramAbiDraft | undefined;
  readonly structuralOrderOwner: IrBindingId | undefined;
  readonly structuralReferenceBindingIds: readonly IrBindingId[];
  readonly locatorOwner: IrBindingId | undefined;
  readonly hasExactLocator: boolean;
}

type PreparedCallableProviderOwnerKind = "committed" | "batch-provider" | "provisional-import";

interface PreparedCallableProviderEntry extends PreparedCallableProviderDenominatorEntry {
  readonly bindingId: IrBindingId;
  readonly draft: ProgramAbiDraft;
  readonly canonicalOwner: IrBindingId;
  readonly ownerKind: PreparedCallableProviderOwnerKind;
  readonly ownsLocator: boolean;
  readonly planned: IrBindingId | undefined;
  readonly session: PreparedCallableProviderSessionSnapshot;
}

interface PreparedCallableProviderDescriptorPayload {
  readonly registry: ProgramAbiCallableProviderRegistry;
  readonly lifecycle: PreparedProgramAbiDescriptorLifecycle;
  readonly observationOrder: readonly string[] | undefined;
  readonly appendedOrder: readonly string[];
  readonly denominator: readonly PreparedCallableProviderDenominatorEntry[];
  readonly selected: readonly PreparedCallableProviderEntry[];
  readonly requestedKeys: readonly string[];
  readonly returnKeys: readonly string[];
  readonly importDescriptor: PreparedCallableImportDescriptor | undefined;
}

/** Opaque registry-authenticated token; its payload never crosses this module. */
export interface PreparedCallableProviderDescriptor {
  readonly kind: "prepared-callable-provider-descriptor";
}

const preparedCallableProviderDescriptors = new WeakMap<
  PreparedCallableProviderDescriptor,
  PreparedCallableProviderDescriptorPayload
>();

function providerError(message: string): ProgramAbiInvariantError {
  return new ProgramAbiInvariantError("callable-provider-mismatch", message);
}

function callableLocatorAt(ctx: CodegenContext, index: number): ProviderLocator {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw providerError(`callable provider resolved to invalid function index ${index}`);
  }
  if (isImportFuncIdx(ctx, index)) {
    let importIndex = 0;
    for (const imported of ctx.mod.imports) {
      if (imported.desc.kind !== "func") continue;
      if (importIndex++ === index) return Object.freeze({ kind: "import-function", value: imported });
    }
  }
  const defined = definedFuncAt(ctx, index);
  if (!defined) {
    throw providerError(
      `callable provider handle ${index} is outside the current import/definition allocator population`,
    );
  }
  return Object.freeze({ kind: "defined-function", value: defined });
}

function currentCallableIndex(ctx: CodegenContext, locator: ProviderLocator): number | undefined {
  let importIndex = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (locator.kind === "import-function" && imported === locator.value) return importIndex;
    importIndex++;
  }
  if (locator.kind === "import-function") return undefined;
  return definedFuncHandleOf(ctx, locator.value);
}

function callableSignature(module: WasmModule, locator: ProviderLocator): FuncTypeDef {
  let typeIdx: number;
  if (locator.kind === "import-function") {
    if (locator.value.desc.kind !== "func") {
      throw providerError("import-function provider locator no longer carries a function descriptor");
    }
    typeIdx = locator.value.desc.typeIdx;
  } else {
    typeIdx = locator.value.typeIdx;
  }
  const signature = module.types[typeIdx];
  if (!signature || signature.kind !== "func") {
    throw providerError(`${locator.kind} callable provider references non-function or missing type ${String(typeIdx)}`);
  }
  return signature;
}

function canonicalEntrySource(session: ProgramAbiSession): IrSourceId {
  const entrySources = session.inventory.sources.filter((source) => source.kind === "entry");
  if (entrySources.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `callable-provider ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
    );
  }
  return entrySources[0]!.id;
}

function sameLocator(left: ProviderLocator, right: ProviderLocator): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function callableTypeIndex(locator: ProviderLocator): number {
  if (locator.kind === "import-function") {
    if (locator.value.desc.kind !== "func") {
      throw providerError("import-function provider locator no longer carries a function descriptor");
    }
    return locator.value.desc.typeIdx;
  }
  return locator.value.typeIdx;
}

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

function exactStringsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
 * Compilation-wide exact provider sidecar for runtime/intrinsic references.
 *
 * Resolution records the allocator object selected by the compatibility
 * provider layer, not its transient numeric index. Final planning is delayed
 * until dead-import/type compaction has settled. At that boundary a semantic
 * provider aliases an already-owned callable locator when possible, otherwise
 * the lexically first structural provider key becomes the locator owner.
 */
export class ProgramAbiCallableProviderRegistry {
  private readonly observed = new Map<string, ObservedProvider>();
  private readonly preparedPublication = new Map<"observationOrder", readonly string[]>();
  /**
   * (#4514) Provider keys first observed AFTER `sealObservationOrder`, in
   * discovery order. They extend the sealed order at the tail, so no already
   * minted ordinal can move; see `observe`.
   */
  private readonly appendedOrder: string[] = [];
  private readonly plannedByKey = new Map<string, IrBindingId>();
  private plannedValue: ReadonlyMap<string, IrBindingId> | undefined;

  private get observationOrder(): readonly string[] | undefined {
    return this.preparedPublication.get("observationOrder");
  }

  private set observationOrder(order: readonly string[] | undefined) {
    if (order === undefined) this.preparedPublication.delete("observationOrder");
    else this.preparedPublication.set("observationOrder", order);
  }

  constructor(
    readonly session: ProgramAbiSession,
    readonly ctx: CodegenContext,
  ) {
    session.assertModule(ctx.mod);
  }

  /**
   * Return the current slot for an already observed provider.
   *
   * Exact object lookup follows import shifts without consulting funcMap or
   * scanning display names. Undefined means this structural provider has not
   * crossed the compatibility selection boundary yet.
   */
  resolveCurrentIndex(ref: IrFuncRef): number | undefined {
    const binding = this.requireProviderBinding(ref);
    const structuralReferenceKey = irCallableBindingKey(binding);
    const observed = this.observed.get(structuralReferenceKey);
    if (!observed) return undefined;
    const index = currentCallableIndex(this.ctx, observed.locator);
    if (index === undefined) {
      throw providerError(`callable provider ${structuralReferenceKey} lost its exact allocator object`);
    }
    return index;
  }

  /**
   * Capture one compatibility-selected provider as an exact allocator object.
   *
   * Repeated observations must resolve the same structural binding to the same
   * object. Compatibility labels are deliberately excluded from the key.
   */
  observe(ref: IrFuncRef, index: number): number {
    if (this.plannedValue) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `cannot observe callable provider ${ref.name} after provider ABI planning`,
      );
    }
    const binding = this.requireProviderBinding(ref);
    const structuralReferenceKey = irCallableBindingKey(binding);
    const locator = callableLocatorAt(this.ctx, index);
    const existing = this.observed.get(structuralReferenceKey);
    if (!existing && this.observationOrder) {
      // (#4514) A provider discovered after prepared planning is APPENDED to
      // the sealed order, never merged into it. What the seal protects is that
      // an ordinal already minted into an `IrBindingId` / structural order can
      // never move: ordinals are positions in this array, so re-sorting a late
      // key into the middle would renumber earlier providers. Appending cannot
      // — every sealed position keeps its index and the newcomer takes a fresh
      // one past the end. Refusing late discovery outright made partial
      // preparation of a source file fatal: the first prepared transaction
      // sealed the denominator for the WHOLE compilation, so any unit left on
      // the late route that needed a not-yet-observed runtime helper threw
      // (measured on `algorithms.ts` standalone: preparing four ABI-certified
      // owners made `__extern_is_undefined` undiscoverable for `fibMemo`,
      // `main` and the module-init).
      this.appendedOrder.push(structuralReferenceKey);
    }
    if (existing && !sameLocator(existing.locator, locator)) {
      throw providerError(
        `callable provider ${structuralReferenceKey} changed allocator ownership between resolutions`,
      );
    }
    if (!existing) {
      this.observed.set(
        structuralReferenceKey,
        Object.freeze({
          binding: Object.freeze({ ...binding }),
          structuralReferenceKey,
          locator,
        }),
      );
    }
    return this.resolveCurrentIndex(ref)!;
  }

  /**
   * Plan the exact providers required by otherwise dependency-complete
   * prepared components.
   *
   * The first call seals the complete post-pass provider-key denominator, so
   * structural ordinals cannot drift when final planning later discards an
   * import used only by a withdrawn IR candidate. Providers sharing one
   * allocator are planned together to keep the lexically first key as the
   * deterministic canonical owner.
   */
  canPlanPrepared(structuralReferenceKeys: ReadonlySet<string>): boolean {
    for (const key of structuralReferenceKeys) {
      const provider = this.observed.get(key);
      if (!provider) return false;
      if (
        provider.locator.kind === "import-function" &&
        this.session.locatorBindingId(provider.locator.value) === undefined
      ) {
        // A prepared semantic provider may alias an already planned import,
        // but it must not take ownership of an import whose canonical import
        // identity is still intentionally deferred until post-DCE planning.
        return false;
      }
    }
    return true;
  }

  /** Return exact import objects for a complete set of observed provider keys. */
  importsForPreparedProviders(structuralReferenceKeys: ReadonlySet<string>): ReadonlySet<Import> | undefined {
    const imports = new Set<Import>();
    for (const key of structuralReferenceKeys) {
      const provider = this.observed.get(key);
      if (!provider) return undefined;
      if (provider.locator.kind === "import-function") imports.add(provider.locator.value);
    }
    return imports;
  }

  describePrepared(
    structuralReferenceKeys: ReadonlySet<string>,
    exactImportDescriptor?: PreparedCallableImportDescriptor,
  ): PreparedCallableProviderDescriptor {
    if (this.plannedValue) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot describe prepared callable providers after retained provider planning",
      );
    }
    const importRegistry = this.ctx.programAbiCallableImports;
    if (exactImportDescriptor) {
      if (!importRegistry) {
        throw providerError("prepared callable-provider import descriptor has no registry in this context");
      }
      importRegistry.assertPreparedDescriptorCurrent(exactImportDescriptor);
    }
    const observationOrder = this.observationOrder;
    const appendedOrder = Object.freeze([...this.appendedOrder]);
    const denominator = this.describeDenominator(this.currentDescriptionOrder());
    const requestedKeys = Object.freeze([...structuralReferenceKeys]);
    const requestedProviders = requestedKeys.map((key) => {
      const provider = this.observed.get(key);
      if (!provider) {
        throw providerError(`prepared callable provider ${key} was not observed before discovery sealed`);
      }
      return provider;
    });
    const returnKeys = [...requestedKeys];
    const selectedKeys = new Set(returnKeys);
    for (const candidate of this.observed.values()) {
      if (
        requestedProviders.some((requested) => sameLocator(requested.locator, candidate.locator)) &&
        !selectedKeys.has(candidate.structuralReferenceKey)
      ) {
        selectedKeys.add(candidate.structuralReferenceKey);
        returnKeys.push(candidate.structuralReferenceKey);
      }
    }
    const selected = this.describeSelectedEntries(
      denominator.filter(({ provider }) => selectedKeys.has(provider.structuralReferenceKey)),
      exactImportDescriptor,
    );
    const descriptor = Object.freeze({ kind: "prepared-callable-provider-descriptor" as const });
    preparedCallableProviderDescriptors.set(
      descriptor,
      Object.freeze({
        registry: this,
        lifecycle: Object.freeze({
          state: new Map<"state" | "scopeId", string>([["state", "fresh"]]),
        }),
        observationOrder,
        appendedOrder,
        denominator,
        selected,
        requestedKeys,
        returnKeys: Object.freeze(returnKeys),
        importDescriptor: exactImportDescriptor,
      }),
    );
    return descriptor;
  }

  assertPreparedDescriptorCurrent(descriptor: PreparedCallableProviderDescriptor): void {
    const payload = this.requirePreparedDescriptor(descriptor);
    if (this.plannedValue) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "prepared callable-provider descriptor crossed retained provider planning",
      );
    }
    if (payload.observationOrder === undefined) {
      if (this.observationOrder !== undefined) {
        throw providerError("prepared callable-provider descriptor crossed an observation-order seal");
      }
    } else if (this.observationOrder !== payload.observationOrder) {
      throw providerError("prepared callable-provider descriptor lost its exact sealed prefix");
    }
    if (!exactStringsEqual(payload.appendedOrder, this.appendedOrder)) {
      throw providerError("prepared callable-provider descriptor appended suffix is stale");
    }
    const denominator = this.describeDenominator(this.currentDescriptionOrder());
    this.assertSameDenominator(payload.denominator, denominator);
    if (payload.importDescriptor) {
      const importRegistry = this.ctx.programAbiCallableImports;
      if (!importRegistry) {
        throw providerError("prepared callable-provider import descriptor lost its exact registry");
      }
      for (const expected of payload.selected) {
        if (expected.ownerKind !== "provisional-import") continue;
        const bindingId = importRegistry.preparedDescriptorBindingId(
          payload.importDescriptor,
          expected.provider.locator.value as Import,
        );
        if (bindingId !== expected.canonicalOwner) {
          throw providerError(
            `prepared callable provider ${expected.provider.structuralReferenceKey} changed provisional import ownership`,
          );
        }
      }
    }
    const actual = this.describeSelectedEntries(
      denominator.filter(({ provider }) =>
        payload.selected.some((entry) => entry.provider.structuralReferenceKey === provider.structuralReferenceKey),
      ),
      payload.importDescriptor,
    );
    if (actual.length !== payload.selected.length) {
      throw providerError("prepared callable-provider descriptor selection closure is stale");
    }
    payload.selected.forEach((expected, index) => this.assertSameSelectedEntry(expected, actual[index]!));
  }

  /**
   * Return the exact allocator identities authenticated by one still-current
   * prepared descriptor. Export-alias preparation uses these objects before
   * the provider locator rows have crossed the atomic publication boundary.
   */
  preparedDescriptorAllocatorObjects(descriptor: PreparedCallableProviderDescriptor): ReadonlySet<object> {
    const payload = this.requirePreparedDescriptor(descriptor);
    this.assertPreparedDescriptorCurrent(descriptor);
    return new Set(payload.selected.map(({ provider }) => provider.locator.value));
  }

  publishPreparedDescriptor(descriptor: PreparedCallableProviderDescriptor): ReadonlyMap<string, IrBindingId> {
    const payload = this.requirePreparedDescriptor(descriptor);
    assertProviderDescriptorFresh(payload.lifecycle);
    this.assertPreparedDescriptorCurrent(descriptor);
    for (const entry of payload.selected) {
      if (
        entry.ownerKind === "provisional-import" &&
        (this.session.locatorBindingId(entry.provider.locator.value) !== entry.canonicalOwner ||
          !this.session.hasPlan(entry.canonicalOwner))
      ) {
        throw providerError(
          `prepared callable provider ${entry.provider.structuralReferenceKey} cannot publish before its exact import descriptor`,
        );
      }
    }
    this.observationOrder ??= Object.freeze(payload.denominator.map(({ provider }) => provider.structuralReferenceKey));
    for (const entry of payload.selected) this.planPreparedEntry(entry);
    return new Map(
      payload.returnKeys.map((key) => {
        const id = this.plannedByKey.get(key);
        if (!id) throw providerError(`prepared callable provider ${key} did not produce an ABI binding`);
        return [key, id] as const;
      }),
    );
  }

  planPrepared(structuralReferenceKeys: ReadonlySet<string>): ReadonlyMap<string, IrBindingId> {
    if (this.plannedValue) {
      return new Map(
        [...structuralReferenceKeys].map((key) => {
          const id = this.plannedValue!.get(key);
          if (!id) throw providerError(`prepared callable provider ${key} is absent from the final ABI plan`);
          return [key, id] as const;
        }),
      );
    }
    return this.publishPreparedDescriptor(this.describePrepared(structuralReferenceKeys));
  }

  /**
   * Plan every observed provider against the settled post-DCE module layout.
   *
   * Existing import/source/support locator owners remain canonical. Otherwise
   * one deterministic provider entry owns the object and any additional
   * semantic bindings become exact callable aliases.
   */
  planRetained(): ReadonlyMap<string, IrBindingId> {
    if (this.plannedValue) return this.plannedValue;
    const order = this.sealObservationOrder();
    for (let ordinal = 0; ordinal < order.length; ordinal++) {
      const provider = this.observed.get(order[ordinal]!)!;
      if (currentCallableIndex(this.ctx, provider.locator) === undefined) {
        // Resolver observation precedes the ABI-parity withdrawal boundary.
        // When a candidate falls back, DCE legitimately removes an import
        // used only by its discarded IR body. That provider never enters the
        // final ABI. Defined helpers are not eliminated by this pipeline; a
        // missing definition still means allocator ownership was corrupted.
        if (provider.locator.kind === "import-function" && !this.plannedByKey.has(provider.structuralReferenceKey)) {
          continue;
        }
        throw providerError(`callable provider ${provider.structuralReferenceKey} lost its defined allocator object`);
      }
      this.planProvider(provider, ordinal);
    }
    this.plannedValue = new Map(this.plannedByKey);
    return this.plannedValue;
  }

  private requirePreparedDescriptor(
    descriptor: PreparedCallableProviderDescriptor,
  ): PreparedCallableProviderDescriptorPayload {
    const payload = preparedCallableProviderDescriptors.get(descriptor);
    if (!payload || payload.registry !== this) {
      throw providerError("prepared callable-provider descriptor is forged or belongs to another registry");
    }
    return payload;
  }

  private currentDescriptionOrder(): readonly string[] {
    const order =
      this.observationOrder === undefined
        ? [...this.observed.keys()].sort()
        : [...this.observationOrder, ...this.appendedOrder];
    if (
      new Set(order).size !== order.length ||
      order.length !== this.observed.size ||
      order.some((key) => !this.observed.has(key))
    ) {
      throw providerError("callable-provider observation order does not cover the exact observed population");
    }
    return Object.freeze(order);
  }

  private describeDenominator(keys: readonly string[]): readonly PreparedCallableProviderDenominatorEntry[] {
    const entrySourceId = canonicalEntrySource(this.session);
    const exactBindingIds = new Set<IrBindingId>();
    return Object.freeze(
      keys.map((key, ordinal) => {
        const provider = this.observed.get(key);
        if (!provider || provider.structuralReferenceKey !== key) {
          throw providerError(`callable-provider denominator key ${key} has no exact observation`);
        }
        const typeIndex = callableTypeIndex(provider.locator);
        if (!Number.isSafeInteger(typeIndex) || typeIndex < 0) {
          throw providerError(`callable provider ${key} has invalid function type ${String(typeIndex)}`);
        }
        const signature = callableSignature(this.ctx.mod, provider.locator);
        const bindingId = createIrBindingId({
          ownerId: entrySourceId,
          domain: "callable",
          role: `${provider.binding.kind}-provider`,
          ordinal,
        });
        if (exactBindingIds.has(bindingId)) {
          throw providerError(`callable provider ${key} collides on projected binding ${bindingId}`);
        }
        exactBindingIds.add(bindingId);
        return Object.freeze({
          provider,
          ordinal,
          typeIndex,
          signature,
          typeContract: cloneProgramAbiCallableTypeContract(signature),
        });
      }),
    );
  }

  private describeSelectedEntries(
    selected: readonly PreparedCallableProviderDenominatorEntry[],
    exactImportDescriptor: PreparedCallableImportDescriptor | undefined,
  ): readonly PreparedCallableProviderEntry[] {
    const entrySourceId = canonicalEntrySource(this.session);
    const importRegistry = this.ctx.programAbiCallableImports;
    const bindingIds = new Map(
      selected.map((entry) => [
        entry.provider.structuralReferenceKey,
        createIrBindingId({
          ownerId: entrySourceId,
          domain: "callable",
          role: `${entry.provider.binding.kind}-provider`,
          ordinal: entry.ordinal,
        }),
      ]),
    );
    const groupOwner = new Map<
      object,
      { readonly id: IrBindingId; readonly kind: PreparedCallableProviderOwnerKind }
    >();
    for (const entry of selected) {
      const locatorObject = entry.provider.locator.value;
      if (groupOwner.has(locatorObject)) continue;
      const group = selected.filter((candidate) => sameLocator(candidate.provider.locator, entry.provider.locator));
      let canonicalOwner = this.session.locatorBindingId(locatorObject);
      let ownerKind: PreparedCallableProviderOwnerKind = "committed";
      let descriptorOwner: IrBindingId | undefined;
      if (entry.provider.locator.kind === "import-function" && exactImportDescriptor) {
        if (!importRegistry) {
          throw providerError("prepared callable-provider import descriptor lost its exact registry");
        }
        descriptorOwner = importRegistry.preparedDescriptorBindingId(
          exactImportDescriptor,
          entry.provider.locator.value,
        );
        if (descriptorOwner !== undefined) {
          if (canonicalOwner !== undefined && canonicalOwner !== descriptorOwner) {
            throw providerError(
              `callable provider ${entry.provider.structuralReferenceKey} changed its exact import descriptor owner`,
            );
          }
          canonicalOwner = descriptorOwner;
          ownerKind = "provisional-import";
        }
      }
      if (canonicalOwner === undefined) {
        if (entry.provider.locator.kind === "import-function") {
          throw providerError(
            `prepared callable provider ${entry.provider.structuralReferenceKey} cannot own an import without its exact import descriptor`,
          );
        }
        canonicalOwner = bindingIds.get(group[0]!.provider.structuralReferenceKey)!;
        ownerKind = "batch-provider";
      } else if (ownerKind === "committed") {
        const ownerDraft = this.session.getDraft(canonicalOwner);
        if (
          !ownerDraft ||
          ownerDraft.intent.kind !== "callable" ||
          ownerDraft.slotPolicy !== "required" ||
          !this.session.hasLocator(canonicalOwner, locatorObject) ||
          !programAbiCallableSignaturesEqual(
            ownerDraft.intent.signature,
            canonicalProgramAbiCallableTypeContract(entry.typeContract),
          )
        ) {
          throw providerError(
            `callable provider ${entry.provider.structuralReferenceKey} has a malformed committed locator owner`,
          );
        }
      }
      groupOwner.set(locatorObject, Object.freeze({ id: canonicalOwner, kind: ownerKind }));
    }

    return Object.freeze(
      selected.map((entry) => {
        if (currentCallableIndex(this.ctx, entry.provider.locator) === undefined) {
          throw providerError(
            `prepared callable provider ${entry.provider.structuralReferenceKey} lost its exact allocator object`,
          );
        }
        if (
          callableTypeIndex(entry.provider.locator) !== entry.typeIndex ||
          callableSignature(this.ctx.mod, entry.provider.locator) !== entry.signature ||
          !callableTypeContractsEqual(
            entry.typeContract,
            cloneProgramAbiCallableTypeContract(callableSignature(this.ctx.mod, entry.provider.locator)),
          )
        ) {
          throw providerError(
            `prepared callable provider ${entry.provider.structuralReferenceKey} changed its exact signature`,
          );
        }
        const bindingId = bindingIds.get(entry.provider.structuralReferenceKey)!;
        const owner = groupOwner.get(entry.provider.locator.value)!;
        const ownsLocator = bindingId === owner.id;
        const common = {
          id: bindingId,
          structuralOrder: Object.freeze({
            ...this.session.structuralOrder.forSource(entrySourceId, {
              domain: "callable" as const,
              roleOrdinal: PROGRAM_ABI_PROVIDER_ROLE_ORDINAL,
              derivedOrdinal: entry.ordinal,
            }),
          }),
          structuralReferenceKey: entry.provider.structuralReferenceKey,
          displayName: entry.provider.binding.symbol,
          intent: Object.freeze({
            kind: "callable" as const,
            origin: entry.provider.binding.kind,
            signature: canonicalProgramAbiCallableTypeContract(entry.typeContract),
          }),
        };
        const draft = Object.freeze(
          ownsLocator
            ? { ...common, slotPolicy: "required" as const, slotSpace: "function" as const }
            : { ...common, slotPolicy: "alias" as const, aliasOf: owner.id },
        ) satisfies ProgramAbiDraft;
        const planned = this.plannedByKey.get(entry.provider.structuralReferenceKey);
        if (planned !== undefined && planned !== bindingId) {
          throw providerError(
            `callable provider ${entry.provider.structuralReferenceKey} changed its sealed structural identity`,
          );
        }
        const session = Object.freeze({
          draft: this.session.getDraft(bindingId),
          structuralOrderOwner: draftStructuralOrderOwner(this.session, draft),
          structuralReferenceBindingIds: Object.freeze([
            ...this.session.bindingIdsForStructuralReference(entry.provider.structuralReferenceKey),
          ]),
          locatorOwner: this.session.locatorBindingId(entry.provider.locator.value),
          hasExactLocator: this.session.hasLocator(bindingId, entry.provider.locator.value),
        });
        const expectedIds = planned ? Object.freeze([bindingId]) : Object.freeze([]);
        const ownerCurrent =
          owner.kind === "provisional-import"
            ? session.locatorOwner === undefined || session.locatorOwner === owner.id
            : session.locatorOwner === (owner.kind === "batch-provider" ? undefined : owner.id);
        if (
          !callableDraftsEqual(session.draft, planned ? draft : undefined) ||
          session.structuralOrderOwner !== (planned ? bindingId : undefined) ||
          !exactBindingIdsEqual(session.structuralReferenceBindingIds, expectedIds) ||
          !ownerCurrent ||
          session.hasExactLocator !== (planned !== undefined && ownsLocator)
        ) {
          throw providerError(
            `prepared callable provider ${entry.provider.structuralReferenceKey} disagrees with current session ownership`,
          );
        }
        return Object.freeze({
          ...entry,
          bindingId,
          draft,
          canonicalOwner: owner.id,
          ownerKind: owner.kind,
          ownsLocator,
          planned,
          session,
        });
      }),
    );
  }

  private assertSameDenominator(
    expected: readonly PreparedCallableProviderDenominatorEntry[],
    actual: readonly PreparedCallableProviderDenominatorEntry[],
  ): void {
    if (
      expected.length !== actual.length ||
      expected.some((entry, index) => {
        const current = actual[index]!;
        return (
          entry.provider !== current.provider ||
          entry.provider.binding !== current.provider.binding ||
          entry.provider.structuralReferenceKey !== current.provider.structuralReferenceKey ||
          entry.provider.locator !== current.provider.locator ||
          entry.provider.locator.value !== current.provider.locator.value ||
          entry.ordinal !== current.ordinal ||
          entry.typeIndex !== current.typeIndex ||
          entry.signature !== current.signature ||
          !callableTypeContractsEqual(entry.typeContract, current.typeContract)
        );
      })
    ) {
      throw providerError("prepared callable-provider descriptor denominator is stale");
    }
  }

  private assertSameSelectedEntry(
    expected: PreparedCallableProviderEntry,
    actual: PreparedCallableProviderEntry,
  ): void {
    const expectedOwnerTransition =
      expected.ownerKind === "provisional-import" &&
      expected.session.locatorOwner === undefined &&
      actual.session.locatorOwner === expected.canonicalOwner;
    if (
      expected.provider !== actual.provider ||
      expected.ordinal !== actual.ordinal ||
      expected.typeIndex !== actual.typeIndex ||
      expected.signature !== actual.signature ||
      expected.bindingId !== actual.bindingId ||
      expected.canonicalOwner !== actual.canonicalOwner ||
      expected.ownerKind !== actual.ownerKind ||
      expected.ownsLocator !== actual.ownsLocator ||
      expected.planned !== actual.planned ||
      !callableTypeContractsEqual(expected.typeContract, actual.typeContract) ||
      !callableDraftsEqual(expected.draft, actual.draft) ||
      !callableDraftsEqual(expected.session.draft, actual.session.draft) ||
      expected.session.structuralOrderOwner !== actual.session.structuralOrderOwner ||
      !exactBindingIdsEqual(
        expected.session.structuralReferenceBindingIds,
        actual.session.structuralReferenceBindingIds,
      ) ||
      (!expectedOwnerTransition && expected.session.locatorOwner !== actual.session.locatorOwner) ||
      expected.session.hasExactLocator !== actual.session.hasExactLocator
    ) {
      throw providerError(`prepared callable provider ${expected.provider.structuralReferenceKey} descriptor is stale`);
    }
  }

  private planPreparedEntry(entry: PreparedCallableProviderEntry): IrBindingId {
    const existing = this.plannedByKey.get(entry.provider.structuralReferenceKey);
    if (existing) return existing;
    this.session.ensurePlan(entry.draft);
    if (entry.ownsLocator) {
      this.session.attachLocator(entry.bindingId, entry.provider.locator as ProgramAbiSlotLocator);
    }
    this.session.registerCallableTypeContract(entry.bindingId, entry.typeContract);
    this.session.registerStructuralReference(entry.bindingId, entry.provider.structuralReferenceKey);
    this.plannedByKey.set(entry.provider.structuralReferenceKey, entry.bindingId);
    return entry.bindingId;
  }

  /** Build one scope-authenticated provider write set without publishing it. */
  prepareDescriptorForScope(
    descriptor: PreparedCallableProviderDescriptor,
    session: ProgramAbiSession,
    scopeId: string,
  ): PreparedProgramAbiDescriptorPart {
    const payload = this.requirePreparedDescriptor(descriptor);
    if (session !== this.session || scopeId.length === 0) {
      throw providerError("prepared callable-provider descriptor targets a foreign session or empty scope");
    }
    assertProviderDescriptorFresh(payload.lifecycle);
    payload.lifecycle.state.set("scopeId", scopeId);
    payload.lifecycle.state.set("state", "claimed");
    try {
      this.assertPreparedDescriptorCurrent(descriptor);
      const bindings = Object.freeze(
        payload.selected.map(
          (entry): PreparedProgramAbiProvisionalBinding =>
            Object.freeze({
              draft: entry.draft,
              structuralReferenceKey: entry.provider.structuralReferenceKey,
              ...(entry.ownsLocator ? { locator: entry.provider.locator as ProgramAbiSlotLocator } : {}),
              callableTypeContract: entry.typeContract,
            }),
        ),
      );
      const registryWrites: PreparedProgramAbiMapWrite[] = [];
      if (this.observationOrder === undefined) {
        registryWrites.push(
          Object.freeze({
            target: this.preparedPublication as Map<unknown, unknown>,
            key: "observationOrder",
            value: Object.freeze(payload.denominator.map(({ provider }) => provider.structuralReferenceKey)),
          }),
        );
      }
      for (const entry of payload.selected) {
        if (entry.planned !== undefined) continue;
        registryWrites.push(
          Object.freeze({
            target: this.plannedByKey as Map<unknown, unknown>,
            key: entry.provider.structuralReferenceKey,
            value: entry.bindingId,
          }),
        );
      }
      const requested = Object.freeze([...payload.requestedKeys]);
      const requestedSet = new Set(requested);
      const requiredImportBindingIds = Object.freeze([
        ...new Set(
          payload.selected
            .filter(({ ownerKind }) => ownerKind === "provisional-import")
            .map(({ canonicalOwner }) => canonicalOwner),
        ),
      ]);
      const closure = Object.freeze(
        payload.selected.map((entry) => entry.provider.structuralReferenceKey).filter((key) => !requestedSet.has(key)),
      );
      return Object.freeze({
        kind: "callable-providers" as const,
        session,
        descriptor,
        lifecycle: payload.lifecycle,
        bindings,
        requestedStructuralReferenceKeys: requested,
        closureStructuralReferenceKeys: closure,
        ...(payload.importDescriptor === undefined ? {} : { requiredImportDescriptor: payload.importDescriptor }),
        ...(requiredImportBindingIds.length === 0 ? {} : { requiredImportBindingIds }),
        registryWrites: Object.freeze(registryWrites),
        assertCurrent: () => {
          assertProviderDescriptorClaimed(payload.lifecycle, scopeId);
          this.assertPreparedDescriptorCurrent(descriptor);
        },
      });
    } catch (error) {
      payload.lifecycle.state.set("state", "consumed");
      throw error;
    }
  }

  /**
   * The sealed prefix, plus (#4514) every key discovered after sealing in
   * discovery order. The prefix is sorted once and never re-sorted, so a
   * provider's ordinal is fixed the first time this order is read.
   */
  private sealObservationOrder(): readonly string[] {
    this.observationOrder ??= Object.freeze([...this.observed.keys()].sort());
    return this.appendedOrder.length === 0
      ? this.observationOrder
      : Object.freeze([...this.observationOrder, ...this.appendedOrder]);
  }

  private planProvider(provider: ObservedProvider, ordinal: number): IrBindingId {
    const existing = this.plannedByKey.get(provider.structuralReferenceKey);
    if (existing) return existing;
    const entrySourceId = canonicalEntrySource(this.session);
    const signature = cloneProgramAbiCallableTypeContract(callableSignature(this.ctx.mod, provider.locator));
    const bindingId = createIrBindingId({
      ownerId: entrySourceId,
      domain: "callable",
      role: `${provider.binding.kind}-provider`,
      ordinal,
    });
    const canonicalOwner = this.session.locatorBindingId(provider.locator.value);
    const common = {
      id: bindingId,
      structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
        domain: "callable" as const,
        roleOrdinal: PROGRAM_ABI_PROVIDER_ROLE_ORDINAL,
        derivedOrdinal: ordinal,
      }),
      structuralReferenceKey: provider.structuralReferenceKey,
      displayName: provider.binding.symbol,
      intent: {
        kind: "callable" as const,
        origin: provider.binding.kind,
        signature: canonicalProgramAbiCallableTypeContract(signature),
      },
    };
    if (canonicalOwner) {
      this.session.ensurePlan({ ...common, slotPolicy: "alias", aliasOf: canonicalOwner });
    } else {
      this.session.ensurePlan({ ...common, slotPolicy: "required", slotSpace: "function" });
      this.session.attachLocator(bindingId, provider.locator as ProgramAbiSlotLocator);
    }
    this.session.registerCallableTypeContract(bindingId, signature);
    this.session.registerStructuralReference(bindingId, provider.structuralReferenceKey);
    this.plannedByKey.set(provider.structuralReferenceKey, bindingId);
    return bindingId;
  }

  private requireProviderBinding(ref: IrFuncRef): ProviderBinding {
    if (ref.binding.kind !== "runtime" && ref.binding.kind !== "intrinsic") {
      throw new TypeError("program ABI callable-provider registry requires a runtime or intrinsic reference");
    }
    return ref.binding;
  }
}

function providerDescriptorState(lifecycle: PreparedProgramAbiDescriptorLifecycle): string | undefined {
  return lifecycle.state.get("state");
}

function assertProviderDescriptorFresh(lifecycle: PreparedProgramAbiDescriptorLifecycle): void {
  if (providerDescriptorState(lifecycle) !== "fresh" || lifecycle.state.has("scopeId")) {
    throw providerError("prepared callable-provider descriptor is not fresh");
  }
}

function assertProviderDescriptorClaimed(lifecycle: PreparedProgramAbiDescriptorLifecycle, scopeId: string): void {
  if (providerDescriptorState(lifecycle) !== "claimed" || lifecycle.state.get("scopeId") !== scopeId) {
    throw providerError(`prepared callable-provider descriptor is not claimed by exact scope ${scopeId}`);
  }
}

export function prepareCallableProviderDescriptorForScope(
  descriptor: PreparedCallableProviderDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): PreparedProgramAbiDescriptorPart {
  const payload = preparedCallableProviderDescriptors.get(descriptor);
  if (!payload) throw providerError("prepared callable-provider descriptor is forged");
  return payload.registry.prepareDescriptorForScope(descriptor, session, scopeId);
}

export function consumePreparedCallableProviderDescriptor(
  descriptor: PreparedCallableProviderDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): void {
  const payload = preparedCallableProviderDescriptors.get(descriptor);
  if (!payload || payload.registry.session !== session) {
    throw providerError("prepared callable-provider descriptor is forged or belongs to another session");
  }
  assertProviderDescriptorClaimed(payload.lifecycle, scopeId);
  payload.lifecycle.state.set("state", "consumed");
}
