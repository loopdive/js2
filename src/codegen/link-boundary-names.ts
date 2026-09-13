// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5406) Leaf module: wasm→wasm link-boundary export NAMES that more than one
 * side of an import cycle needs.
 *
 * The name of a boundary terminal IS the ABI, so both the module that PUBLISHES
 * it (`standalone-link-boundary.ts`) and the module that CONSUMES it
 * (`object-proto-tostring.ts`, whose classifier emits the peer call) have to
 * spell it identically. Those two cannot import each other —
 * `standalone-link-boundary` ← `object-runtime` ← `object-proto-tostring` is an
 * existing edge, so a direct import would close a cycle — and duplicating the
 * string in both files is exactly the drift this project has been bitten by
 * before (the `matchAll` well-known-symbol mirror, #3573).
 *
 * This file therefore imports NOTHING. Add a name here only when a second
 * module on the far side of such an edge needs it.
 */

/**
 * (#5406) `(externref) -> externref` — the owner's §20.1.3.6 classification of
 * one of ITS values, as the finished `"[object X]"` string, or
 * `ref.null.extern` for "not a value I can classify".
 *
 * Null (rather than a default `"[object Object]"`) is the miss signal for the
 * same reason `__js2wasm_link_member_get` normalises `undefined` to null: the
 * consumer must be able to tell a real answer from a miss and keep its own
 * loud refusal otherwise.
 */
export const LINK_BOUNDARY_TO_STRING_TAG = "__js2wasm_link_to_string_tag";
