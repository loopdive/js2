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
import { attributeRejections, createUnhandledRejectionSink } from "./upstream-unhandled-rejections.mjs";

const REASON = "js2wasm-6424 stray host timer throw";

/**
 * A host throw from outside every awaited test body.
 *
 * `setTimeout` lowers to the host timer import, so the compiled closure is
 * invoked by Node's timers phase and its exception escapes through
 * `normalizeModuleCallbackException` as an `uncaughtException` — the sibling of
 * #5369's unobserved rejection, reached by a different door. Before #6424 the
 * Wasm worker had no listener for it: Node killed the worker, the parent found
 * no JSON on stdout, and every test of the file read failed with a null error.
 */
const THROW_FROM_HOST_TIMER = `setTimeout(function () { throw new Error(${JSON.stringify(REASON)}); }, 0);`;

/**
 * Test 1 is `async` on purpose, and that is a correctness constraint.
 *
 * A 0 ms timer scheduled by a SYNCHRONOUS test is not guaranteed to have fired
 * by the time the loop's drain yields its `setImmediate` turn — the timers
 * phase only runs a timer once its (1 ms-floored) threshold has elapsed. Such a
 * fixture would attribute to test 1 or test 2 depending on machine speed.
 * Awaiting a 5 ms timer inside test 1 puts the throw unambiguously inside
 * test 1's own window.
 */
function suiteSource({ inTest = "" } = {}) {
  return `${UPSTREAM_TEST_SHIM}
it("first test", async function () {
  ${inTest}
  await new Promise(function (resolve) { setTimeout(resolve, 5); });
  expect(1).toBe(1);
});
it("second test", async function () {
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  expect(2).toBe(2);
});
it("third test", function () {
  expect(3).toBe(3);
});
${UPSTREAM_TEST_EXPORTS}`;
}

/**
 * Vitest's own `uncaughtException` / `unhandledRejection` listeners.
 *
 * The native oracle lane executes in THIS process, so a host throw it is meant
 * to record is also seen by Vitest, which reports it as an unhandled error and
 * fails the file for the very behaviour under test. They are detached for the
 * duration of each harness call and put back afterwards. Captured once at
 * module scope: the runner installs its own late-error boundary on first use,
 * and re-reading `process.listeners` per call would detach that one too,
 * leaving the throw with no observer at all.
 */
const HOST_UNCAUGHT_LISTENERS = process.listeners("uncaughtException");
const HOST_REJECTION_LISTENERS = process.listeners("unhandledRejection");

function detachHostListeners() {
  for (const listener of HOST_UNCAUGHT_LISTENERS) process.off("uncaughtException", listener);
  for (const listener of HOST_REJECTION_LISTENERS) process.off("unhandledRejection", listener);
}

function attachHostListeners() {
  for (const listener of HOST_UNCAUGHT_LISTENERS) process.on("uncaughtException", listener);
  for (const listener of HOST_REJECTION_LISTENERS) process.on("unhandledRejection", listener);
}

