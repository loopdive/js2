// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * In-module native RegExp carrier ABI shared by legacy codegen and IR.
 *
 * This is a defined Wasm helper, never a host import. Its receiver-first ABI
 * preserves the `$NativeRegExp` brand check before any user-method dispatch.
 *
 * (#3113 S2) Lives BELOW the IR, not in `src/codegen/`, for the same reason
 * `js-tag.ts` moved in slice 1: it is shared *vocabulary* — a dependency-free
 * name that both the IR front-end and the legacy codegen must agree on — so
 * homing it in codegen forced `src/ir/` to import upward. It has no imports of
 * its own, so the move is pure relocation.
 */
export const STANDALONE_REGEXP_CARRIER_TEST_HELPER = "__regexp_test_carrier";
