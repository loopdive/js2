// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4711 owns the dynamic-any/mutable-binding half of the Set for-of wave. The
// native Set cursor/storage rows remain #4708 controls and are intentionally
// not asserted here.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const HAS_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const FOR_OF_ROOT = join(TEST262_ROOT, "test", "language", "statements", "for-of");

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

async function runRow(file: string, target?: "standalone") {
  return runTest262File(join(FOR_OF_ROOT, file), "issue-4711", 30_000, target);
}

describe.skipIf(!HAS_TEST262)("#4711 — Set for-of dynamic bindings", () => {
  for (const target of [undefined, "standalone"] as const) {
    it(`${target ?? "host"}: set.js preserves mutable any values`, { timeout: 60_000 }, async () => {
      const result = await runRow("set.js", target);
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });

    it(`${target ?? "host"}: set-contract-expand.js preserves rebinding`, { timeout: 60_000 }, async () => {
      const result = await runRow("set-contract-expand.js", target);
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }

  // Host controls remain green. Standalone Set mutation controls belong to
  // #4708 and stay outside this PR's acceptance surface.
  for (const file of ["set-contract.js", "set-expand.js", "set-expand-contract.js"]) {
    it(`host control: ${file}`, { timeout: 60_000 }, async () => {
      const result = await runRow(file);
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
