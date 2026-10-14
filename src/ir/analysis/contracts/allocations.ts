// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocKind, AllocSiteId, IrSiteId } from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";

/**
 * A live allocation site. `metadata` is stored out-of-band in the registry
 * (keyed by id + namespace), not on this record, so analyses can annotate
 * without mutating the IR.
 */
export interface AllocSite {
  readonly id: AllocSiteId;
  readonly kind: AllocKind;
  readonly type: IrType;
  /** Reuses the defining instr's source location, when present. */
  readonly origin?: IrSiteId;
}

/** Read authority required by the canonical allocation-provenance verifier. */
export interface AllocProvenanceLookup {
  isKnown(id: AllocSiteId): boolean;
  resolve(id: AllocSiteId): AllocSite | null;
}

/** A detached, read-only projection of one registry slot. */
export type AllocRegistryProvenanceSnapshot =
  | { readonly state: "live"; readonly site: AllocSite }
  | { readonly state: "aliased"; readonly to: AllocSiteId }
  | { readonly state: "retired" };

/** A metadata row retains an explicit `undefined` value when it was written. */
export interface AllocRegistryMetadataSnapshot {
  readonly id: AllocSiteId;
  readonly entries: readonly (readonly [namespace: string, value: unknown])[];
}

/**
 * Complete allocation-registry evidence for an immutable preparation batch.
 * Missing metadata rows and present rows whose value is `undefined` are
 * intentionally represented differently.
 */
export interface AllocRegistrySnapshot {
  readonly size: number;
  readonly entries: readonly AllocRegistryProvenanceSnapshot[];
  readonly metadata: readonly AllocRegistryMetadataSnapshot[];
}

/**
 * Ownership state — a totally ordered lattice from most-precise (`owned`) to
 * most-permissive (`escaped`). Higher = more conservative = safer default.
 *
 *   owned  ⊑ borrowed ⊑ shared ⊑ escaped
 *
 * - `owned`    — exactly one live reference (this one) for its liveness.
 * - `borrowed` — referenced elsewhere; this ref must not deallocate/invalidate.
 * - `shared`   — multiple references; mutation must be observable to all.
 * - `escaped`  — lifetime extends beyond this function (return, capture,
 *                store-to-heap, pass to opaque code).
 */
export type Ownership = "owned" | "borrowed" | "shared" | "escaped";

/**
 * How an allocation escapes its defining function. Ordered most-precise →
 * most-conservative; `local` is the only stack-allocatable classification.
 */
export type EscapeClass = "local" | "returned" | "stored" | "captured" | "opaque";

export interface EscapeInfo {
  readonly classification: EscapeClass;
  /** True iff `classification === "local"` — safe for scalar replacement. */
  readonly stackAllocatable: boolean;
}

/**
 * Reserved metadata namespaces. Each analysis owns exactly one and may not
 * write to another's. Enforced by convention in this issue (#1586); the ADR
 * documents the ownership table.
 */
export const ALLOC_NAMESPACES = {
  /** #1587 — ownership and access-semantics analysis. */
  ownership: "ownership",
  /** #1588 — string encoding tracking. */
  encoding: "encoding",
  /** #1585 — dual-target IR / lifetime analysis. */
  lifetime: "lifetime",
  /** Closure-capture escape analysis (#747). */
  escape: "escape",
} as const;
