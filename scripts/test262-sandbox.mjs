// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Build the fresh VM realm shared by every original-harness Test262 lane.
 *
 * Copying a handwritten allowlist silently omitted standard globals such as
 * Int8Array, so literal upstream harness code observed `undefined` instead of
 * the realm's constructor (#3414). Discover the realm's own global names so
 * each host exposes exactly the standard features it actually supports.
 */
import { createContext, runInContext } from "node:vm";

const EXPLICIT_GLOBALS = new Set(["undefined", "Infinity", "NaN", "globalThis", "console"]);

export function buildTest262Sandbox(consoleProxy) {
  const sandbox = Object.create(null);
  const context = createContext(sandbox);
  const names = runInContext("Object.getOwnPropertyNames(globalThis)", context);

  for (const name of names) {
    if (EXPLICIT_GLOBALS.has(name)) continue;
    try {
      sandbox[name] = runInContext(`globalThis[${JSON.stringify(name)}]`, context);
    } catch {
      // A host may expose a guarded global accessor. Leave it absent when
      // reading that feature is unsupported in the fresh realm.
    }
  }

  Object.defineProperties(sandbox, {
    undefined: { value: undefined, writable: false, enumerable: false, configurable: false },
    Infinity: { value: Number.POSITIVE_INFINITY, writable: false, enumerable: false, configurable: false },
    NaN: { value: Number.NaN, writable: false, enumerable: false, configurable: false },
  });
  if (consoleProxy) sandbox.console = consoleProxy;
  sandbox.globalThis = sandbox;
  return sandbox;
}
