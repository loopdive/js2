// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrUnitId } from "./identity.js";
import type { IrCallableCapabilityProvenance, IrSourceGlobalCapabilityProvenance } from "./capability-provenance.js";

/** Closed structural identity for every direct-callable IR target. */
export type IrCallableBinding =
  | { readonly kind: "unit"; readonly unitId: IrUnitId }
  | ({ readonly kind: "import"; readonly module: string; readonly field: string } & IrCallableCapabilityProvenance)
  | { readonly kind: "runtime"; readonly symbol: string }
  | { readonly kind: "intrinsic"; readonly symbol: string }
  | { readonly kind: "support"; readonly bindingId: IrBindingId };

export interface IrFuncRef {
  readonly kind: "func";
  /** Compatibility/debug label; never the semantic lookup key. */
  readonly name: string;
  readonly binding: IrCallableBinding;
}

/** Closed structural identity for every IR global target. */
export type IrGlobalBinding =
  | ({ readonly kind: "source"; readonly bindingId: IrBindingId } & IrSourceGlobalCapabilityProvenance)
  | { readonly kind: "import"; readonly bindingId: IrBindingId; readonly module: string; readonly field: string }
  | { readonly kind: "runtime"; readonly bindingId: IrBindingId; readonly symbol: string }
  | { readonly kind: "support"; readonly bindingId: IrBindingId };

export interface IrGlobalRef {
  readonly kind: "global";
  /** Compatibility/debug label; never the semantic lookup key. */
  readonly name: string;
  readonly binding: IrGlobalBinding;
}
