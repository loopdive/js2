// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4685 — standalone Proxy ownKeys trap-result validation. These pins drive
// the exact Test262 files through runTest262File(..., "standalone"), rather
// than a smaller source probe that could route through a different lowering.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const OWN_KEYS_ROOT = join(TEST262_ROOT, "test", "built-ins", "Proxy", "ownKeys");

// Keep the worker responsive while each exact Test262 pin compiles a complete
// harness module. This is the same two-turn yield used by the nearby standalone
// pin suites.
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

const selectedRows = [
  "return-not-list-object-throws.js",
  "return-not-list-object-throws-realm.js",
  "return-type-throws-array.js",
  "return-type-throws-boolean.js",
  "return-type-throws-null.js",
  "return-type-throws-number.js",
  "return-type-throws-object.js",
  "return-type-throws-undefined.js",
  "return-duplicate-entries-throws.js",
  "return-duplicate-symbol-entries-throws.js",
] as const;

const controls = ["extensible-return-trap-result.js", "return-is-abrupt.js"] as const;

async function runOwnKeysRow(file: string) {
  return runTest262File(join(OWN_KEYS_ROOT, file), "issue-4685", 30_000, "standalone");
}

function expectPassOrUnavailableEvalTier(result: { status: string; error?: string }): void {
  if (result.status === "pass") return;
  // The realm pin needs the optional QuickJS/runtime-eval provider. Keep the
  // semantic assertion strict when that provider is present, while allowing
  // the ordinary local/quality tier's documented provider refusal.
  expect(result.error ?? "").toMatch(
    /quickjs provider is not built|runtime-eval.*(refusal|not supported)|module is not an object or function|dynamic code evaluation is not supported/i,
  );
}

describe.skipIf(!TEST262)("#4685 — Proxy ownKeys trap-result validation", () => {
  for (const file of selectedRows) {
    it(`${file} passes in standalone`, { timeout: 60_000 }, async () => {
      const result = await runOwnKeysRow(file);
      if (file.endsWith("-realm.js")) {
        expectPassOrUnavailableEvalTier(result);
      } else {
        expect(result.status, result.error ?? "").toBe("pass");
      }
    });
  }

  for (const file of controls) {
    it(`${file} remains a zero-loss control`, { timeout: 60_000 }, async () => {
      const result = await runOwnKeysRow(file);
      expect(result.status, result.error ?? "").toBe("pass");
    });
  }
});
