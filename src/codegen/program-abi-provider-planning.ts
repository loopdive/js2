// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey } from "../ir/callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrSourceId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { IrFuncRef } from "../ir/nodes.js";
import type { FuncTypeDef, Import, WasmFunction, WasmModule } from "../ir/types.js";
import { definedFuncAt, definedFuncHandleOf, isImportFuncIdx } from "./func-space.js";
import { PROGRAM_ABI_CALLABLE_ROLE } from "./program-abi-planning.js";
import type { CodegenContext } from "./context/types.js";
import type { ProgramAbiSession, ProgramAbiSlotLocator } from "./program-abi-session.js";
import {
  canonicalProgramAbiCallableTypeContract,
  cloneProgramAbiCallableTypeContract,
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
  private observationOrder: readonly string[] | undefined;
  /**
   * (#4514) Provider keys first observed AFTER `sealObservationOrder`, in
   * discovery order. They extend the sealed order at the tail, so no already
   * minted ordinal can move; see `observe`.
   */
  private readonly appendedOrder: string[] = [];
  private readonly plannedByKey = new Map<string, IrBindingId>();
  private plannedValue: ReadonlyMap<string, IrBindingId> | undefined;

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
    const order = this.sealObservationOrder();
    const requestedProviders = [...structuralReferenceKeys].map((key) => {
      const provider = this.observed.get(key);
      if (!provider) {
        throw providerError(`prepared callable provider ${key} was not observed before discovery sealed`);
      }
      if (
        provider.locator.kind === "import-function" &&
        this.session.locatorBindingId(provider.locator.value) === undefined
      ) {
        throw providerError(
          `prepared callable provider ${key} cannot own an import before its canonical import identity is planned`,
        );
      }
      return provider;
    });
    const selected = new Set(structuralReferenceKeys);
    for (const candidate of this.observed.values()) {
      if (requestedProviders.some((requested) => sameLocator(requested.locator, candidate.locator))) {
        selected.add(candidate.structuralReferenceKey);
      }
    }
    for (let ordinal = 0; ordinal < order.length; ordinal++) {
      const key = order[ordinal]!;
      if (!selected.has(key)) continue;
      const provider = this.observed.get(key)!;
      if (currentCallableIndex(this.ctx, provider.locator) === undefined) {
        throw providerError(`prepared callable provider ${key} lost its exact allocator object`);
      }
      this.planProvider(provider, ordinal);
    }
    return new Map(
      [...selected].map((key) => {
        const id = this.plannedByKey.get(key);
        if (!id) throw providerError(`prepared callable provider ${key} did not produce an ABI binding`);
        return [key, id] as const;
      }),
    );
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
