// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Canonical carrier IDs shared with the retained compiler's well-known Symbols. */
export const WELL_KNOWN_SYMBOL_IDS = Object.freeze({
  iterator: 1,
  hasInstance: 2,
  toPrimitive: 3,
  toStringTag: 4,
  species: 5,
  isConcatSpreadable: 6,
  match: 7,
  replace: 8,
  search: 9,
  split: 10,
  unscopables: 11,
  asyncIterator: 12,
  dispose: 13,
  asyncDispose: 14,
  matchAll: 15,
} as const);

export type WellKnownSymbolName = keyof typeof WELL_KNOWN_SYMBOL_IDS;

export function wellKnownSymbolId(name: string): number | undefined {
  return Object.hasOwn(WELL_KNOWN_SYMBOL_IDS, name) ? WELL_KNOWN_SYMBOL_IDS[name as WellKnownSymbolName] : undefined;
}
