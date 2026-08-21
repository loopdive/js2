// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { tunedFlagEnabled } from "../perf-flags.js";

/** `JS2WASM_FUSED_TONUMBER` — Slice A, the fused `__to_number`. */
export function fusedToNumberEnabled(): boolean {
  return tunedFlagEnabled(process.env.JS2WASM_FUSED_TONUMBER);
}

/** `JS2WASM_SMI_FASTPATH` — Slice B. Default ON (at the `all` level). */
export function smiFastPathEnabled(): boolean {
  return tunedFlagEnabled(process.env.JS2WASM_SMI_FASTPATH);
}

/**
 * `JS2WASM_SMI_FASTPATH=all` enables the unrestricted box-side guard. `=1`
 * selects the restricted level; every other non-off value retains the tuned
 * default measured for the fast path.
 */
export function smiFastPathAllValues(): boolean {
  const raw = process.env.JS2WASM_SMI_FASTPATH;
  if (!tunedFlagEnabled(raw)) return false;
  if (raw === undefined) return true;
  const norm = raw.trim().toLowerCase();
  return norm !== "1" && norm !== "true" && norm !== "on" && norm !== "yes";
}
