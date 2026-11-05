// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Console methods served by the native output providers and existing host adapters. */
export const CONSOLE_METHODS = ["log", "warn", "error", "info", "debug"] as const;
export const CONSOLE_METHOD_NAMES: ReadonlySet<string> = new Set(CONSOLE_METHODS);

/** Symbolic native-console callable ABI, shared by the IR producer and provider. */
export const IR_CONSOLE_SINK_APPEND_FN = "__ir_console_sink_append";
export const IR_CONSOLE_STDERR_APPEND_FN = "__ir_console_stderr_append";
export const IR_CONSOLE_FORMAT_VALUE_FN = "__ir_console_format_value";
