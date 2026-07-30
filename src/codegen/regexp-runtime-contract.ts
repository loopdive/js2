// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * In-module native RegExp carrier ABI shared by legacy codegen and IR.
 *
 * This is a defined Wasm helper, never a host import. Its receiver-first ABI
 * preserves the `$NativeRegExp` brand check before any user-method dispatch.
 */
export const STANDALONE_REGEXP_CARRIER_TEST_HELPER = "__regexp_test_carrier";
