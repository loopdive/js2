// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { _installIteratorHelperPolyfills } from "./iterator-polyfills.js";
import { _installLegacyRegExpAccessors, type LegacyRegExpState } from "./legacy-regexp.js";
import { _installPromiseTryPolyfill, _promiseTryTargets } from "./promise-try-polyfill.js";

export interface AmbientCompatibilityOptions {
  enabled: boolean;
  deps?: Record<string, any>;
  legacyRegExpState: LegacyRegExpState;
  // (#6440) The `node:vm` sandbox realm in play, if any — its own `Promise`
  // (distinct from the real global one) also gets checked for `Promise.try`.
  globalSandbox?: Record<string, any>;
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
  for (const C of _promiseTryTargets(options.globalSandbox)) _installPromiseTryPolyfill(C);
}
