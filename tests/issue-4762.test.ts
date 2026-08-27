// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompilerPool, type TestResult } from "../scripts/compiler-pool.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

interface RecyclingTestResult extends TestResult {
  recycle?: boolean;
  recycleReason?: string;
}

const TEST262_ROOT = join(import.meta.dirname, "..", "test262", "test");
const previousCanaryMode = process.env.TEST262_REALM_CANARY;
let pool: CompilerPool;

beforeAll(async () => {
  process.env.TEST262_REALM_CANARY = "recycle";
  pool = new CompilerPool(1, "unified");
  await pool.ready();
}, 30_000);

afterAll(() => {
  pool?.shutdown();
  if (previousCanaryMode === undefined) process.env.TEST262_REALM_CANARY = undefined;
  else process.env.TEST262_REALM_CANARY = previousCanaryMode;
});

async function runPrimary(path: string): Promise<RecyclingTestResult> {
  const source = readFileSync(join(TEST262_ROOT, path), "utf8");
  const meta = parseMeta(source);
  const assembly = assembleOriginalHarness(source, meta);
  return (await pool.runTest(
    assembly.primary.source,
    {
      originalHarness: true,
      asyncTest: assembly.async,
      inferModuleStrictArguments: meta.flags?.includes("module") === true,
      label: `${path} [primary]`,
    },
    30_000,
  )) as RecyclingTestResult;
}

describe("#4762 mutation-safe Test262 realm canary", () => {
  const rows = [
    "language/expressions/instanceof/prototype-getter-with-object-throws.js",
    "language/statements/for-in/head-lhs-let.js",
  ] as const;

  for (const path of rows) {
    it(`finishes cleanup after ${path}`, async () => {
      const result = await runPrimary(path);
      expect(result.status, JSON.stringify(result)).toBe("pass");
      expect(result.reachedTest).toBe(true);
      expect(result.recycle).toBe(true);
    }, 45_000);
  }
});
