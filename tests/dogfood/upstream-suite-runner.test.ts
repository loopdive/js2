import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood runner has no declaration file
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  UPSTREAM_TEST_SHIM_NODE,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
} from "./upstream-suite-runner.mjs";

describe("upstream suite runner", () => {
  it("provides a Node shim without a late-initialized global alias", () => {
    expect(UPSTREAM_TEST_SHIM).toContain("var global = globalThis;");
    expect(UPSTREAM_TEST_SHIM_NODE).not.toContain("var global = globalThis;");
  });

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
  expectTypeOf(() => {}).toBeFunction();
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

  it("supports suite lifecycle hooks and the spy helpers used by upstream Web API tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
let setupCount = 0;
let teardownCount = 0;
describe("lifecycle", () => {
  beforeAll(() => { setupCount += 1; });
  afterEach(() => { teardownCount += 1; });
  afterAll(() => { setupCount += 1; });
  test("runs beforeAll once and supports spyOn", () => {
    expect(setupCount).toBe(1);
    const spy = { mock: { calls: [[]] } };
    expect(spy).toHaveBeenCalledOnce();
    expect(typeof vi.spyOn).toBe("function");
    expect(typeof jest.spyOn).toBe("function");
  });
  test("retains the lifecycle state for the next test", () => {
    expect(setupCount).toBe(1);
    expect(teardownCount).toBe(1);
  });
  test("runs afterEach after an async callback", async () => {
    expect(teardownCount).toBe(2);
    await Promise.resolve();
  });
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
      expect(result.compile.success).toBe(true);
      expect(result.compile.validates).toBe(true);
      expect(result.wasm?.statuses).toEqual([true, true, true]);
      expect(result.wasm?.errors).toEqual(["", "", ""]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("supports Vitest instanceOf and spy matcher aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
const ErrorCtor = Error;
const called = { mock: { calls: [["value"]] } };
QUnit.test("matcher aliases", function () {
  expect(new Error("ok")).instanceOf(ErrorCtor);
  expect(new Error("ok")).toBeInstanceOf(ErrorCtor);
  expect(called).toBeCalled();
  expect(called).toHaveBeenCalled();
  expect(called).toBeCalledWith("value");
  expect(called).toHaveBeenCalledWith("value");
  expect("plain").not.instanceOf(ErrorCtor);
  expect("plain").not.toBeInstanceOf(ErrorCtor);
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
      expect(result.native.statuses).toEqual([true]);
      expect(result.native.errors).toEqual([""]);
      expect(result.compile.success).toBe(true);
      expect(result.compile.validates).toBe(true);
      expect(result.wasm?.statuses).toEqual([true]);
      expect(result.wasm?.errors).toEqual([""]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("keeps upstream skip and todo registrations out of the runnable denominator", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
describe.skip("skipped group", () => {
  test("never registers", () => { throw new Error("must not run"); });
});
it.skip("skipped test", () => { throw new Error("must not run"); });
test.todo("future test");
QUnit.test("runnable test", function () { expect(1).toBe(1); });
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
      expect(result.native.count).toBe(1);
      expect(result.native.names).toEqual(["runnable test"]);
      expect(result.native.statuses).toEqual([true]);
      expect(result.compile.success).toBe(true);
      expect(result.compile.validates).toBe(true);
      expect(result.wasm?.count).toBe(1);
      expect(result.wasm?.statuses).toEqual([true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("supports Vitest global stubs and restores globals", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
QUnit.test("global stub", function () {
  const key = "__js2_upstream_runner_global_stub";
  expect(typeof vi.stubGlobal).toBe("function");
  vi.stubGlobal(key, 42);
  expect(globalThis[key]).toBe(42);
  vi.unstubAllGlobals();
  expect(globalThis[key]).toBeUndefined();
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
      expect(result.native.statuses).toEqual([true]);
      expect(result.native.errors).toEqual([""]);
      expect(result.compile?.success).toBe(true);
      expect(result.compile?.validates).toBe(true);
      expect(result.wasm?.statuses).toEqual([true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("restores Vitest environment stubs", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
QUnit.test("restores environment stubs when a process environment is available", function () {
  const processValue = globalThis.process;
  expect(typeof vi.stubEnv).toBe("function");
  expect(typeof vi.unstubAllEnvs).toBe("function");
  if (processValue && processValue.env) {
    const key = "__JS2_UPSTREAM_RUNNER_ENV_STUB";
    const before = processValue.env[key];
    vi.stubEnv(key, "stubbed");
    expect(processValue.env[key]).toBe("stubbed");
    vi.unstubAllEnvs();
    expect(processValue.env[key]).toBe(before);
  }
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
      expect(result.native.statuses).toEqual([true]);
      expect(result.native.errors).toEqual([""]);
      expect(result.compile?.success).toBe(true);
      expect(result.compile?.validates).toBe(true);
      expect(result.wasm?.statuses).toEqual([true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("forwards a package-selected Node platform to the isolated compiler worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `
export function upstreamTestCount() { return 1; }
export function upstreamTestNames() { return ["Node global"] as any; }
export function upstreamTestErrors() { return [""] as any; }
export function runUpstreamTest(index: number) {
  return index === 0 && typeof global === "object" && global === globalThis ? 1 : 0;
}
`;

    try {
      const previousNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = [previousNodeOptions, "--import=tsx"].filter(Boolean).join(" ");
      let result;
      try {
        result = await compileAndRunUpstreamModule({
          generatedPath,
          source,
          timeoutMs: 60_000,
          workerEnv: { DOGFOOD_PLATFORM: "node" },
        });
      } finally {
        // biome-ignore lint/performance/noDelete: `process.env.X = undefined` sets the string "undefined" instead of unsetting the var
        if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousNodeOptions;
      }
      expect(result.native.statuses).toEqual([true]);
      expect(result.compile?.success).toBe(true);
      expect(result.compile?.validates).toBe(true);
      expect(result.wasm?.statuses).toEqual([true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("supplies real Node builtin namespaces when a web suite opts into host dependencies", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `
import { AsyncLocalStorage } from "node:async_hooks";
const storage = new AsyncLocalStorage();
export function upstreamTestCount() { return 1; }
export function upstreamTestNames() { return ["Node host dependency"] as any; }
export function upstreamTestErrors() { return [""] as any; }
export function runUpstreamTest() { return storage ? 1 : 0; }
`;

    try {
      const previousNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = [previousNodeOptions, "--import=tsx"].filter(Boolean).join(" ");
      let result;
      try {
        result = await compileAndRunUpstreamModule({
          generatedPath,
          source,
          timeoutMs: 60_000,
          workerEnv: { DOGFOOD_NODE_HOST_DEPS: "1" },
        });
      } finally {
        // biome-ignore lint/performance/noDelete: `process.env.X = undefined` sets the string "undefined" instead of unsetting the var
        if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousNodeOptions;
      }
      expect(result.native.statuses).toEqual([true]);
      expect(result.compile?.success).toBe(true);
      expect(result.compile?.validates).toBe(true);
      expect(result.wasm?.statuses).toEqual([true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("reports deferred upstream registrations as unavailable infrastructure", () => {
    const report = summarizeUpstreamRuns({
      name: "fixture",
      pin: { repo: "https://example.test/fixture", tag: "v1", commit: "abc", registrationSites: 5 },
      testFiles: ["a.test.ts", "b.test.ts"],
      selectedFiles: ["a.test.ts"],
      runs: [
        {
          file: "a.test.ts",
          result: {
            native: { count: 2, names: ["one", "two"], statuses: [true, true], errors: ["", ""] },
            compile: { success: true, validates: true, durationMs: 1, binaryBytes: 2 },
            wasm: { statuses: [true, false], errors: ["", "mismatch"] },
          },
        },
      ],
    });
    expect(report.extraction.deferredRegistrations).toBe(3);
    expect(report.extraction.unavailableInfra).toBe(3);
    expect(report.summary.unavailableInfra).toBe(3);
    expect(report.results.passed).toBe(1);
    expect(report.results.failed).toBe(1);
  });
});
