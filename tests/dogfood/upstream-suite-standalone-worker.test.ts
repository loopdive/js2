import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood runner has no declaration file
import { compileProjectInWorker, compileSourceInWorker } from "./upstream-suite-runner.mjs";
// @ts-expect-error — .mjs dogfood adapter has no declaration file
import { typescriptUpstreamReportSucceeded, typescriptUpstreamTarget } from "./typescript-upstream-suite.mjs";

async function withWorkerTsx<T>(run: () => Promise<T>): Promise<T> {
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = [previousNodeOptions, "--import=tsx"].filter(Boolean).join(" ");
  try {
    return await run();
  } finally {
    // biome-ignore lint/performance/noDelete: assigning undefined writes the literal string "undefined"
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
}

function passingTypescriptReport(target: "gc" | "standalone") {
  const testCounts = [1, 3, 11, 5, 5];
  const details = Array.from({ length: 5 }, (_, index) => ({
    file: `fixture-${index}.ts`,
    success: true,
    validates: true,
    requestedTarget: target,
    actualTarget: target,
    targetMatches: true,
    moduleImports: [] as Array<{ module: string; name: string; kind: string }>,
    linkedModuleImports: [],
    importPolicyMatches: true,
    nativeTestCount: testCounts[index],
    nativeStatusCount: testCounts[index],
    wasmTestCount: testCounts[index],
    wasmStatusCount: testCounts[index],
  }));
  return {
    upstreamSuite: { selectedFiles: details.map((detail) => detail.file) },
    extraction: { testsRegistered: 25, nativePassed: 25, nativeFailed: 0 },
    compile: { modules: 5, succeeded: 5, validated: 5, details },
    results: { scored: 25, passed: 25, failed: 0, runtimeFailed: 0 },
    target: {
      requestedTarget: target,
      actualTargets: [target],
      importArtifacts: details.map((detail) => ({
        file: detail.file,
        artifact: "entry",
        moduleImportCount: 0,
      })),
      moduleImportCount: 0,
      zeroImports: true,
    },
  };
}

describe("upstream suite standalone compile worker", () => {
  it("keeps TypeScript's target verdict fail-closed", () => {
    expect(typescriptUpstreamTarget(undefined)).toBe("gc");
    expect(typescriptUpstreamTarget("standalone")).toBe("standalone");
    expect(() => typescriptUpstreamTarget("wasi")).toThrow("DOGFOOD_TARGET expects gc or standalone");

    const standalone = passingTypescriptReport("standalone");
    expect(typescriptUpstreamReportSucceeded(standalone)).toBe(true);

    standalone.compile.details[0].moduleImports.push({
      module: "env",
      name: "__host_escape",
      kind: "function",
    });
    standalone.compile.details[0].importPolicyMatches = false;
    standalone.target.importArtifacts[0].moduleImportCount = 1;
    standalone.target.moduleImportCount = 1;
    standalone.target.zeroImports = false;
    expect(typescriptUpstreamReportSucceeded(standalone)).toBe(false);

    const mismatched = passingTypescriptReport("standalone");
    mismatched.compile.details[0].actualTarget = "gc";
    mismatched.compile.details[0].targetMatches = false;
    expect(typescriptUpstreamReportSucceeded(mismatched)).toBe(false);

    const countMismatch = passingTypescriptReport("standalone");
    countMismatch.compile.details[0].wasmTestCount = 2;
    expect(typescriptUpstreamReportSucceeded(countMismatch)).toBe(false);
  });

  it("uses the default GC target and rejects target names outside the explicit pair", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-target-"));
    try {
      const gc = await withWorkerTsx(() =>
        compileSourceInWorker({
          generatedPath: join(root, "gc.ts"),
          source: "export function canary(): number { return 7; }",
          timeoutMs: 180_000,
        }),
      );
      expect(gc.compile).toMatchObject({
        success: true,
        validates: true,
        requestedTarget: "gc",
        actualTarget: "gc",
        targetMatches: true,
      });
      expect(Array.isArray(gc.compile.moduleImports)).toBe(true);
      expect(gc.compile).not.toHaveProperty("irOutcomes");

      const invalid = await withWorkerTsx(() =>
        compileSourceInWorker({
          generatedPath: join(root, "invalid.ts"),
          source: "export function canary(): number { return 7; }",
          timeoutMs: 60_000,
          workerEnv: { DOGFOOD_TARGET: "wasi", JS2WASM_TYPESCRIPT_PROBE_IR_OUTCOMES: "1" },
        }),
      );
      expect(invalid.compile).toMatchObject({
        success: false,
        validates: false,
        requestedTarget: "wasi",
        actualTarget: null,
      });
      expect(invalid.compile.errors[0].message).toContain("DOGFOOD_TARGET expects gc or standalone");
      expect(invalid.compile.irOutcomes).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);

  it("instantiates standalone with an empty import object and runs only raw numeric exports", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-upstream-standalone-"));
    try {
      const result = await withWorkerTsx(() =>
        compileProjectInWorker({
          generatedRoot: root,
          files: {
            "entry.ts": `
export function upstreamTestCount(): number { return 2; }
export function runStandaloneUpstreamTest(index: number): number { return index === 0 || index === 1 ? 1 : 0; }
export function cleanupUpstreamTestEnvironment(): void {}
`,
          },
          timeoutMs: 180_000,
          workerEnv: {
            DOGFOOD_TARGET: "standalone",
            JS2WASM_TYPESCRIPT_PROBE_IR_OUTCOMES: "1",
            DOGFOOD_PLATFORM: undefined,
            DOGFOOD_NODE_HOST_DEPS: undefined,
            DOGFOOD_INSTALL_JSDOM: undefined,
          },
        }),
      );
      expect(result.compile).toMatchObject({
        success: true,
        validates: true,
        requestedTarget: "standalone",
        actualTarget: "standalone",
        targetMatches: true,
        moduleImports: [],
        moduleImportCount: 0,
        linkedModuleImports: [],
        totalModuleImportCount: 0,
        importPolicyMatches: true,
      });
      expect(result.wasm).toEqual({ count: 2, statuses: [true, true], errors: ["", ""] });
      expect(result.compile.irOutcomes).toEqual(
        expect.arrayContaining([expect.objectContaining({ displayName: "upstreamTestCount", irBodyEmitted: true })]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
