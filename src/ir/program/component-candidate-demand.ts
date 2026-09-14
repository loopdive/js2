// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrBindingId, IrUnitId } from "../../shared/contracts/ir-identity.js";

/** Exact semantic population requested from the existing backend candidate owner. */
export interface PreparedComponentCandidateDemand {
  readonly componentId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly callableBindingIds: readonly IrBindingId[];
  readonly supportBindingIds: readonly IrBindingId[];
}
