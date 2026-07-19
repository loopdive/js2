// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompilerPool } from "../scripts/compiler-pool.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

const TEST262_ROOT = join(import.meta.dirname, "..", "test262", "test");
const previousCanaryMode = process.env.TEST262_REALM_CANARY;
let pool: CompilerPool;

async function runVariant(source: string, label: string, strict: boolean) {
  const meta = parseMeta(source);
  const assembly = assembleOriginalHarness(source, meta);
  const variant = strict ? assembly.strictRerun : assembly.primary;
  expect(variant, `${label} must have a ${strict ? "strict" : "primary"} variant`).toBeDefined();
  return pool.runTest(
    variant!.source,
    {
      originalHarness: true,
      asyncTest: assembly.async,
      label: `${label} [${strict ? "strict" : "primary"}]`,
      inferModuleStrictArguments: meta.flags?.includes("module") === true,
    },
    30_000,
  );
}

beforeAll(async () => {
  process.env.TEST262_REALM_CANARY = "recycle";
  pool = new CompilerPool(1, "unified");
  await pool.ready();
}, 30_000);

afterAll(() => {
  pool?.shutdown();
  if (previousCanaryMode === undefined) delete process.env.TEST262_REALM_CANARY;
  else process.env.TEST262_REALM_CANARY = previousCanaryMode;
});

describe("#3468 strict delete throws a branded TypeError", () => {
  const paths = [
    "built-ins/Object/create/15.2.3.5-4-129.js",
    "built-ins/Object/defineProperties/15.2.3.7-5-b-91.js",
    "built-ins/Object/defineProperties/15.2.3.7-6-a-109.js",
  ] as const;

  for (const path of paths) {
    it(`passes propertyHelper's TypeError identity check: ${path}`, async () => {
      const source = readFileSync(join(TEST262_ROOT, path), "utf8");
      const primary = await runVariant(source, path, false);
      const strict = await runVariant(source, path, true);

      expect(primary.status, primary.error).toBe("pass");
      expect(strict.status, strict.error).toBe("pass");
    }, 70_000);
  }
});
