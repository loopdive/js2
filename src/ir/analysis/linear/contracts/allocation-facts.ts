// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId } from "../../../core/nodes.js";
import type { IrStringEncoding as Encoding } from "../../../core/string-types.js";
import type {
  AllocSite,
  AllocRegistrySnapshot,
  Ownership,
  EscapeClass,
  EscapeInfo,
} from "../../contracts/allocations.js";

export interface OwnershipMetadata {
  readonly state?: Ownership;
  readonly ops?: readonly string[];
  readonly stackCandidate?: boolean;
}

/**
 * Allocation analysis output detached from the mutable registry and physical
 * layout. The batch boundary owns this value before a backend chooses layout.
 */
export interface LinearPreparedAllocationFact {
  readonly id: AllocSiteId;
  readonly site: AllocSite;
  readonly ownership: Ownership;
  readonly accesses: readonly string[];
  readonly escape: EscapeClass;
  readonly stackCandidate: boolean;
  readonly encoding?: Encoding;
  /** Presence is separate from the value so absent and explicit undefined survive freeze. */
  readonly evidence: {
    readonly ownership: { readonly present: boolean; readonly value: OwnershipMetadata | undefined };
    readonly escape: { readonly present: boolean; readonly value: EscapeInfo | undefined };
    readonly encoding: { readonly present: boolean; readonly value: Encoding | undefined };
  };
}

export interface LinearPreparedAllocationFacts {
  readonly allocations: readonly LinearPreparedAllocationFact[];
  readonly registry: AllocRegistrySnapshot;
}
