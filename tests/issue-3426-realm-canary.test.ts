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

async function runOriginalHarnessSource(
  source: string,
  label: string,
): Promise<{
  primary: RecyclingTestResult;
  strict: RecyclingTestResult;
}> {
  const meta = parseMeta(source);
  const assembly = assembleOriginalHarness(source, meta);
  expect(assembly.strictRerun, `${label} must have a strict rerun`).toBeDefined();

  const common = {
    originalHarness: true,
    asyncTest: assembly.async,
    inferModuleStrictArguments: meta.flags?.includes("module") === true,
  };
  const primary = (await pool.runTest(
    assembly.primary.source,
    { ...common, label: `${label} [primary]` },
    30_000,
  )) as RecyclingTestResult;
  const strict = (await pool.runTest(
    assembly.strictRerun!.source,
    { ...common, label: `${label} [strict]` },
    30_000,
  )) as RecyclingTestResult;
  return { primary, strict };
}

function runOriginalHarnessPair(path: string) {
  return runOriginalHarnessSource(readFileSync(join(TEST262_ROOT, path), "utf8"), path);
}

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

describe("#3426 original-harness intrinsic metadata isolation", () => {
  const destructiveCases = [
    {
      path: "built-ins/Math/random/length.js",
      drift: "Math.random.length:deleted",
    },
    {
      path: "built-ins/AsyncDisposableStack/prototype/defer/prop-desc.js",
      drift: "AsyncDisposableStack.prototype.defer:deleted",
    },
    {
      path: "built-ins/SharedArrayBuffer/prototype/slice/descriptor.js",
      drift: "SharedArrayBuffer.prototype.slice:deleted",
    },
    {
      path: "built-ins/String/prototype/concat/S15.5.4.6_A9.js",
      drift: "String.prototype.concat.length:deleted",
    },
  ] as const;

  for (const { path, drift } of destructiveCases) {
    it(`recycles between contaminated primary and strict variants: ${path}`, async () => {
      const { primary, strict } = await runOriginalHarnessPair(path);

      expect(primary.status).toBe("pass");
      expect(primary.recycle).toBe(true);
      expect(primary.recycleReason).toContain(drift);
      expect(strict.status).toBe("pass");
      expect(strict.recycle).toBe(true);
    }, 70_000);
  }

  it("recycles when an unchanged built-in method loses its name descriptor", async () => {
    const source = `/*---
description: Detect deleted built-in function name metadata
---*/
delete String.prototype.concat.name;
`;
    const { primary, strict } = await runOriginalHarnessSource(source, "String.prototype.concat.name deletion");

    for (const result of [primary, strict]) {
      expect(result.status).toBe("pass");
      expect(result.recycle).toBe(true);
      expect(result.recycleReason).toContain("String.prototype.concat.name:deleted");
    }
  }, 70_000);

  it("keeps a clean worker when the intrinsic surface does not drift", async () => {
    const path = "built-ins/String/prototype/concat/S15.5.4.6_A1_T1.js";
    const source = readFileSync(join(TEST262_ROOT, path), "utf8");
    const meta = parseMeta(source);
    const assembly = assembleOriginalHarness(source, meta);
    const result = (await pool.runTest(
      assembly.primary.source,
      {
        originalHarness: true,
        asyncTest: assembly.async,
        label: `${path} [clean primary]`,
        inferModuleStrictArguments: false,
      },
      30_000,
    )) as RecyclingTestResult;

    expect(result.status).toBe("pass");
    expect(result.recycle).not.toBe(true);
  }, 40_000);
});
