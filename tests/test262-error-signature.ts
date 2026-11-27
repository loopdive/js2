// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The one normaliser for test262 error text. The runner stamps every result
 * row's `error_signature` with it, and the #7568 edition report ranks
 * non-pass reasons from it, so both group the same causes. Kept free of
 * imports so tools outside vitest can load it.
 */

/** Error text with positions, offsets, addresses and numbers made uniform. */
export function normalizeErrorText(error: string): string {
  return error
    .replace(/\bL\d+:\d+/g, "L#:##")
    .replace(/\bL\d+\b/g, "L#")
    .replace(/@\+\d+/g, "@+#")
    .replace(/0x[0-9a-f]+/gi, "0x#")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeErrorSignature(status: string, errorCategory: string | undefined, error: string | undefined) {
  if (!error) return undefined;
  return `${errorCategory ?? status}:${normalizeErrorText(error).slice(0, 240)}`;
}
