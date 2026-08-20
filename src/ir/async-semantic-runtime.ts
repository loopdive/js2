// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Target-neutral callable identities used by the final prepared async owner. */
export const IR_ASYNC_CLOCK_SNAPSHOT_FN = "async.clock.snapshot";
export const IR_ASYNC_NUMBER_TO_STRING_FN = "async.number.to-string";
export const IR_ASYNC_CONSOLE_LOG_STRING_FN = "async.console.log-string";
export const IR_ASYNC_STRING_CONCAT_5_FN = "async.string.concat$arity5";

/** Standalone-native callable providers used only after target projection. */
export const IR_ASYNC_PROMISE_ALL_NATIVE_FN = "__ir_async_promise_all_native";
