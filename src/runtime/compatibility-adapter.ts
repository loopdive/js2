// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { _installIteratorHelperPolyfills } from "./iterator-polyfills.js";
import { _installLegacyRegExpAccessors, type LegacyRegExpState } from "./legacy-regexp.js";

export interface AmbientCompatibilityOptions {
  enabled: boolean;
  deps?: Record<string, any>;
  legacyRegExpState: LegacyRegExpState;
}

/**
 * Install the historical ambient compatibility surface. Native-first adapter
 * plans never call this path; compatibility profiles opt in explicitly.
 */
export function installAmbientCompatibility(options: AmbientCompatibilityOptions): void {
  if (!options.enabled) return;
  _installIteratorHelperPolyfills();
  const RegExpConstructor = options.deps?.RegExp ?? (typeof RegExp !== "undefined" ? RegExp : undefined);
  if (RegExpConstructor) _installLegacyRegExpAccessors(RegExpConstructor, options.legacyRegExpState);
}
