// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The one switch for the Prepared path's self-checks (#7380). They re-prove that the compiler's own in-memory data
// was not altered by another compiler module, a fault no source program can cause, so a production compile skips
// them. Tests and CI run them: `vitest.config.ts` sets `JS2WASM_VALIDATE_PREPARED=1` unless the caller set it.
//
// The environment is read here and nowhere else. It is read directly rather than through `src/env.ts` `readEnv`
// because the foundation layer imports nothing outside itself (`scripts/compiler-boundaries.json`), and both
// `src/wasm/physical` and `src/ir` read this switch.

let enabled =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.JS2WASM_VALIDATE_PREPARED ===
  "1";

export function preparedValidationEnabled(): boolean {
  return enabled;
}

/** For tests that compare one compile with the checks on and off in the same process. */
export function setPreparedValidation(on: boolean): void {
  enabled = on;
}
