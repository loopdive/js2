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
QUnit.test("provides the Node-compatible global alias", function () {
  expect(global).toBe(globalThis);
});
${UPSTREAM_TEST_EXPORTS}`;

    try {
      const previousNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = [previousNodeOptions, "--import=tsx"].filter(Boolean).join(" ");
      let result;
      try {
        result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 60_000 });
      } finally {
        // biome-ignore lint/performance/noDelete: `process.env.X = undefined` sets the string "undefined" instead of unsetting the var
        if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousNodeOptions;
      }
      expect(result.native.statuses).toEqual([true, true, true]);
      expect(result.native.errors).toEqual(["", "", ""]);
      expect(result.wasm?.statuses).toEqual([true, true, true]);
      expect(result.wasm?.errors).toEqual(["", "", ""]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("supports Vitest tables, promise matchers, and type-only assertions", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
describe.each([
  ["alpha", 1],
  ["beta", 2],
])("row %s", (name, value) => {
  test("value", () => {
    expect(name).toBe(name);
    expect(value).toBe(value);
  });
});
test.each\`
  input | expected
  \${"left"} | \${"right"}
\`("table $input -> $expected", ({ input, expected }) => {
  expect(input).toBe("left");
  expect(expected).toBe("right");
});
QUnit.test("promise and type assertions", async function () {
  await expect(Promise.resolve("ok")).resolves.toBe("ok");
  await expect(Promise.reject(new Error("expected"))).rejects.toThrow("expected");
  expectTypeOf("compile-time only").toEqualTypeOf();
});
${UPSTREAM_TEST_EXPORTS}`;

    try {
      const previousNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = [previousNodeOptions, "--import=tsx"].filter(Boolean).join(" ");
      let result;
      try {
        result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 60_000 });
      } finally {
        // biome-ignore lint/performance/noDelete: `process.env.X = undefined` sets the string "undefined" instead of unsetting the var
        if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousNodeOptions;
      }
      expect(result.native.statuses).toEqual([true, true, true, true]);
      expect(result.native.errors).toEqual(["", "", "", ""]);
      // The shim itself must remain compilable even when the synthetic table
      // and type-only callbacks hit unrelated Wasm semantic/runtime defects.
      expect(result.compile.success).toBe(true);
      expect(result.compile.validates).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
