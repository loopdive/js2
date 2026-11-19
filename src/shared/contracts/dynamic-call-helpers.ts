// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The front end's function-value carrier helpers (`function-object-lowering.ts`): box a packed callable into the
 * dynamic value, read the externref back, and project a call argument. Shared below codegen, which fills their
 * ordinary-pipeline bodies (`dyn-ops.ts`), and the IR, which emits them and (#7354 Fa) on the Prepared path
 * expresses them over the externref carrier (`dynamic-value-legalization.ts`).
 */
export const IR_DYN_CALL_BOX_FN = "__ir_dyn_call_box";
export const IR_DYN_CALL_VALUE_FN = "__ir_dyn_call_value";
export const IR_DYN_CALL_ARGUMENT_FN = "__ir_dyn_call_argument";
