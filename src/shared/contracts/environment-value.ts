// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Read one environment variable without assuming a global `process` (#6782).
 *
 * The compiler core is also bundled for browsers and other hosts that have no
 * `process`, so `src/` reads its `JS2WASM_*` switches through this accessor
 * instead of `process.env.X`. A host without `process.env` reads every
 * variable as `undefined` — the same value an unset variable has under Node.
 * Reads are live, not cached: a test that sets `process.env.X` is seen by the
 * next call.
 */
export function readEnv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}
