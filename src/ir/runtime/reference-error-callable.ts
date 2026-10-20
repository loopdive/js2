// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { RuntimeProviderDefinition } from "./contracts/manifest.js";
import { REFERENCE_ERROR_DECLARATION, REFERENCE_ERROR_RUNTIME_PROVIDERS } from "../core/reference-error-contract.js";
export {
  REFERENCE_ERROR_DECLARATION,
  REFERENCE_ERROR_SIGNATURE,
  REFERENCE_ERROR_RUNTIME_PROVIDERS,
} from "../core/reference-error-contract.js";

/** Selection binds the complete canonical descriptor, never only its ID. */
export function referenceErrorProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  if (
    provider.feature !== REFERENCE_ERROR_DECLARATION.feature &&
    !REFERENCE_ERROR_RUNTIME_PROVIDERS.some((candidate) => candidate.id === provider.id)
  )
    return undefined;
  const canonical = REFERENCE_ERROR_RUNTIME_PROVIDERS.find((candidate) => candidate.id === provider.id);
  if (!canonical) return "ReferenceError callable provider id mismatch";
  for (const field of ["feature", "signature", "implementation"] as const)
    if (JSON.stringify(provider[field]) !== JSON.stringify(canonical[field]))
      return `ReferenceError callable provider ${field} mismatch`;
  for (const field of ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"] as const)
    if (JSON.stringify([...provider[field]].sort()) !== JSON.stringify([...canonical[field]].sort()))
      return `ReferenceError callable provider ${field} mismatch`;
  return undefined;
}
