// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";

export type IrProgramCallableBindingKind = "source" | "import-alias" | "export-alias";

/** One exact source or module-boundary callable identity. */
export interface IrProgramCallableBindingRecord {
  readonly bindingId: IrBindingId;
  readonly sourceId: IrSourceId;
  readonly declarationOrdinal: number;
  /** Stable ordinal among the source's callable bindings of this graph kind. */
  readonly bindingOrdinal: number;
  readonly kind: IrProgramCallableBindingKind;
  readonly localName: string;
  readonly targetBindingId: IrBindingId;
  readonly canonicalBindingId: IrBindingId;
  readonly targetUnitId: IrUnitId;
}
