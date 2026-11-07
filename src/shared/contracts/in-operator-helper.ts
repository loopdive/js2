// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7304) The runtime helper behind the IR's `in`, shared below codegen, which
 * registers and fills it (`object-proto-name-in.ts`), and the IR, which calls
 * it (`native-in.ts`).
 */
export const IN_HAS_PROPERTY = "__extern_has_in_ir";
