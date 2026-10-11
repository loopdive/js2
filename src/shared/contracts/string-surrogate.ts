// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared between the compiler (codegen import emission) and the runtime
// (string-constant import-object construction). See #2880.
//
// Host-mode string literals are emitted as imported externref globals whose
// wasm import field name IS the literal text. A wasm import field name must be
// valid UTF-8, but a **lone (unpaired) surrogate** (U+D800–U+DFFF not part of a
// valid pair) is not a Unicode scalar value: `TextEncoder` replaces it with
// U+FFFD (lossy) and V8 rejects a WTF-8 name outright. So a literal containing a
// lone surrogate cannot be keyed by its own text.
//
// Such constants are instead routed through a separate `string_constants16`
// import namespace whose field name is the hex of the literal's UTF-16 code
// units (pure ASCII → always valid UTF-8, injective, reversible). Both the
// compiler and the runtime compute the identical key from the same source
// string, so the import resolves; the global's value stays the real string.

/** The import namespace used for surrogate-containing string constants (#2880). */
export const STRING_CONSTANTS16_NS = "string_constants16";

/**
 * True iff `s` contains at least one lone (unpaired) UTF-16 surrogate code unit.
 * Valid high+low surrogate pairs (astral scalars) are NOT lone and return false.
 */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate — needs an immediately-following low surrogate
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // consume the valid pair
        continue;
      }
      return true; // lone high
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // lone low
    }
  }
  return false;
}

/**
 * Deterministic, injective, ASCII-only key for a string with lone surrogates:
 * the 4-hex-digit (lowercase) UTF-16 code unit of each character, concatenated.
 * e.g. `'12\uD800'` → `"00310032d800"`. Used as the `string_constants16` import
 * field name on the compiler side and as the lookup key on the runtime side.
 */
export function hexCodeUnits(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    out += s.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return out;
}
