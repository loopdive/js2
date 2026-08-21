// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey, irImportGlobalRef, irPlannedImportGlobalRef } from "../ir/abi-bindings.js";
import { irCallableBindingKey, irCapabilityImportFuncRef, irImportFuncRef } from "../ir/callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrSourceId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { IrGlobalRef } from "../ir/nodes.js";
import type { FuncTypeDef, Import, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import {
  canonicalProgramAbiCallableTypeContract,
  cloneProgramAbiCallableTypeContract,
} from "./program-abi-signatures.js";

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
  private sealedEntries: readonly ProgramAbiCallableImport[] | undefined;
  private readonly plannedByImport = new Map<Import, PlannedCallableImport>();
  private plannedValue: ReadonlyMap<string, IrBindingId> | undefined;

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

  planPrepared(values: ReadonlySet<Import>): void {
    if (values.size === 0) return;
    if (this.plannedValue) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot prepare callable imports after retained import planning",
      );
    }
    const entries = this.sealEntries();
    const byImport = new Map(entries.map((entry, ordinal) => [entry.value, { entry, ordinal }] as const));
    for (const value of values) {
      const selected = byImport.get(value);
      if (!selected) {
        throw callableImportError("prepared callable import is outside the sealed pre-DCE import population");
      }
      this.planEntry(selected.entry, selected.ordinal);
    }
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

  private sealEntries(): readonly ProgramAbiCallableImport[] {
    if (this.sealedEntries) return this.sealedEntries;
    const entries = collectProgramAbiCallableImports(this.ctx);
    const exactImports = new Set<Import>();
    for (const entry of entries) {
      if (exactImports.has(entry.value)) {
        throw callableImportError(`callable import ${entry.key} reuses one allocator object in multiple slots`);
      }
      exactImports.add(entry.value);
    }
    this.sealedEntries = entries;
    return entries;
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
