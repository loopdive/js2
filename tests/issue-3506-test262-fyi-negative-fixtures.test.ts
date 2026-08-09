// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";
import { FyiSourceExecutor, runTest } from "../scripts/run-test262-fyi.mjs";

const TEST_ROOT = join(import.meta.dirname, "..", "test262", "test");

const AFFECTED_PATHS = [
  "language/import/import-defer/syntax/invalid-defer-as-with-no-asterisk.js",
  "language/import/import-defer/syntax/invalid-defer-default-and-namespace.js",
  "language/import/import-defer/syntax/invalid-export-defer-namespace.js",
  "language/module-code/export-expname-from-as-unpaired-surrogate.js",
  "language/module-code/export-expname-from-star-unpaired-surrogate.js",
  "language/module-code/export-expname-from-unpaired-surrogate.js",
  "language/module-code/export-expname-import-unpaired-surrogate.js",
  "language/module-code/import-attributes/allow-nlt-before-with.js",
  "language/module-code/import-attributes/early-dup-attribute-key-export.js",
  "language/module-code/import-attributes/early-dup-attribute-key-import-withbinding.js",
  "language/module-code/import-attributes/import-attribute-key-string-double.js",
  "language/module-code/import-attributes/import-attribute-key-string-single.js",
  "language/module-code/import-attributes/import-attribute-value-string-double.js",
  "language/module-code/import-attributes/import-attribute-value-string-single.js",
] as const;

type OriginalHarnessTest = Awaited<ReturnType<typeof loadOriginalHarnessTests>>[number];

function upstreamSource(path: string): string {
  return readFileSync(join(TEST_ROOT, path), "utf8");
}

function literalGraph(test: OriginalHarnessTest): Record<string, string> {
  return { ...test.fixtureFiles, [test.entryFile]: test.contents };
}

describe("#3506 — FYI negative fixture JavaScript roots", () => {
  it("retains every literal entry and fixture under its pinned .js virtual path", async () => {
    const tests = await loadOriginalHarnessTests([...AFFECTED_PATHS]);
    expect(tests).toHaveLength(AFFECTED_PATHS.length);

    for (const test of tests) {
      expect(test.entryFile).toBe(`./${test.file}`);
      expect(test.entryFile.endsWith(".js")).toBe(true);
      expect(test.contents.endsWith(upstreamSource(test.file)), test.file).toBe(true);

      for (const [virtualPath, contents] of Object.entries(test.fixtureFiles)) {
        expect(virtualPath.endsWith(".js"), `${test.file}: ${virtualPath}`).toBe(true);
        expect(contents, `${test.file}: ${virtualPath}`).toBe(upstreamSource(virtualPath.slice(2)));
      }
    }
  });

  it("reports the parse rejection without excluding JavaScript graph roots", async () => {
    const path = "language/import/import-defer/syntax/invalid-defer-default-and-namespace.js";
    const [test] = await loadOriginalHarnessTests([path]);
    const result = await compileMulti(literalGraph(test), test.entryFile, {
      allowJs: true,
      strictJsSyntax: true,
      enforceJsEarlyErrors: true,
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: true,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.severity === "error")).toBe(true);
    expect(result.errors.map((error) => error.message).join("; ")).not.toContain("undefined");
  });

  it("surfaces the deliberate linked-fixture resolution error", async () => {
    const path = "language/module-code/import-attributes/import-attribute-value-string-double.js";
    const [test] = await loadOriginalHarnessTests([path]);
    const result = await compileMulti(literalGraph(test), test.entryFile, {
      allowJs: true,
      strictJsSyntax: true,
      enforceJsEarlyErrors: false,
      skipSemanticDiagnostics: false,
      inferModuleStrictArguments: true,
    });
    const errors = result.errors.filter((error) => error.severity === "error");

    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 2459,
        file: "language/module-code/import-attributes/ensure-linking-error_FIXTURE.js",
      }),
    );
    expect(errors.map((error) => error.message).join("; ")).not.toMatch(/cannot find module|module not found/i);
  });

  it("passes all 14 exact paths by static rejection in both FYI lanes", { timeout: 120_000 }, async () => {
    const tests = await loadOriginalHarnessTests([...AFFECTED_PATHS]);

    const runLane = async (target: "gc" | "standalone") => {
      const executor = new FyiSourceExecutor(30_000);
      try {
        for (const test of tests) {
          const result = await runTest(test, target, executor);
          expect(result, `${target}: ${test.file}`).toMatchObject({
            pass: true,
            phase: "compile",
            reachedTest: false,
          });
        }
      } finally {
        executor.shutdown();
      }
    };

    await Promise.all([runLane("gc"), runLane("standalone")]);
  });

  it("never treats a thrown fixture-graph compiler failure as a negative pass", async () => {
    const entryFile = "./language/module-code/issue-3506-collision.js";
    const result = await runTest(
      {
        file: entryFile.slice(2),
        entryFile,
        fixtureFiles: { [entryFile]: "export const fixture = 1;" },
        dynamicFixtureFiles: {},
        contents: "export {",
        flags: { module: true },
        negative: { phase: "parse", type: "SyntaxError" },
        strictRerun: false,
      },
      "gc",
    );

    expect(result.pass).toBe(false);
    expect(result).toMatchObject({ phase: "compile", reachedTest: false });
    expect(result.detail).toContain(`fixture graph collides with entry file: ${entryFile}`);
  });
});
