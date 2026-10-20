// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { RuntimeProviderDefinition } from "./contracts/manifest.js";
import { copyPreparedIrDataObject } from "../../shared/contracts/prepared-ir-data.js";

export function snapshotRuntimeProvider(
  value: RuntimeProviderDefinition,
  signature: RuntimeProviderDefinition["signature"],
  compareStrings: (left: string, right: string) => number,
): RuntimeProviderDefinition {
  return Object.freeze(
    copyPreparedIrDataObject({
      ...value,
      ...(signature === undefined ? {} : { signature }),
      dependencies: Object.freeze([...new Set(value.dependencies)].sort(compareStrings)),
      hostCapabilities: Object.freeze([...new Set(value.hostCapabilities)].sort(compareStrings)),
      supportedTargets: Object.freeze([...new Set(value.supportedTargets)].sort(compareStrings)),
      supportedBackends: Object.freeze([...new Set(value.supportedBackends)].sort(compareStrings)),
      implementation: Object.freeze(
        copyPreparedIrDataObject({
          ...value.implementation,
        } satisfies RuntimeProviderDefinition["implementation"]) as unknown as RuntimeProviderDefinition["implementation"],
      ),
    } satisfies RuntimeProviderDefinition) as unknown as RuntimeProviderDefinition,
  );
}
