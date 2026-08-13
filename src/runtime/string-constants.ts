// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Extracted verbatim from src/runtime.ts (#3103) — string-constant import globals.
// Pure move, host-side only; emits zero Wasm. No logic change.

import { hasLoneSurrogate, hexCodeUnits } from "../string-surrogate.js";

/**
 * Build string constants object for the "string_constants" import namespace.
 * Each string pool entry becomes a WebAssembly.Global keyed by the literal text.
 */
export function buildStringConstants(stringPool: readonly string[] = []): Record<string, WebAssembly.Global> {
  // Use a null-prototype object so inherited names like "hasOwnProperty" /
  // "toString" / "constructor" from Object.prototype don't shadow real pool
  // entries via the `s in constants` duplicate check.
  const constants: Record<string, WebAssembly.Global> = Object.create(null);
  for (const s of stringPool) {
    // (#2880) Literals with a lone surrogate are imported from the
    // `string_constants16` namespace (hex-keyed) instead — see
    // buildStringConstants16. Skip them here so their lossy UTF-8 text isn't
    // also installed under a wrong key.
    if (hasLoneSurrogate(s)) continue;
    if (!(s in constants)) {
      constants[s] = new WebAssembly.Global({ value: "externref", mutable: false }, s);
    }
  }
  return constants;
}

/**
 * (#2880) Surrogate-safe sibling of {@link buildStringConstants}. A wasm import
 * field name must be valid UTF-8, so a string literal containing a lone
 * (unpaired) surrogate cannot be keyed by its own text. The compiler instead
 * imports such constants from the `string_constants16` namespace keyed by the
 * hex of their UTF-16 code units (ASCII). This mirrors that keying: the lookup
 * key is the hex, the global's VALUE is the real JS string (externref holds any
 * string, lone surrogates included). Surrogate-free literals are never routed
 * here — they stay in the plain `string_constants` namespace, unchanged.
 */
export function buildStringConstants16(stringPool: readonly string[] = []): Record<string, WebAssembly.Global> {
  const constants: Record<string, WebAssembly.Global> = Object.create(null);
  for (const s of stringPool) {
    if (!hasLoneSurrogate(s)) continue;
    const key = hexCodeUnits(s);
    if (!(key in constants)) {
      constants[key] = new WebAssembly.Global({ value: "externref", mutable: false }, s);
    }
  }
  return constants;
}
