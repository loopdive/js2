// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrUnitInventory } from "./identity.js";
import {
  ProgramAbiMap as CanonicalProgramAbiMap,
  ProgramAbiInvariantError,
  type ProgramAbiIntent,
  type ProgramAbiSlotSpace,
  type ProgramAbiFinalIndex,
} from "./program/abi.js";

export { ProgramAbiInvariantError } from "./program/abi.js";
export type {
  ProgramAbiSlotPolicy,
  ProgramAbiSlotSpace,
  ProgramAbiCallableSignature,
  ProgramAbiDerivedUnitRecord,
  ProgramAbiIntent,
  ProgramAbiOrderKey,
  ProgramAbiPlanEntry,
  ProgramAbiFinalIndex,
  ProgramAbiInvariantCode,
} from "./program/abi.js";

// Preserve the original rich inventory type and the exact runtime constructor.
export type ProgramAbiMap = CanonicalProgramAbiMap<IrUnitInventory>;
export const ProgramAbiMap = CanonicalProgramAbiMap<IrUnitInventory>;

/** Namespaces exposed by the temporary string-keyed legacy compatibility view. */
export type ProgramAbiLegacyNamespace = ProgramAbiSlotSpace | "export";

const legacyKey = (namespace: ProgramAbiLegacyNamespace, name: string): string => `${namespace}\u0000${name}`;

function intentLegacyNamespace(intent: ProgramAbiIntent): ProgramAbiLegacyNamespace | null {
  if (intent.kind === "export") return "export";
  if (intent.kind === "callable") return "function";
  if (intent.kind === "global") return "global";
  if (intent.kind === "type" || intent.kind === "class") return "type";
  return null;
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
