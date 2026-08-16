import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood runner has no declaration file
import { UPSTREAM_TEST_EXPORTS, UPSTREAM_TEST_SHIM, compileAndRunUpstreamModule } from "./upstream-suite-runner.mjs";

describe("upstream suite runner", () => {
  it("awaits async callbacks without classifying them as unavailable infrastructure", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
QUnit.test("synchronous callback", function () {
  expect(1).toBe(1);
});
QUnit.test("async callback", async function () {
  await Promise.resolve();
  expect(2).toBe(2);
});
${UPSTREAM_TEST_EXPORTS}`;

    try {
      const previousNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = [previousNodeOptions, "--import=tsx"].filter(Boolean).join(" ");
      let result;
      try {
        result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 60_000 });
      } finally {
        if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousNodeOptions;
      }
      expect(result.native.statuses).toEqual([true, true]);
      expect(result.native.errors).toEqual(["", ""]);
      expect(result.wasm?.statuses).toEqual([true, true]);
      expect(result.wasm?.errors).toEqual(["", ""]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
