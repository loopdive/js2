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
const TARGET_PATH = "language/statements/let/dstr/ary-init-iter-get-err-array-prototype.js";
const previousCanaryMode = process.env.TEST262_REALM_CANARY;

let pool: CompilerPool;

async function runOriginalHarness(source: string, label: string): Promise<RecyclingTestResult> {
  const meta = parseMeta(source);
  const assembly = assembleOriginalHarness(source, meta);
  return (await pool.runTest(
    assembly.primary.source,
    {
      originalHarness: true,
      asyncTest: assembly.async,
      inferModuleStrictArguments: meta.flags?.includes("module") === true,
      label,
    },
    30_000,
  )) as RecyclingTestResult;
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

describe("#4758 ES2015 destructuring compile-timeout regression", () => {
  it("executes the exact generated destructuring pin after deleting Array.prototype[Symbol.iterator]", async () => {
    const source = readFileSync(join(TEST262_ROOT, TARGET_PATH), "utf8");
    const meta = parseMeta(source);
    const assembly = assembleOriginalHarness(source, meta);
    expect(assembly.strictRerun, "the generated pin must exercise its strict rerun").toBeDefined();

    const primary = (await pool.runTest(
      assembly.primary.source,
      {
        originalHarness: true,
        asyncTest: assembly.async,
        inferModuleStrictArguments: meta.flags?.includes("module") === true,
        label: `${TARGET_PATH} [primary]`,
      },
      30_000,
    )) as RecyclingTestResult;
    expect(primary.status, JSON.stringify(primary)).toBe("pass");
    expect(primary.reachedTest).toBe(true);
    expect(primary.recycle).toBe(true);
    expect(primary.recycleReason).toContain("Array.prototype[Symbol.iterator]");

    const strict = (await pool.runTest(
      assembly.strictRerun!.source,
      {
        originalHarness: true,
        asyncTest: assembly.async,
        inferModuleStrictArguments: meta.flags?.includes("module") === true,
        label: `${TARGET_PATH} [strict]`,
      },
      30_000,
    )) as RecyclingTestResult;
    expect(strict.status, JSON.stringify(strict)).toBe("pass");
    expect(strict.reachedTest).toBe(true);
    expect(strict.recycle).toBe(true);
    expect(strict.recycleReason).toContain("Array.prototype[Symbol.iterator]");
  }, 75_000);

  it("keeps a non-destructive original-harness control on the same worker", async () => {
    const result = await runOriginalHarness("assert.sameValue(1, 1);\n", "#4758 host no-delete control");
    expect(result.status, JSON.stringify(result)).toBe("pass");
    expect(result.reachedTest).toBe(true);
    expect(result.recycle).not.toBe(true);
  }, 40_000);

  it("keeps a standalone test isolated after deleting its mutable Array iterator", async () => {
    const source = `export function test(): number {
  delete Array.prototype[Symbol.iterator];
  return 1;
}`;
    const result = (await pool.runTest(
      source,
      { target: "standalone", label: "#4758 standalone delete-iterator control" },
      30_000,
    )) as RecyclingTestResult;
    expect(result.status, JSON.stringify(result)).toBe("pass");
    expect(result.reachedTest).toBe(true);
    // Standalone code mutates its host-free Wasm realm, not the Node worker's
    // Array prototype. The control therefore must not request a host-fork
    // recycle; it still pins successful compile/execute through the same
    // standalone worker path used by the exact counterparts.
    expect(result.recycle).not.toBe(true);
  }, 40_000);

  it("keeps a clean standalone control after the destructive pin", async () => {
    const result = (await pool.runTest(
      "export function test(): number { return 1; }",
      { target: "standalone", label: "#4758 standalone clean control" },
      30_000,
    )) as RecyclingTestResult;
    expect(result.status, JSON.stringify(result)).toBe("pass");
    expect(result.reachedTest).toBe(true);
    expect(result.recycle).not.toBe(true);
  }, 40_000);
});
