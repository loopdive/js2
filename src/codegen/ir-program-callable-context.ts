// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "../ir/identity.js";
import type { IrProgramCallableBindingGraph } from "../ir/program-callable-bindings.js";

declare module "./context/types.js" {
  interface CodegenContext {
    /** Exact whole-program callable binding graph built before body emission. */
    irProgramCallableBindingGraph?: IrProgramCallableBindingGraph;
    /** M1A rollout gate; the graph remains available for disabled-lane census. */
    irProgramCallableCutoverEnabled?: boolean;
    /** Exact terminal units attempted by the aggregate callable lane. */
    irProgramCallableAttemptedUnitIds?: ReadonlySet<IrUnitId>;
    /** Exact terminal units accepted by the aggregate callable owner. */
    irProgramCallablePreparedUnitIds?: ReadonlySet<IrUnitId>;
    /** Exact M2 module-init unit suppressed from generic overlay reconciliation. */
    irProgramPreparedModuleInitUnitId?: IrUnitId;
    /** Exact M2-P2A source-owned initializer units suppressed from overlays. */
    irProgramPreparedModuleInitUnitIds?: ReadonlySet<IrUnitId>;
  }
}
