// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6770, #6797) Native runtime function NAMES the codegen core registers and
 * the object-model leaves look up in `ctx.funcMap`.
 *
 * A name is data. Keeping it in a module that imports nothing lets a leaf find
 * the function without a value import of the core module that registers it —
 * such an import (with the core importing the leaf back) pulls the leaf into
 * the codegen import cycle (`scripts/check-import-cycles.mjs`). The registering
 * modules re-export these, so every existing import site is unchanged.
 */

/** `(externref obj, externref key) -> i32` — 1 iff the carrier bag holds a live entry (carrier-bag-visibility.ts). */
export const CARRIER_BAG_HAS = "__carrier_bag_has";

/** The String-exotic own-index key pusher (string-exotic-own-props.ts). */
export const STRING_EXOTIC_PUSH_KEYS_FN = "__strexo_push_keys";
