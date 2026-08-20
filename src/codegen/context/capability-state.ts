// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Compiler-certified standalone capability demands carried through finalization. */
export interface StandaloneCapabilityDemandState {
  /** Promise-delay callbacks must re-enter Wasm after the general host bridge is stripped. */
  requiresStandaloneTimerCallbackDispatch?: boolean;
  /** Exact dom@1 import family was checker-certified for this module. */
  requiresStandaloneDomCapability?: boolean;
  /** Exact DOM interaction extension requires the authenticated arity-zero dispatcher. */
  requiresStandaloneDomInteractionCapability?: boolean;
  /** Exact clock@1 snapshot plan was retained and materialized. */
  requiresStandaloneClockCapability?: boolean;
}
