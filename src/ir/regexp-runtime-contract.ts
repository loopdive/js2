// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * In-module native RegExp carrier ABI shared by legacy codegen and IR.
 *
 * These are defined Wasm helpers, never host imports. Their receiver-first ABI
 * preserves the `$NativeRegExp` brand check before any user-method dispatch.
 *
 * (#3113 S2) Lives BELOW the IR, not in `src/codegen/`, for the same reason
 * `js-tag.ts` moved in slice 1: it is shared *vocabulary* — names that both
 * the IR front-end and the legacy codegen must agree on — so homing it in
 * codegen forced `src/ir/` to import upward. Its one import is type-only.
 */
import type { RegExpCarrierMethod } from "../shared/regexp-static.js";

export const STANDALONE_REGEXP_CARRIER_TEST_HELPER = "__regexp_test_carrier";
/** (#6672) The `exec` twin: `(recv, subject) -> externref`, the match array or null. */
export const STANDALONE_REGEXP_CARRIER_EXEC_HELPER = "__regexp_exec_carrier";

/**
 * (#7106 levers R1, R2) Each carrier method's helper and what its call answers
 * in the IR: `test` a boolean, `exec` the match array or null as the dynamic
 * carrier.
 */
export const REGEXP_CARRIER_METHODS: Readonly<
  Record<RegExpCarrierMethod, { readonly helper: string; readonly result: "boolean" | "dynamic" }>
> = {
  test: { helper: STANDALONE_REGEXP_CARRIER_TEST_HELPER, result: "boolean" },
  exec: { helper: STANDALONE_REGEXP_CARRIER_EXEC_HELPER, result: "dynamic" },
};
