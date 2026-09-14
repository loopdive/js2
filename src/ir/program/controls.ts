// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrGvnMode } from "../passes/contracts/gvn.js";

export interface IrPreparationControls {
  readonly gvnMode: IrGvnMode;
  readonly ownership: boolean;
  readonly escape: boolean;
  readonly verifyIntermediateAllocations: boolean;
  readonly verifyDominanceNaive: boolean;
}
