import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood runner has no declaration file
import { UPSTREAM_TEST_EXPORTS, UPSTREAM_TEST_SHIM, compileAndRunUpstreamModule } from "./upstream-suite-runner.mjs";
import { compile } from "../../src/index.ts";
import {
  STANDALONE_COMPILE_OVERRIDES,
  UPSTREAM_TARGET_ENV,
  UPSTREAM_TEST_STANDALONE_EXPORTS,
  runStandaloneUpstreamTestsIsolated,
  upstreamTarget,
  // @ts-expect-error — .mjs dogfood lane has no declaration file
} from "./upstream-standalone-lane.mjs";

// (#7013) The standalone lane must run the SAME generated suite module with
// `target: "standalone"`, zero imports, and the assertion harness compiled in.
// Each case below is built so a lane that silently fell back to the JS host,
// or that reported every test as passing, would fail an assertion.
const CORE_TESTS = `test("sync pass", () => {
  expect(1 + 1).toBe(2);
});
test("sync fail keeps its message", () => {
  expect([1, 2]).toEqual([1, 3]);
});
test("async pass settles through the native job queue", async () => {
  const value = await Promise.resolve(21);
  expect(value * 2).toBe(42);
});
test("async rejection fails", async () => {
  await Promise.resolve();
  throw new Error("standalone-async-boom");
});
QUnit.test("qunit assert is compiled in", function (qunit) {
  qunit.strictEqual("a" + "b", "ab");
});`;
const CORE_EXPECTED = [true, false, true, false, true];

// Node's `assert` is an assertion harness too: the standalone lane resolves it
// to the compiled-in standalone-node-assert.js instead of a host module.
const SUITE = `import assert from "node:assert";
${UPSTREAM_TEST_SHIM}
${CORE_TESTS}
test("node:assert resolves to the compiled-in shim", () => {
  assert.strictEqual(2 * 3, 6);
  assert.ok("non-empty");
});
test("node:assert failure still fails", () => {
  assert.strictEqual(1, 2);
});
${UPSTREAM_TEST_EXPORTS}`;
const EXPECTED = [...CORE_EXPECTED, true, false];

const HOST_SUITE = `${UPSTREAM_TEST_SHIM}
${CORE_TESTS}
${UPSTREAM_TEST_EXPORTS}`;

// A worker timeout or crash leaves compile/wasm partial; name it in the failure.
function describeResult(result: unknown): string {
  return JSON.stringify(result).slice(0, 1500);
}

async function runLane(target: "standalone" | undefined, source: string) {
  const root = mkdtempSync(join(tmpdir(), "js2-upstream-standalone-"));
  const generatedPath = join(root, "suite.ts");
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const previousTarget = process.env[UPSTREAM_TARGET_ENV];
  process.env.NODE_OPTIONS = [previousNodeOptions, "--import=tsx"].filter(Boolean).join(" ");
  if (target) process.env[UPSTREAM_TARGET_ENV] = target;
  // biome-ignore lint/performance/noDelete: `process.env.X = undefined` stores the string "undefined"
  else delete process.env[UPSTREAM_TARGET_ENV];
  try {
    const result = await compileAndRunUpstreamModule({ generatedPath, source, timeoutMs: 400_000 });
    return { result, written: readFileSync(generatedPath, "utf8") };
  } finally {
    // biome-ignore lint/performance/noDelete: see above
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    // biome-ignore lint/performance/noDelete: see above
    if (previousTarget === undefined) delete process.env[UPSTREAM_TARGET_ENV];
    else process.env[UPSTREAM_TARGET_ENV] = previousTarget;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#7013 standalone upstream unit lane", () => {
  it("selects the lane only from an explicit opt-in", () => {
    expect(upstreamTarget({})).toBe("gc");
    expect(upstreamTarget({ [UPSTREAM_TARGET_ENV]: "standalone" })).toBe("standalone");
    expect(() => upstreamTarget({ [UPSTREAM_TARGET_ENV]: "wasi" })).toThrow(/must be/);
  });

  it("runs the suite in a zero-import standalone binary with the harness compiled in", async () => {
    const { result, written } = await runLane("standalone", SUITE);
    expect(written.endsWith(UPSTREAM_TEST_STANDALONE_EXPORTS)).toBe(true);
    expect(written).toContain("standalone-node-assert.js");
    expect(written).not.toContain('"node:assert"');
    expect(result.compile?.target, describeResult(result)).toBe("standalone");
    expect(result.compile?.hostImports).toBeUndefined();
    expect(result.wasm?.fatal).toBeUndefined();
    expect(result.native.statuses).toEqual(EXPECTED);
    // Anti-vacuity: the failing upstream tests must fail in Wasm too, with the
    // harness's own messages read back through the numeric boundary.
    expect(result.wasm?.statuses).toEqual(EXPECTED);
    expect(result.wasm?.errors[1]).toContain("toEqual mismatch");
    expect(result.wasm?.errors[3]).toContain("standalone-async-boom");
    expect(result.wasm?.errors[6]).toContain("strictly equal");
    expect(result.wasm?.names).toEqual(result.native.names);
  }, 600_000);

  it("leaves the JS-host lane's generated module byte-identical", async () => {
    const { result, written } = await runLane(undefined, HOST_SUITE);
    expect(written).toBe(HOST_SUITE);
    expect(result.compile?.target).toBeUndefined();
    expect(result.wasm?.statuses, describeResult(result)).toEqual(CORE_EXPECTED);
  }, 600_000);

  it("isolates a test that never returns and continues with the next one", async () => {
    const source = `${UPSTREAM_TEST_SHIM}
test("spins forever", () => {
  let i = 0;
  while (i >= 0) i = (i + 1) % 7;
});
test("still runs afterwards", () => {
  expect(2 + 2).toBe(4);
});
${UPSTREAM_TEST_EXPORTS}
${UPSTREAM_TEST_STANDALONE_EXPORTS}`;
    const result = await compile(source, {
      fileName: "hang.ts",
      skipSemanticDiagnostics: true,
      deferTopLevelInit: true,
      ...STANDALONE_COMPILE_OVERRIDES,
    });
    expect(result.success).toBe(true);
    const run = await runStandaloneUpstreamTestsIsolated(result, { testTimeoutMs: 5_000 });
    expect(run.statuses).toEqual([false, true]);
    expect(run.errors[0]).toContain("did not finish within 5000 ms");
    expect(run.names).toEqual(["spins forever", "still runs afterwards"]);
  }, 600_000);
});
