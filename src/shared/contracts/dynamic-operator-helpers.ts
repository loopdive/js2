// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 Str2-c, L0a) The front end's dynamic `+` and relational operators over two carrier operands, shared below
 * codegen, which fills their ordinary-pipeline bodies (`dyn-ops.ts`), and the IR, which emits them (`from-ast.ts`) and
 * on the Prepared path expands them (`dynamic-value-legalization.ts`, `dynamic-comparisons.ts`).
 *
 * A leaf of its own, as `in-operator-helper.ts` is: codegen imports nothing from the IR, and a clean IR module
 * nothing from codegen, so no module either side owns can hold a name both read.
 */
export const IR_DYN_ADD_FN = "__ir_dyn_add";
export const IR_DYN_LT_FN = "__ir_dyn_lt";
export const IR_DYN_LE_FN = "__ir_dyn_le";
export const IR_DYN_GT_FN = "__ir_dyn_gt";
export const IR_DYN_GE_FN = "__ir_dyn_ge";

/**
 * (#7354 L0a) Each relational operator by its token: the front-end helper over two carriers, the `f64` compare of two
 * numbers and the fold of a string compare's -1/0/1 sign. `a > b` is IsLessThan(b, a) and `a <= b` its negation with
 * undefined (a NaN) as false, which for numbers is exactly `f64.gt` / `f64.le` (false on NaN) and for strings the
 * sign's order.
 */
export const RELATIONAL_OPERATORS = Object.freeze({
  "<": Object.freeze({ helper: IR_DYN_LT_FN, number: "f64.lt", sign: "i32.lt_s" }),
  "<=": Object.freeze({ helper: IR_DYN_LE_FN, number: "f64.le", sign: "i32.le_s" }),
  ">": Object.freeze({ helper: IR_DYN_GT_FN, number: "f64.gt", sign: "i32.gt_s" }),
  ">=": Object.freeze({ helper: IR_DYN_GE_FN, number: "f64.ge", sign: "i32.ge_s" }),
} as const);

export type RelationalOperator = (typeof RELATIONAL_OPERATORS)[keyof typeof RELATIONAL_OPERATORS];
