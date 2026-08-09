// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";
import { runTest } from "../scripts/run-test262-fyi.mjs";
import { compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const EXACT_PATH = "language/module-code/instn-uniq-env-rec.js";

describe("#3505 — host compileMulti harness callable initialization", () => {
  it("runs one dependency-ordered graph initializer after exports are wired", async () => {
    const result = await compileMulti(
      {
        "./dependency.js": `
          export var dependencyRuns = 0;
          dependencyRuns += 1;
        `,
        "./entry.js": `
          import { dependencyRuns } from "./dependency.js";

          function assert(condition) {
            if (!condition) throw new Error("assertion failed");
          }
          assert.sameValue = function (actual, expected) {
            if (actual !== expected) throw new Error("values differ");
          };

          assert.sameValue(dependencyRuns, 1);
          var entryRuns = 0;
          entryRuns += 1;

          export function score() {
            return dependencyRuns * 10 + entryRuns;
          }
        `,
      },
      "./entry.js",
      { allowJs: true, skipSemanticDiagnostics: true, deferTopLevelInit: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
    const moduleInit = exports.__module_init as (() => void) | undefined;
    const score = exports.score as () => number;

    // Deferred means neither a stale partial initializer nor the final graph
    // initializer ran in the Wasm start section.
    expect(score()).toBe(0);
    expect(moduleInit).toBeTypeOf("function");

    imports.setInstance?.(instance);
    moduleInit!();

    // 11 proves dependency-before-entry order and one execution of each body.
    expect(score()).toBe(11);
  });

  it("passes the exact unmodified FYI GC fixture graph", { timeout: 60_000 }, async () => {
    const [test] = await loadOriginalHarnessTests([EXACT_PATH]);

    expect(test).toBeDefined();
    expect(Object.keys(test!.fixtureFiles)).toEqual(["./language/module-code/instn-uniq-env-rec-other_FIXTURE.js"]);
    await expect(runTest(test!, "gc")).resolves.toMatchObject({
      pass: true,
      phase: "runtime",
      reachedTest: true,
    });
  });

  it("leaves the exact standalone verdict unchanged", { timeout: 60_000 }, async () => {
    const [test] = await loadOriginalHarnessTests([EXACT_PATH]);

    await expect(runTest(test!, "standalone")).resolves.toMatchObject({
      pass: true,
      phase: "runtime",
      reachedTest: true,
    });
  });
});
