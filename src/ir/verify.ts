// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Compatibility names share the complete runtime-aware verifier implementation.
export {
  irGlobalReferenceProblem,
  irTypeReferenceProblem,
  verifyIrFunction,
  TYPE_RULE_CATEGORIES,
  typeRuleCategoryOf,
  TYPE_RULE_STATUS,
  typeRuleCoverageProblem,
} from "./runtime/verify.js";
export type { IrVerifyError, IrVerificationOptions, TypeRuleStatus, TypeRuleCategory } from "./runtime/verify.js";
