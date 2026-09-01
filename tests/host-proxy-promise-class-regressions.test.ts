// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Focused host/dual-lane gate for the combined Proxy, Promise subclass,
// class-expression, and optional-chain regressions.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const TEST262_ROOT = join(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

// These are the exact thirteen host rows assigned to this regression slice.
// The standalone lane is intentionally restricted to the three expression
// rows below: native Proxy ownKeys invariants and Promise subclass construction
// remain host-runtime contracts in this compiler.
const HOST_ROWS = [
  "built-ins/Object/keys/proxy-non-enumerable-prop-invariant-1.js",
  "built-ins/Object/keys/proxy-non-enumerable-prop-invariant-3.js",
  "built-ins/Proxy/ownKeys/return-all-non-configurable-keys.js",
  "built-ins/Proxy/ownKeys/return-is-abrupt.js",
  "built-ins/Proxy/ownKeys/return-not-list-object-throws.js",
  "built-ins/Proxy/ownKeys/trap-is-not-callable.js",
  "built-ins/Proxy/set/trap-is-missing-target-is-proxy.js",
  "built-ins/Proxy/set/trap-is-undefined-no-property.js",
  "built-ins/Proxy/set/trap-is-undefined.js",
  "built-ins/Promise/prototype/then/ctor-custom.js",
  "language/expressions/class/elements/static-field-init-this-inside-arrow-function.js",
  "language/expressions/class/elements/super-access-from-arrow-func-on-field.js",
  "language/expressions/optional-chaining/optional-chain-prod-identifiername.js",
] as const;

const DUAL_LANE_ROWS = [
  "language/expressions/class/elements/static-field-init-this-inside-arrow-function.js",
  "language/expressions/class/elements/super-access-from-arrow-func-on-field.js",
  "language/expressions/optional-chaining/optional-chain-prod-identifiername.js",
] as const;

// Existing green controls exercise the neighboring class-expression and
// Proxy-target paths. Keeping them here makes the focused gate catch an
// over-broad dynamic-carrier or static-call change without treating the
// standalone-native Proxy limitations as regressions.
const CONTROLS = [
  "built-ins/Proxy/ownKeys/trap-is-undefined-target-is-proxy.js",
  "language/statements/class/elements/static-field-init-this-inside-arrow-function.js",
  "language/statements/class/elements/super-access-from-arrow-func-on-field.js",
] as const;

async function runRow(relativePath: string, lane: Lane) {
  const result = await runTest262File(
    join(TEST262_ROOT, "test", relativePath),
    `host-proxy-promise-class-${lane}`,
    120_000,
    lane === "standalone" ? lane : undefined,
  );
  restoreHostBuiltins();
  return result;
}

describe.skipIf(!HAVE_TEST262)("combined host Proxy/Promise/class regressions", () => {
  afterEach(() => {
    restoreHostBuiltins();
  });

  for (const relativePath of HOST_ROWS) {
    it(`host exact row: ${relativePath}`, { timeout: 180_000 }, async () => {
      const result = await runRow(relativePath, "host");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    });
  }

  for (const relativePath of DUAL_LANE_ROWS) {
    for (const lane of ["host", "standalone"] as const) {
      it(`${lane} dual-lane row: ${relativePath}`, { timeout: 180_000 }, async () => {
        const result = await runRow(relativePath, lane);
        expect(result.status, `${relativePath} (${lane}): ${result.error ?? result.reason ?? ""}`).toBe("pass");
      });
    }
  }

  for (const relativePath of CONTROLS) {
    for (const lane of ["host", "standalone"] as const) {
      it(`${lane} control row: ${relativePath}`, { timeout: 180_000 }, async () => {
        const result = await runRow(relativePath, lane);
        expect(result.status, `${relativePath} (${lane}): ${result.error ?? result.reason ?? ""}`).toBe("pass");
      });
    }
  }
});
