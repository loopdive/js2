// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey, irImportGlobalRef } from "../ir/abi-bindings.js";
import { irCallableBindingKey, irImportFuncRef } from "../ir/callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrSourceId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncTypeDef, Import, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { eliminateDeadImports } from "./dead-elimination.js";
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
    const ref = irImportFuncRef(value.module, value.name, value.name);
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

/**
 * Snapshot the exact function-import objects available to pre-DCE lowering.
 *
 * This catalog deliberately creates no ABI drafts: dead-import elimination may
 * remove members of this population. Integration can still resolve a symbolic
 * import through the exact object without making an eliminated slot required
 * at final publication.
 */
export function catalogProgramAbiCallableImports(ctx: CodegenContext): ReadonlyMap<string, Import> {
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
  const session = ctx.programAbiSession;
  if (!session) return EMPTY_PROGRAM_ABI_IMPORT_CATALOG;
  const entrySourceId = canonicalEntrySource(ctx);
  const imports = collectProgramAbiCallableImports(ctx);
  const catalogEntries: Array<readonly [string, IrBindingId]> = [];
  for (let ordinal = 0; ordinal < imports.length; ordinal++) {
    const imported = imports[ordinal]!;
    const bindingId = createIrBindingId({
      ownerId: entrySourceId,
      domain: "callable",
      role: PROGRAM_ABI_IMPORT_CALLABLE_BINDING_ROLE,
      ordinal,
    });
    const typeContract = cloneProgramAbiCallableTypeContract(imported.signature);
    session.ensurePlan({
      id: bindingId,
      structuralOrder: session.structuralOrder.forSource(entrySourceId, {
        domain: "callable",
        roleOrdinal: PROGRAM_ABI_IMPORT_CALLABLE_ROLE.importedFunction,
        derivedOrdinal: ordinal,
      }),
      structuralReferenceKey: imported.key,
      displayName: imported.value.name,
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "import",
        signature: canonicalProgramAbiCallableTypeContract(typeContract),
      },
    });
    session.registerCallableTypeContract(bindingId, typeContract);
    session.registerStructuralReference(bindingId, imported.key);
    if (!session.hasLocator(bindingId, imported.value)) {
      session.attachLocator(bindingId, { kind: "import-function", value: imported.value });
    }
    catalogEntries.push(Object.freeze([imported.key, bindingId] as const));
  }

  return new ImmutableProgramAbiImportCatalog<IrBindingId>(catalogEntries);
}

/** Compact imports, then publish the exact retained callable-import population. */
export function eliminateDeadImportsAndPlanAbiCallables(ctx: CodegenContext): void {
  eliminateDeadImports(ctx.mod, ctx);
  planProgramAbiCallableImports(ctx);
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
  session.registerStructuralReference(ref.binding.bindingId, structuralReferenceKey);
  if (!session.hasLocator(ref.binding.bindingId, value)) {
    session.attachLocator(ref.binding.bindingId, { kind: "import-global", value });
  }
}
