// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createIrBindingId, type IrBindingId, type IrClassId, type IrSourceId, type IrUnitId } from "./identity.js";
import type { IrGlobalBinding, IrGlobalRef, IrTypeBinding, IrTypeRef } from "./nodes.js";

type IrBindingOwnerId = IrSourceId | IrUnitId | IrClassId;

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireString(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function requireBindingId(value: IrBindingId, label: string, domain: "global" | "type" | "class"): IrBindingId {
  const checked = requireNonEmpty(value, label);
  if (!checked.startsWith(`ir-binding:v1:${domain}:`)) {
    throw new TypeError(`${label} must belong to the ${domain} binding domain`);
  }
  return checked as IrBindingId;
}

function compatibilityName(explicit: string | undefined, fallback: string, label: string): string {
  return requireNonEmpty(explicit ?? fallback, label);
}

function globalRef(name: string, binding: IrGlobalBinding): IrGlobalRef {
  requireBindingId(binding.bindingId, "global bindingId", "global");
  return Object.freeze({
    kind: "global",
    name: requireNonEmpty(name, "global compatibility name"),
    binding: Object.freeze(binding),
  });
}

function typeRef(name: string, binding: IrTypeBinding): IrTypeRef {
  requireBindingId(binding.bindingId, "type bindingId", binding.kind === "class" ? "class" : "type");
  return Object.freeze({
    kind: "type",
    name: requireNonEmpty(name, "type compatibility name"),
    binding: Object.freeze(binding),
  });
}

/** Exact source-owned value-storage ID for one top-level declaration ordinal. */
export function irModuleGlobalBindingId(sourceId: IrSourceId, declarationOrdinal: number): IrBindingId {
  return createIrBindingId({
    ownerId: requireNonEmpty(sourceId, "module-global source identity") as IrSourceId,
    domain: "global",
    role: "module-binding",
    ordinal: declarationOrdinal,
  });
}

/** Exact source-owned TDZ-state ID for the same top-level declaration ordinal. */
export function irModuleTdzGlobalBindingId(sourceId: IrSourceId, declarationOrdinal: number): IrBindingId {
  return createIrBindingId({
    ownerId: requireNonEmpty(sourceId, "module-TDZ source identity") as IrSourceId,
    domain: "global",
    role: "module-tdz",
    ordinal: declarationOrdinal,
  });
}

/** Exact source-owned value storage for one top-level declaration ordinal. */
export function irModuleGlobalRef(sourceId: IrSourceId, declarationOrdinal: number, adapterName: string): IrGlobalRef {
  return globalRef(adapterName, {
    kind: "source",
    bindingId: irModuleGlobalBindingId(sourceId, declarationOrdinal),
  });
}

/** Exact source-owned TDZ state for the same top-level declaration ordinal. */
export function irModuleTdzGlobalRef(
  sourceId: IrSourceId,
  declarationOrdinal: number,
  adapterName: string,
): IrGlobalRef {
  return globalRef(adapterName, {
    kind: "source",
    bindingId: irModuleTdzGlobalBindingId(sourceId, declarationOrdinal),
  });
}

/** Rehydrate a source-owned reference from its already-planned exact binding. */
export function irSourceGlobalRef(bindingId: IrBindingId, adapterName: string): IrGlobalRef {
  return globalRef(adapterName, {
    kind: "source",
    bindingId: requireBindingId(bindingId, "source global bindingId", "global"),
  });
}

/** Reference one imported global without reducing its identity to the local label. */
export function irImportGlobalRef(
  ownerId: IrBindingOwnerId,
  module: string,
  field: string,
  adapterName?: string,
  ordinal?: number,
): IrGlobalRef {
  const checkedModule = requireNonEmpty(module, "global import module");
  // WebAssembly import field names may be empty. Host string constants use
  // that valid spelling for the empty-string literal, so retain it exactly.
  const checkedField = requireString(field, "global import field");
  return globalRef(compatibilityName(adapterName, checkedField, "global import compatibility name"), {
    kind: "import",
    bindingId: createIrBindingId({
      ownerId: requireNonEmpty(ownerId, "global import owner identity") as IrBindingOwnerId,
      domain: "global",
      role: `import:${checkedModule}:${checkedField}`,
      ordinal,
    }),
    module: checkedModule,
    field: checkedField,
  });
}

/**
 * Catalog one retained import-global allocator slot not already owned by a
 * semantic import binding.
 *
 * The distinct role prevents a compatibility-only duplicate import from
 * colliding with a semantic `irImportGlobalRef` that happens to share both its
 * module/field spelling and ordinal.
 */
export function irRetainedImportGlobalRef(
  ownerId: IrBindingOwnerId,
  module: string,
  field: string,
  adapterName: string,
  ordinal: number,
): IrGlobalRef {
  const checkedModule = requireNonEmpty(module, "retained global import module");
  const checkedField = requireString(field, "retained global import field");
  return globalRef(adapterName, {
    kind: "import",
    bindingId: createIrBindingId({
      ownerId: requireNonEmpty(ownerId, "retained global import owner identity") as IrBindingOwnerId,
      domain: "global",
      role: `retained-import:${checkedModule}:${checkedField}`,
      ordinal,
    }),
    module: checkedModule,
    field: checkedField,
  });
}

/** Reference compiler runtime state through an exact program binding. */
export function irRuntimeGlobalRef(
  ownerId: IrBindingOwnerId,
  symbol: string,
  adapterName?: string,
  ordinal?: number,
): IrGlobalRef {
  const checkedSymbol = requireNonEmpty(symbol, "runtime global symbol");
  return globalRef(compatibilityName(adapterName, checkedSymbol, "runtime global compatibility name"), {
    kind: "runtime",
    bindingId: createIrBindingId({
      ownerId: requireNonEmpty(ownerId, "runtime global owner identity") as IrBindingOwnerId,
      domain: "global",
      role: `runtime:${checkedSymbol}`,
      ordinal,
    }),
    symbol: checkedSymbol,
  });
}

/** The one program-wide arguments-count cell, anchored to the canonical entry source. */
export function irArgcGlobalRef(entrySourceId: IrSourceId): IrGlobalRef {
  const checkedSourceId = requireNonEmpty(entrySourceId, "argc entry-source identity") as IrSourceId;
  return globalRef("__argc", {
    kind: "runtime",
    symbol: "__argc",
    bindingId: createIrBindingId({
      ownerId: checkedSourceId,
      domain: "global",
      role: "runtime:argc",
    }),
  });
}

/** Reference compiler support storage derived from a structural owner/role. */
export function irSupportGlobalRef(
  ownerId: IrBindingOwnerId,
  role: string,
  adapterName: string,
  ordinal?: number,
): IrGlobalRef {
  const checkedRole = requireNonEmpty(role, "support global role");
  return globalRef(adapterName, {
    kind: "support",
    bindingId: createIrBindingId({
      ownerId: requireNonEmpty(ownerId, "support global owner identity") as IrBindingOwnerId,
      domain: "global",
      role: checkedRole,
      ordinal,
    }),
  });
}

/** Reference a source-owned non-class type intention. */
export function irSourceTypeRef(
  ownerId: IrSourceId | IrUnitId,
  role: string,
  adapterName: string,
  ordinal?: number,
): IrTypeRef {
  const checkedRole = requireNonEmpty(role, "source type role");
  return typeRef(adapterName, {
    kind: "source",
    bindingId: createIrBindingId({
      ownerId: requireNonEmpty(ownerId, "source type owner identity") as IrSourceId | IrUnitId,
      domain: "type",
      role: checkedRole,
      ordinal,
    }),
  });
}

/** Reference the exact layout intention for one source-qualified class. */
export function irClassTypeRef(classId: IrClassId, adapterName: string): IrTypeRef {
  const checkedClassId = requireNonEmpty(classId, "class type identity") as IrClassId;
  return typeRef(adapterName, {
    kind: "class",
    classId: checkedClassId,
    bindingId: createIrBindingId({ ownerId: checkedClassId, domain: "class", role: "layout" }),
  });
}

/** Reference one runtime-owned type intention. */
export function irRuntimeTypeRef(
  ownerId: IrBindingOwnerId,
  symbol: string,
  adapterName?: string,
  ordinal?: number,
): IrTypeRef {
  const checkedSymbol = requireNonEmpty(symbol, "runtime type symbol");
  return typeRef(compatibilityName(adapterName, checkedSymbol, "runtime type compatibility name"), {
    kind: "runtime",
    symbol: checkedSymbol,
    bindingId: createIrBindingId({
      ownerId: requireNonEmpty(ownerId, "runtime type owner identity") as IrBindingOwnerId,
      domain: "type",
      role: `runtime:${checkedSymbol}`,
      ordinal,
    }),
  });
}

/** Reference one compiler support type intention. */
export function irSupportTypeRef(
  ownerId: IrBindingOwnerId,
  role: string,
  adapterName: string,
  ordinal?: number,
): IrTypeRef {
  const checkedRole = requireNonEmpty(role, "support type role");
  return typeRef(adapterName, {
    kind: "support",
    bindingId: createIrBindingId({
      ownerId: requireNonEmpty(ownerId, "support type owner identity") as IrBindingOwnerId,
      domain: "type",
      role: checkedRole,
      ordinal,
    }),
  });
}

function keyPart(value: string): string {
  return `${value.length}:${value}`;
}

/** Canonical global-binding key. Compatibility names are deliberately excluded. */
export function irGlobalBindingKey(binding: IrGlobalBinding): string {
  const bindingId = keyPart(requireBindingId(binding.bindingId, "global bindingId", "global"));
  switch (binding.kind) {
    case "source":
    case "support":
      return `${binding.kind}|${bindingId}`;
    case "import":
      return (
        `import|${bindingId}|${keyPart(requireNonEmpty(binding.module, "global import module"))}|` +
        keyPart(requireString(binding.field, "global import field"))
      );
    case "runtime":
      return `runtime|${bindingId}|${keyPart(requireNonEmpty(binding.symbol, "runtime global symbol"))}`;
    default: {
      const exhaustive: never = binding;
      throw new TypeError(`unknown global binding kind ${(exhaustive as { kind?: unknown }).kind ?? "<missing>"}`);
    }
  }
}

export function sameIrGlobalBinding(left: IrGlobalBinding, right: IrGlobalBinding): boolean {
  return irGlobalBindingKey(left) === irGlobalBindingKey(right);
}

/** Canonical type-binding key. Compatibility names are deliberately excluded. */
export function irTypeBindingKey(binding: IrTypeBinding): string {
  const bindingId = keyPart(
    requireBindingId(binding.bindingId, "type bindingId", binding.kind === "class" ? "class" : "type"),
  );
  switch (binding.kind) {
    case "source":
    case "support":
      return `${binding.kind}|${bindingId}`;
    case "class":
      return `class|${bindingId}|${keyPart(requireNonEmpty(binding.classId, "class type identity"))}`;
    case "runtime":
      return `runtime|${bindingId}|${keyPart(requireNonEmpty(binding.symbol, "runtime type symbol"))}`;
    default: {
      const exhaustive: never = binding;
      throw new TypeError(`unknown type binding kind ${(exhaustive as { kind?: unknown }).kind ?? "<missing>"}`);
    }
  }
}

export function sameIrTypeBinding(left: IrTypeBinding, right: IrTypeBinding): boolean {
  return irTypeBindingKey(left) === irTypeBindingKey(right);
}
