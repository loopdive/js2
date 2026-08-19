// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4542 — refcount discipline for the linear lane's boxed tier.
//
// Reading order:
//   ownership.ts    — the declared ABI input (the four axes, and which may be derived)
//   handle-ir.ts    — the IR the pass rewrites (and why it is not `IrInstr` yet)
//   handle-scope.ts — the pass (the three rules; why one cleanup region per handle)
//   verify.ts       — an independent balance checker; the negative-test harness
//   lower.ts        — rewritten handle IR -> `Instr[]`

export {
  type ArgOwnership,
  type ImportOwnership,
  type ResolvedOwnership,
  type ResultOwnership,
  OwnershipAnnotationError,
  handleParamPositions,
  isHandleType,
  requireOwnershipAnnotations,
  resolveImportOwnership,
  returnsHandle,
  trafficsInHandles,
} from "./ownership.js";

export {
  type DupReason,
  type FreeReason,
  type HandleCall,
  type HandleFunction,
  type HandleId,
  type HandleParam,
  type HandleStmt,
  canThrow,
  count,
  formatHandleStmts,
  nestedBodies,
  walk,
} from "./handle-ir.js";

export {
  type ElisionCandidate,
  type HandleScopeDiagnostic,
  type HandleScopeResult,
  HandleScopeError,
  collectHandles,
  insertHandleScopes,
  terminates,
} from "./handle-scope.js";

export {
  type RefcountFinding,
  type RefcountFindingKind,
  type VerifyOptions,
  handlesMentioned,
  verifyRefcountBalance,
} from "./verify.js";

export {
  type ShimDrift,
  SHIM_REFCOUNT_PRIMITIVES,
  checkShimOwnershipDrift,
  parseShimExports,
  pinnedShimImports,
} from "./pinned-shim.js";

export {
  type RefcountRuntime,
  RefcountLoweringError,
  countCalls,
  flattenInstrs,
  lowerHandleFunction,
} from "./lower.js";
