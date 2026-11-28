// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 propertyHelper, #7471) The front end's dynamic `delete <recv>[<key>]`, one helper per code strictness, shared
 * below codegen, which fills the ordinary pipeline's wrappers (`ir-dynamic-delete.ts`), and the IR, which emits the
 * call (`from-ast.ts`) and on the Prepared path expands it (`dynamic-value-legalization.ts`). Each pipeline decides
 * the strictness with its own rule; the name carries it.
 *
 * A leaf of its own, as `dynamic-add-helper.ts` is: codegen imports nothing from the IR, and a clean IR module
 * nothing from codegen.
 */
export const IR_DYN_DELETE_STRICT_HELPER = "__ir_dyn_delete_strict";
export const IR_DYN_DELETE_SLOPPY_HELPER = "__ir_dyn_delete_sloppy";

/** The helper a delete in code of this strictness calls. */
export function irDynamicDeleteHelperName(strict: boolean): string {
  return strict ? IR_DYN_DELETE_STRICT_HELPER : IR_DYN_DELETE_SLOPPY_HELPER;
}
