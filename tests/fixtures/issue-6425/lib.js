// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Untyped JS on purpose (#6425): the defect only appears when the checker
// cannot resolve `TextEncoder` to a declaration, which is what the DOM-free
// `--platform node` lib produces for a plain .js file.

export function encodeLength(text) {
  const enc = new TextEncoder();
  return enc.encode(text).length;
}

export function roundTrip(text) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return dec.decode(enc.encode(text));
}