/** Run one generated module through the real harness. */
async function runHarness(source: string, nativeSource = source) {
  const root = mkdtempSync(join(tmpdir(), "js2-6424-"));
  const generatedPath = join(root, "suite.ts");
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = [previousNodeOptions, "--import=tsx"].filter(Boolean).join(" ");
  detachHostListeners();
  try {
    return await compileAndRunUpstreamModule({
      generatedPath,
      source,
      nativeSource,
      timeoutMs: 120_000,
    });
  } finally {
    attachHostListeners();
    // biome-ignore lint/performance/noDelete: `process.env.X = undefined` sets the string "undefined"
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("uncaught host exception sink (#6424)", () => {
  it("labels a folded reason as its own channel, not as a rejection", () => {
    expect(
      attributeRejections({
        reasons: ["boom"],
        passed: true,
        error: "",
        kind: "uncaught host exception",
      }),
    ).toEqual({ passed: false, error: "uncaught host exception: boom" });
    expect(
      attributeRejections({
        reasons: ["boom"],
        passed: true,
        error: "",
        late: true,
        kind: "uncaught host exception",
      }).error,
    ).toBe("uncaught host exception (late): boom");
  });

  it("captures nothing until it is armed, and stops again when disarmed", async () => {
    const sink = createUnhandledRejectionSink({
      label: "test",
      stream: { write: () => true },
    });
    expect(await sink.drainUncaught()).toEqual([]);

    detachHostListeners();
    try {
      // Counted inside the detached window: Vitest's own listeners are off, so
      // an unarmed sink must leave the count exactly where it found it.
      const baseline = process.listenerCount("uncaughtException");
      const disarm = sink.armUncaughtExceptions();
      expect(process.listenerCount("uncaughtException")).toBe(baseline + 1);
      setTimeout(() => {
        throw new Error(REASON);
      }, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await sink.drainUncaught()).toEqual([`Error: ${REASON}`]);
      disarm();
      expect(process.listenerCount("uncaughtException")).toBe(baseline);
      disarm();
      expect(process.listenerCount("uncaughtException")).toBe(baseline);
    } finally {
      sink.dispose();
      attachHostListeners();
    }
  });
});

describe("uncaught host exceptions in the Wasm worker (#6424)", () => {
  it("scores a control module with no stray throw 3/3 in both lanes", async () => {
    const result = await runHarness(suiteSource());
    expect(result.native.statuses).toEqual([true, true, true]);
    expect(result.wasm?.statuses).toEqual([true, true, true]);
    expect(result.wasm?.errors).toEqual(["", "", ""]);
    expect(result.native.lateHostErrors).toEqual([]);
  }, 180_000);

  it("attributes a Wasm-lane-only host throw to test 1 and keeps the file at 2/3", async () => {
    const result = await runHarness(suiteSource({ inTest: THROW_FROM_HOST_TIMER }), suiteSource());
    // On the parent harness this reads `compile.success: false`, `wasm: null`
    // and a 0/3 headline — the whole file zeroed by one stray timer.
    expect(result.compile?.success).toBe(true);
    expect(result.native.statuses).toEqual([true, true, true]);
    expect(result.wasm?.statuses).toEqual([false, true, true]);
    expect(result.wasm?.errors?.[0]).toContain("uncaught host exception");
    expect(result.wasm?.errors?.[0]).toContain(REASON);
    expect(result.wasm?.errors?.slice(1)).toEqual(["", ""]);
    expect(result.wasm?.fatal).toBeUndefined();
    // The rejection channel keeps meaning only what its name says.
    expect(result.wasm?.unhandledRejections).toEqual([]);

    const report = summarizeUpstreamRuns({
      name: "probe",
      pin: {
        repo: "probe",
        tag: "probe",
        commit: "probe",
        registrationSites: 3,
      },
      testFiles: ["suite.ts"],
      selectedFiles: ["suite.ts"],
      runs: [{ file: "suite.ts", result }],
    });
    expect(report.summary.headline).toBe("2/3 admitted original tests pass in Wasm");
    expect(report.results.tests[0].status).toBe("failed");
    expect(report.results.tests[0].wasmError).toContain(REASON);
  }, 180_000);

  it("keeps the native lane's file-level policy when both lanes throw", async () => {
    // The native oracle records late host errors per FILE rather than per test
    // (#4604 S7) — unchanged here. The point of the assertion is that the lane
    // difference stays visible: native still scores 3/3 and notes the throw,
    // the compiled lane pins it on the test that scheduled it.
    const result = await runHarness(suiteSource({ inTest: THROW_FROM_HOST_TIMER }));
    expect(result.native.statuses).toEqual([true, true, true]);
    expect(result.native.lateHostErrors?.map((entry: { message: string }) => entry.message)).toContain(REASON);
    expect(result.wasm?.statuses).toEqual([false, true, true]);
    expect(result.wasm?.errors?.[0]).toContain(REASON);
  }, 180_000);
});
