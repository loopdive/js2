// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Compatibility exports share the semantic implementation and the single attachment authority.

export type {
  PreparedIrFunction,
  PreparedIrModule,
  PreparedIrAsyncHostAdapter,
  PreparedIrAsyncRuntime,
  CurrentPreparedIrAsyncRuntime,
} from "./runtime/contracts/prepared.js";
export type {
  IrAsyncStateId,
  IrAsyncHandlerId,
  IrCanonicalPromiseAbi,
  IrAsyncRuntimeIntent,
  IrAsyncPlanValue,
  IrAsyncSpillStorage,
  IrAsyncSpill,
  IrAsyncResumeValue,
  IrAsyncSpillUpdate,
  IrAsyncState,
  IrAsyncHandler,
  IrAsyncSuspendTerminator,
  IrAsyncGotoTerminator,
  IrAsyncBranchTerminator,
  IrAsyncResolveTerminator,
  IrAsyncRejectTerminator,
  IrAsyncCompleteTerminator,
  IrAsyncTerminator,
  IrAsyncPlan,
} from "./core/async-plan.js";
export {
  asAsyncStateId,
  asAsyncHandlerId,
  canonicalPromiseAbi,
  IrAsyncPlanInvariantError,
  irAsyncPlanNeedsNumberBridge,
  verifyIrAsyncPlan,
  assertIrAsyncPlan,
  createIrAsyncPlan,
  serializeIrAsyncPlan,
  hashIrAsyncPlan,
} from "./analysis/async-plan.js";
export type { IrAsyncPlanInvariantCode, IrAsyncPlanVerifyError } from "./analysis/async-plan.js";
export {
  assertPreparedIrAsyncRuntimeCurrent,
  createPreparedIrAsyncRuntime,
  sealPreparedIrAsyncRuntimeContainers,
  preparedIrAsyncFrameCapabilityFailure,
} from "./runtime/async-attachment.js";
