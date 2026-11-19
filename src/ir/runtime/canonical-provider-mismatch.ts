// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { RuntimeProviderDefinition } from "./contracts/manifest.js";

/** Compare the finite data records directly; custom serializers are never evidence. */
function sameData(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (actual === null || typeof actual !== "object" || Array.isArray(expected) !== Array.isArray(actual)) return false;
  const keys = Reflect.ownKeys(expected);
  if (keys.length !== Reflect.ownKeys(actual).length) return false;
  return keys.every((key) => {
    const left = Object.getOwnPropertyDescriptor(expected, key);
    const right = Object.getOwnPropertyDescriptor(actual, key);
    return (
      left !== undefined &&
      right !== undefined &&
      "value" in left &&
      "value" in right &&
      sameData(left.value, right.value)
    );
  });
}

/**
 * A provider that names a canonical row by id or feature must equal that row
 * field for field; list fields compare as sets. `undefined` means the provider
 * belongs to none of `rows`.
 */
export function canonicalProviderMismatch(
  rows: readonly RuntimeProviderDefinition[],
  provider: RuntimeProviderDefinition,
  family: string,
): string | undefined {
  const canonical = rows.find((row) => row.id === provider.id || row.feature === provider.feature);
  if (!canonical) return undefined;
  for (const field of ["id", "feature", "signature", "implementation"] as const)
    if (!sameData(canonical[field], provider[field])) return `${family} provider ${field} mismatch`;
  for (const field of ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"] as const)
    if (!sameData([...canonical[field]].sort(), [...provider[field]].sort()))
      return `${family} provider ${field} mismatch`;
  return undefined;
}
