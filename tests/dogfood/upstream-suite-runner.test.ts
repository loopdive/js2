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
  createHarnessLogger,
  runUpstreamFile,
  summarizeUpstreamRuns,
  unmeasuredFilesLine,
  unmeasuredUpstreamReason,
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

  it("matches Jest deep equality for arrays, sets, maps, and array-like iterables", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
test("collection equality", () => {
  const iterable = { 0: "a", 1: "b", length: 2, [Symbol.iterator]: Array.prototype[Symbol.iterator] };
  expect(iterable).toEqual({ 0: "a", 1: "b", length: 2, [Symbol.iterator]: Array.prototype[Symbol.iterator] });
  expect(iterable).not.toEqual(["a", "b"]);
  expect(new Set([1, 2])).toEqual(new Set([2, 1]));
  expect(new Set([1, 2])).not.toEqual(new Set([1, 3]));
  expect(new Map([["a", 1]])).toEqual(new Map([["a", 1]]));
  expect(new Map([["a", 1]])).not.toEqual(new Map([["a", 2]]));
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
      // The upstream inventory records any Wasm collection mismatch as a
      // compatibility result; this regression protects the shared matcher and
      // native oracle without turning that compiler/runtime finding into an
      // infrastructure gate.
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

  it("supports deterministic Jest fake timers without replacing the harness clock", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
jest.useFakeTimers().setSystemTime(100);
test("fake timer", () => {
  let fired = 0;
  setTimeout(() => { fired += 1; }, 1000);
  expect(fired).toBe(0);
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(999);
  expect(fired).toBe(0);
  jest.advanceTimersByTime(1);
  expect(fired).toBe(1);
  expect(setTimeout).toHaveBeenCalled();
  setTimeout(() => { fired += 1; }, 2000);
  expect(jest.getTimerCount()).toBe(1);
  jest.clearAllTimers();
  expect(jest.getTimerCount()).toBe(0);
  expect(jest.now()).toBe(1100);
  expect(jest.getRealSystemTime() > 0).toBe(true);
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
      expect(result.wasm?.errors).toEqual([""]);
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
  expect(() => { throw new Error("different message"); }).not.toThrow("expected message");
  expect(() => {}).not.toThrow("expected message");
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

  it("supports string Vitest inline snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `${UPSTREAM_TEST_SHIM}
QUnit.test("inline snapshot", function () {
  expect("A-d").toMatchInlineSnapshot(\`"A-d"\`);
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

  it("supplies filesystem and secondary Node namespaces to opted-in suites", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-runner-"));
    const generatedPath = join(root, "suite.ts");
    const source = `
import { readFileSync } from "node:fs";
import * as os from "node:os";
export function upstreamTestCount() { return 1; }
export function upstreamTestNames() { return ["fs call"] as any; }
export function upstreamTestErrors() { return [""] as any; }
export function runUpstreamTest() {
  return readFileSync(${JSON.stringify(generatedPath)}, "utf8").length > 0 && os !== undefined ? 1 : 0;
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
      pin: {
        repo: "https://example.test/fixture",
        tag: "v1",
        commit: "abc",
        registrationSites: 5,
        selectedRegistrationSites: 2,
      },
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

// Regression coverage for #5326. Upstream test bodies execute in the harness
// process, so a suite that stubs a global keeps it stubbed after the file ends.
// Hono's `showRoutes()` describe swaps `console.log` for a collector in
// `beforeAll` and restores it in `afterAll`, but the shim only runs a test's
// `afterAll` hooks when that test is the module's LAST registered test — and
// hono's last test lives in a different describe. The collector therefore
// outlived the file and swallowed every subsequent `[dogfood]` line, including
// the headline. The suite ran all 20 files and wrote a complete report; only
// the terminal went dark after file 4, which is how a 4-file view of a 20-file
// suite got quoted as hono's score.
describe("upstream suite runner — harness output survives the code it measures", () => {
  it("restores a console the guest module stubbed and never put back", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-console-"));
    const generatedPath = join(root, "suite.ts");
    // Same shape as hono/src/helper/dev/index.test.ts: the stubbing describe is
    // NOT the one holding the module's last test, so its afterAll is
    // unreachable through the shim's last-test-only afterAll dispatch.
    const source = `${UPSTREAM_TEST_SHIM}
describe("stubs console and cannot restore it", () => {
  let captured: string[] = [];
  let originalLog: typeof console.log;
  beforeAll(() => {
    originalLog = console.log;
    console.log = (...args) => captured.push(String(args[0]));
  });
  afterAll(() => {
    console.log = originalLog;
  });
  it("captures its own output", () => {
    console.log("swallowed");
    expect(captured.length).toBe(1);
  });
});
describe("a later describe owns the final test", () => {
  it("runs last", () => {
    expect(1).toBe(1);
  });
});
${UPSTREAM_TEST_EXPORTS}`;

    const hostLog = console.log;
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
      // Both tests must genuinely have run — otherwise this asserts nothing.
      expect(result.native.statuses).toEqual([true, true]);
      // The actual regression: before the fix `console.log` was still the
      // guest's collector here, and every later harness line vanished.
      expect(console.log).toBe(hostLog);
    } finally {
      console.log = hostLog;
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("logs through the write path captured at import time, not the live console", () => {
    const intercepted: string[] = [];
    const hostWrite = process.stdout.write;
    const hostLog = console.log;
    const log = createHarnessLogger({ quiet: false });
    let threw: unknown = null;
    try {
      // Two hijacks a guest could plausibly install after the logger was built.
      console.log = () => {
        throw new Error("harness logged through the mutable console global");
      };
      (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
        intercepted.push(chunk);
        return true;
      };
      log("[dogfood] harness line the guest must not be able to capture");
    } catch (error) {
      threw = error;
    } finally {
      (process.stdout as unknown as { write: typeof hostWrite }).write = hostWrite;
      console.log = hostLog;
    }
    // Neither hijack saw the line: the console stub never ran (no throw) and
    // the stdout stub collected nothing, because the write path was resolved
    // once at import time.
    expect(threw).toBeNull();
    expect(intercepted).toEqual([]);
  });

  it("quiet mode suppresses output without touching the console global", () => {
    const hostLog = console.log;
    let threw: unknown = null;
    try {
      console.log = () => {
        throw new Error("quiet logger wrote");
      };
      createHarnessLogger({ quiet: true })("[dogfood] nothing");
    } catch (error) {
      threw = error;
    } finally {
      console.log = hostLog;
    }
    expect(threw).toBeNull();
  });
});

describe("upstream suite runner — a file that produces nothing is recorded, not skipped", () => {
  it("bounds an in-process file that never settles instead of draining the event loop", async () => {
    const run = await runUpstreamFile("wedged.test.ts", () => new Promise(() => {}), { timeoutMs: 200 });
    expect(run.file).toBe("wedged.test.ts");
    expect(run.result.harnessError).toMatch(/watchdog/);
    expect(run.result.native.count).toBe(0);
    expect(unmeasuredUpstreamReason(run)).toMatch(/watchdog/);
  });

  it("records a throwing file and keeps the loop going", async () => {
    const run = await runUpstreamFile("boom.test.ts", async () => {
      throw new Error("compile blew up");
    });
    expect(run.result.harnessError).toContain("compile blew up");
    expect(unmeasuredUpstreamReason(run)).toContain("compile blew up");
  });

  it("treats a selected file that registers zero tests as unmeasured", () => {
    expect(
      unmeasuredUpstreamReason({
        file: "empty.test.ts",
        result: { native: { count: 0, names: [], statuses: [], errors: [] }, compile: null, wasm: null },
      }),
    ).toBe("no upstream tests registered");
    expect(
      unmeasuredUpstreamReason({
        file: "ok.test.ts",
        result: { native: { count: 1, names: ["a"], statuses: [true], errors: [""] }, compile: null, wasm: null },
      }),
    ).toBeNull();
  });

  it("counts unmeasured files in the summary and names them in the report line", () => {
    const report = summarizeUpstreamRuns({
      name: "fixture",
      pin: { repo: "https://example.test/fixture", tag: "v1", commit: "abc", registrationSites: 4 },
      testFiles: ["a.test.ts", "b.test.ts"],
      selectedFiles: ["a.test.ts", "b.test.ts"],
      runs: [
        {
          file: "a.test.ts",
          result: {
            native: { count: 2, names: ["one", "two"], statuses: [true, true], errors: ["", ""] },
            compile: { success: true, validates: true, durationMs: 1, binaryBytes: 2 },
            wasm: { statuses: [true, false], errors: ["", "mismatch"] },
          },
        },
        {
          file: "b.test.ts",
          result: {
            native: { fatal: "boom", count: 0, names: [], statuses: [], errors: [] },
            compile: null,
            wasm: null,
            harnessError: "harness watchdog: no result after 600000ms",
          },
        },
      ],
    });
    expect(report.extraction.filesWithoutResult).toBe(1);
    expect(report.summary.filesWithoutResult).toBe(1);
    expect(report.summary.selectedFilesRun).toBe(2);
    expect(report.extraction.filesWithoutResultDetail).toEqual([
      { file: "b.test.ts", reason: "harness watchdog: no result after 600000ms" },
    ]);
    // The headline denominator only covers the files that produced a result,
    // so it must never be read without this line beside it.
    expect(report.summary.headline).toBe("1/2 admitted original tests pass in Wasm");
    expect(unmeasuredFilesLine(report)).toBe(
      "[dogfood] 1 of 2 selected files produced NO result: b.test.ts (harness watchdog: no result after 600000ms)",
    );
  });

  it("states the all-clear explicitly when every selected file produced a result", () => {
    const report = summarizeUpstreamRuns({
      name: "fixture",
      pin: { repo: "https://example.test/fixture", tag: "v1", commit: "abc", registrationSites: 1 },
      testFiles: ["a.test.ts"],
      selectedFiles: ["a.test.ts"],
      runs: [
        {
          file: "a.test.ts",
          result: {
            native: { count: 1, names: ["one"], statuses: [true], errors: [""] },
            compile: { success: true, validates: true, durationMs: 1, binaryBytes: 2 },
            wasm: { statuses: [true], errors: [""] },
          },
        },
      ],
    });
    expect(report.summary.filesWithoutResult).toBe(0);
    expect(unmeasuredFilesLine(report)).toBe("[dogfood] 1 of 1 selected files produced a result");
  });
});
