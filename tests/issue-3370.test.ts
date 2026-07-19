// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";
import { CompilerPool } from "../scripts/compiler-pool.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta, runTest262File } from "./test262-runner.js";

const tempRoot = mkdtempSync(join(tmpdir(), "js2wasm-3370-"));
let unifiedPool: CompilerPool | undefined;

async function getUnifiedPool(): Promise<CompilerPool> {
  if (!unifiedPool) unifiedPool = new CompilerPool(1, "unified");
  await unifiedPool.ready();
  return unifiedPool;
}

function sortedArraySample(): string[] {
  const root = join(import.meta.dirname, "..", "test262", "test", "language", "expressions", "array");
  return readdirSync(root, { recursive: true })
    .filter((path): path is string => typeof path === "string" && path.endsWith(".js") && !path.includes("_FIXTURE"))
    .map((path) => `language/expressions/array/${path}`)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 50);
}

afterAll(() => {
  unifiedPool?.shutdown();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("#3370 literal Test262 project-runner oracle", () => {
  it("assembles the same source variants as test262.fyi", async () => {
    const path = "language/expressions/array/spread-err-mult-err-itr-step.js";
    const record = (await loadOriginalHarnessTests([path])).find((test) => test.file === path);
    expect(record).toBeDefined();

    const rawSource = readFileSync(join(import.meta.dirname, "..", "test262", "test", path), "utf8");
    const meta = parseMeta(rawSource);
    const assembly = assembleOriginalHarness(rawSource, meta);

    expect(assembly.primary.source).toBe(record!.contents);
    expect(assembly.strictRerun?.source).toBe(`"use strict";\n${record!.contents}`);
  }, 30_000);

  it("does not erase a failing undefined guard", async () => {
    const file = join(tempRoot, "undefined-guard.js");
    writeFileSync(
      file,
      `/*---
description: A failing undefined guard must remain observable
flags: [noStrict]
---*/
if (1 !== undefined) {
  throw new Test262Error("undefined guard executed");
}
`,
    );

    const result = await runTest262File(file, "runner-integrity");
    expect(result.status).toBe("fail");
    expect(result.error).toContain("Test262Error");
    expect(result.error).toContain("undefined guard executed");
  }, 30_000);

  it("keeps the same failure in the unified CI worker", async () => {
    const source = `/*---
description: A failing undefined guard must remain observable in CI
flags: [noStrict]
---*/
if (1 !== undefined) {
  throw new Test262Error("CI undefined guard executed");
}
`;
    const meta = parseMeta(source);
    const assembly = assembleOriginalHarness(source, meta);
    const pool = await getUnifiedPool();
    const result = await pool.runTest(
      assembly.primary.source,
      {
        originalHarness: true,
        isRuntimeNegative: false,
        asyncTest: false,
        label: "#3370 CI oracle regression",
        inferModuleStrictArguments: false,
      },
      30_000,
    );
    expect(result.status).toBe("fail");
    expect(result.error).toContain("CI undefined guard executed");
  }, 40_000);

  it("does not turn a wrong-phase negative into a pass", async () => {
    const runtimeNegative = join(tempRoot, "runtime-negative-compile-error.js");
    writeFileSync(
      runtimeNegative,
      `/*---
negative:
  phase: runtime
  type: TypeError
flags: [noStrict]
---*/
const = ;
`,
    );
    const compileResult = await runTest262File(runtimeNegative, "runner-integrity");
    expect(compileResult.status).toBe("compile_error");

    const parseNegative = join(tempRoot, "parse-negative-runtime-throw.js");
    writeFileSync(
      parseNegative,
      `/*---
negative:
  phase: parse
  type: SyntaxError
flags: [noStrict]
---*/
throw new SyntaxError("too late");
`,
    );
    const runtimeResult = await runTest262File(parseNegative, "runner-integrity");
    expect(runtimeResult.status).toBe("fail");

    const pool = await getUnifiedPool();
    const runtimeSource = readFileSync(runtimeNegative, "utf8");
    const runtimeMeta = parseMeta(runtimeSource);
    const runtimeAssembly = assembleOriginalHarness(runtimeSource, runtimeMeta);
    const workerCompileResult = await pool.runTest(
      runtimeAssembly.primary.source,
      {
        originalHarness: true,
        isRuntimeNegative: true,
        expectedErrorType: "TypeError",
        label: "#3370 runtime-negative compile rejection",
      },
      30_000,
    );
    expect(workerCompileResult.status).toBe("compile_error");

    const parseSource = readFileSync(parseNegative, "utf8");
    const parsedMeta = parseMeta(parseSource);
    const parseAssembly = assembleOriginalHarness(parseSource, parsedMeta);
    const workerRuntimeResult = await pool.runTest(
      parseAssembly.primary.source,
      {
        originalHarness: true,
        isNegative: true,
        expectedErrorType: "SyntaxError",
        label: "#3370 parse-negative late runtime throw",
      },
      30_000,
    );
    expect(workerRuntimeResult.status).toBe("fail");
  }, 30_000);

  it("matches 50/50 in the unified CI worker, including strict reruns", async () => {
    const paths = sortedArraySample();
    expect(paths).toHaveLength(50);
    const allRecords = await loadOriginalHarnessTests(paths);
    const records = new Map(allRecords.map((record) => [record.file, record]));
    const pool = await getUnifiedPool();
    const failures: Array<{ path: string; strict: boolean; status: string; error?: string }> = [];
    for (const path of paths) {
      const rawSource = readFileSync(join(import.meta.dirname, "..", "test262", "test", path), "utf8");
      const meta = parseMeta(rawSource);
      const assembly = assembleOriginalHarness(rawSource, meta);
      expect(assembly.primary.source).toBe(records.get(path)?.contents);
      for (const variant of [assembly.primary, assembly.strictRerun].filter((value) => value !== undefined)) {
        const result = await pool.runTest(
          variant.source,
          {
            originalHarness: true,
            asyncTest: assembly.async,
            label: `${path}${variant.strict ? " [strict]" : ""}`,
            inferModuleStrictArguments: meta.flags?.includes("module") === true,
          },
          30_000,
        );
        if (result.status !== "pass") {
          failures.push({ path, strict: variant.strict, status: result.status, error: result.error });
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
