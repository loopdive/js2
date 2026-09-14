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
