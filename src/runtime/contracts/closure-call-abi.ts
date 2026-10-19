// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * __closure_has_rest discriminator for a receiver-independent native callable
 * whose one physical formal is the complete argv vector. Existing values 0
 * (positional) and 1 (source rest) retain their meanings. Not reflective length.
 */
export const PACKED_CLOSURE_ARGV = 2;

/** Append-only authenticated closure export slot: (callee, receiver, argv). */
export const CLOSURE_APPLY_BRIDGE = Object.freeze({
  name: "__call_fn_apply",
  alias: "$ci",
  bit: 18,
  ordinal: 15,
  legacySlots: 18,
  slots: 19,
} as const);
