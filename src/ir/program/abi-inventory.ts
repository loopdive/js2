// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrSourceId, IrUnitId, IrClassId } from "../../shared/contracts/ir-identity.js";

/** Structural input consumed by the ABI map; the original inventory remains its owner. */
export interface ProgramAbiInventory {
  readonly sources: readonly { readonly id: IrSourceId; readonly order: number }[];
  readonly allUnits: readonly {
    readonly id: IrUnitId;
    readonly sourceId: IrSourceId;
    readonly terminalOwnerId: IrUnitId | null;
  }[];
  readonly classes: readonly { readonly id: IrClassId; readonly sourceId: IrSourceId }[];
  readonly terminalUnits: readonly { readonly id: IrUnitId }[];
}
