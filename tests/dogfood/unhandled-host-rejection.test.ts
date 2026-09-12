import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood runner has no declaration file
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
} from "./upstream-suite-runner.mjs";
// @ts-expect-error — .mjs dogfood helper has no declaration file
import { attributeRejections, moduleRejectionText } from "./upstream-unhandled-rejections.mjs";

const REASON = "js2wasm-5369 unobserved host rejection";

/**
 * A host-realm promise that rejects with nobody observing it.
 *
 * `new Promise(executor)` lowers to the `Promise_new` host import, which —
 * unlike `Promise_reject` (#2978 pre-marks its result handled) — hands back a
 * promise Node will report as unhandled. That is the reduced shape of hono's
 * `crypto.subtle.importKey` rejection in #5362: a host API's promise dropped
 * on the floor inside one test.
 */
const LEAK_HELPER = `
function leakHostRejection(reason) {
  return new Promise(function (resolve, reject) { reject(reason); });
}
`;

function suiteSource({ inTest = "", topLevel = "" } = {}) {
  return `${UPSTREAM_TEST_SHIM}
${LEAK_HELPER}
${topLevel}
it("first test", function () {
  ${inTest}
  expect(1).toBe(1);
});
it("second test", async function () {
  // A real host timer, not a resolved promise. The whole point is that this
  // test hands the event loop back: that is when Node reports test 1's leaked
  // rejection, and on the parent harness that is when the worker dies. A
  // module whose tests are all synchronous races to \`process.exit\` first and
  // never reproduces the cliff.
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  expect(2).toBe(2);
});
it("third test", function () {
  expect(3).toBe(3);
});
${UPSTREAM_TEST_EXPORTS}`;
}

/**
 * Vitest's own `unhandledRejection` listeners, captured before the harness runs.
 *
 * The native oracle lane executes in THIS process, so a rejection it leaks on
 * purpose is also seen by Vitest, which reports it as an unhandled error and
 * fails the file for the very behaviour under test. These are detached for the
 * duration of each harness call and put back afterwards. The list is captured
 * once, at module scope: the harness installs a listener of its own on first
 * use, and re-reading `process.listeners` per call would detach that one too,
 * leaving Node with no observer at all.
 */
const HOST_REJECTION_LISTENERS = process.listeners("unhandledRejection");

/** Run one generated module through the real harness. */
async function runHarness(source: string, nativeSource = source) {
  const root = mkdtempSync(join(tmpdir(), "js2-5369-"));
  const generatedPath = join(root, "suite.ts");
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = [previousNodeOptions, "--import=tsx"].filter(Boolean).join(" ");
  for (const listener of HOST_REJECTION_LISTENERS) process.off("unhandledRejection", listener);
  try {
    return await compileAndRunUpstreamModule({ generatedPath, source, nativeSource, timeoutMs: 120_000 });
  } finally {
    for (const listener of HOST_REJECTION_LISTENERS) process.on("unhandledRejection", listener);
    // biome-ignore lint/performance/noDelete: `process.env.X = undefined` sets the string "undefined"
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("unhandled rejection attribution (#5369)", () => {
  it("fails a passing test and carries the reason", () => {
    expect(attributeRejections({ reasons: ["boom"], passed: true, error: "" })).toEqual({
      passed: false,
      error: "unhandled rejection: boom",
    });
  });

  it("leaves an already-failed test's own reason alone", () => {
    // #5823's async-resume guard rejects the frame's own promise on an
    // uncatchable trap, so that failure already reached the test's error
    // channel. Overwriting it here would report one defect twice.
    expect(attributeRejections({ reasons: ["boom"], passed: false, error: "illegal cast" })).toEqual({
      passed: false,
      error: "illegal cast",
    });
  });

  it("marks an attribution made after the test settled", () => {
    expect(attributeRejections({ reasons: ["boom"], passed: true, error: "", late: true }).error).toBe(
      "unhandled rejection (late): boom",
    );
  });

  it("reports nothing when nothing rejected", () => {
    expect(attributeRejections({ reasons: [], passed: true, error: "" })).toEqual({ passed: true, error: "" });
    expect(moduleRejectionText([])).toBeNull();
    expect(moduleRejectionText(undefined)).toBeNull();
  });
});

describe("unhandled host rejections (#5369)", () => {
  it("scores a control module with no rejection 3/3 in both lanes", async () => {
    const result = await runHarness(suiteSource());
    expect(result.native.statuses).toEqual([true, true, true]);
    expect(result.wasm?.statuses).toEqual([true, true, true]);
    expect(result.wasm?.errors).toEqual(["", "", ""]);
  }, 180_000);

  it("attributes a Wasm-lane-only rejection to test 1 and keeps the file at 2/3", async () => {
    // The native oracle observes its own rejection, so this is the #5362 shape
    // exactly: the leak exists only on the compiled lane, the test stays
    // admitted, and the file must read 2 of 3 rather than 0 of 3.
    const result = await runHarness(
      suiteSource({ inTest: `leakHostRejection(${JSON.stringify(REASON)});` }),
      suiteSource({ inTest: `leakHostRejection(${JSON.stringify(REASON)}).catch(function () {});` }),
    );
    // On the parent harness this reads `compile.success: false`, `wasm: null`
    // and a 0/3 headline — the whole file zeroed by one rejection.
    expect(result.compile?.success).toBe(true);
    expect(result.native.statuses).toEqual([true, true, true]);
    expect(result.wasm?.statuses).toEqual([false, true, true]);
    expect(result.wasm?.errors?.[0]).toContain("unhandled rejection");
    expect(result.wasm?.errors?.[0]).toContain(REASON);
    expect(result.wasm?.errors?.slice(1)).toEqual(["", ""]);
    expect(result.wasm?.fatal).toBeUndefined();

    const report = summarizeUpstreamRuns({
      name: "probe",
      pin: { repo: "probe", tag: "probe", commit: "probe", registrationSites: 3 },
      testFiles: ["suite.ts"],
      selectedFiles: ["suite.ts"],
      runs: [{ file: "suite.ts", result }],
    });
    expect(report.summary.headline).toBe("2/3 admitted original tests pass in Wasm");
    expect(report.results.tests[0].status).toBe("failed");
    expect(report.results.tests[0].wasmError).toContain(REASON);
  }, 180_000);

  it("attributes the same rejection on the native lane when both lanes leak it", async () => {
    const result = await runHarness(suiteSource({ inTest: `leakHostRejection(${JSON.stringify(REASON)});` }));
    expect(result.native.statuses).toEqual([false, true, true]);
    expect(result.native.errors?.[0]).toContain(REASON);
    expect(result.wasm?.statuses).toEqual([false, true, true]);
    expect(result.wasm?.errors?.[0]).toContain(REASON);
  }, 180_000);

  it("records a rejection outside any test on the module and still runs every test", async () => {
    const result = await runHarness(suiteSource({ topLevel: `leakHostRejection(${JSON.stringify(REASON)});` }));
    expect(result.wasm?.statuses).toEqual([true, true, true]);
    expect(result.wasm?.fatal).toBeUndefined();

    const report = summarizeUpstreamRuns({
      name: "probe",
      pin: { repo: "probe", tag: "probe", commit: "probe", registrationSites: 3 },
      testFiles: ["suite.ts"],
      selectedFiles: ["suite.ts"],
      runs: [{ file: "suite.ts", result }],
    });
    expect(report.compile.details[0].runtimeError).toContain("unhandled rejection");
    expect(report.compile.details[0].runtimeError).toContain(REASON);
    expect(report.summary.headline).toBe("3/3 admitted original tests pass in Wasm");
  }, 180_000);
});
