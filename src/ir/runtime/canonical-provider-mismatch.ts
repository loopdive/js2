// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { RuntimeProviderDefinition } from "./contracts/manifest.js";

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
    if (JSON.stringify(provider[field]) !== JSON.stringify(canonical[field]))
      return `${family} provider ${field} mismatch`;
  for (const field of ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"] as const)
    if (JSON.stringify([...provider[field]].sort()) !== JSON.stringify([...canonical[field]].sort()))
      return `${family} provider ${field} mismatch`;
  return undefined;
}
