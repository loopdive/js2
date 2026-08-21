// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "./identity.js";

/** Compiler-owned provenance for a platform-capability callable import. */
export interface IrCallableCapabilityProvenance {
  readonly capabilityId?: string;
  readonly providerId?: string;
}

/** Explicit provider provenance for a capability-owned source global. */
export interface IrSourceGlobalCapabilityProvenance {
  readonly capability?: "dom";
}

/** Structural identity of one checker-certified reusable DOM callback. */
export interface IrDomCallbackAuthority {
  readonly ownerUnitId: IrUnitId;
  readonly liftedOrdinal: number;
}
