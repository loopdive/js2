import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood helpers have no declaration files
import {
  assertTypescriptBuildProbeInvocationSupported,
  publishTypescriptBuildProbeArtifact,
  publishTypescriptBuildProbeArtifactAfterExit,
  takeTypescriptBuildProbeArtifactCandidate,
  typescriptBuildProbeArtifactPath,
  typescriptBuildProbeErrorSummary,
  typescriptBuildProbeExitCode,
  typescriptBuildProbeSucceeded,
  typescriptBuildProbeTarget,
  typescriptBuildProbeTargetFromArgs,
  typescriptInvocationMatches,
} from "./typescript-upstream-build-probe.mjs";
// @ts-expect-error — .mjs dogfood helpers have no declaration files
import { typescriptUpstreamReportSucceeded } from "./typescript-upstream-suite.mjs";
// @ts-expect-error — .mjs dogfood helpers have no declaration files
import { generatePinnedTypescriptDiagnostics } from "./setup-typescript-upstream-suite.mjs";
// @ts-expect-error — .mjs dogfood helpers have no declaration files
import { cliUpstreamHarness } from "./upstream-suite-runner.mjs";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function passingSuiteReport() {
  const selectedFiles = ["base64.ts", "comments.ts", "compilerCore.ts", "convertToBase64.ts", "parsePseudoBigInt.ts"];
  const testCounts = [1, 3, 11, 5, 5];
  const details = selectedFiles.map((file, index) => ({
    file,
    requestedTarget: "gc",
    actualTarget: "gc",
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
    upstreamSuite: {
      selectedFiles,
    },
    extraction: { testsRegistered: 25, nativePassed: 25, nativeFailed: 0 },
    compile: { modules: 5, succeeded: 5, validated: 5, details },
    results: { scored: 25, passed: 25, failed: 0, runtimeFailed: 0 },
    target: {
      requestedTarget: "gc",
      actualTargets: ["gc"],
      importArtifacts: details.map(({ file }) => ({ file, artifact: "entry", moduleImportCount: 0 })),
      moduleImportCount: 0,
      zeroImports: true,
    },
  };
}

function passingProbeResult() {
  return {
    type: "result",
    success: true,
    compileSuccess: true,
    validates: true,
    invocation: { actual: 42, expected: 42, matches: true },
  };
}

describe("TypeScript dogfood acceptance verdicts", () => {
  it("keeps transferred diagnostic bytes and source maps out of the rendered result", () => {
    const message = {
      type: "result",
      binaryBytes: 20,
      diagnosticArtifactCandidate: {
        binary: Buffer.from("candidate-wasm-bytes"),
        sourceMap: "candidate-source-map",
      },
    };

    const candidate = takeTypescriptBuildProbeArtifactCandidate(message);
    expect(candidate?.binary).toEqual(Buffer.from("candidate-wasm-bytes"));
    expect(candidate?.sourceMap).toBe("candidate-source-map");
    expect(message).not.toHaveProperty("diagnosticArtifactCandidate");
    expect(JSON.stringify(message)).toBe('{"type":"result","binaryBytes":20}');
  });

  it("keeps workload, mode, and deployment-target diagnostic artifacts separate", () => {
    expect(typescriptBuildProbeArtifactPath("/fixtures/typescript-parser-workload.ts")).toBe(
      "/private/tmp/ts2wasm-typescript-parser-latest.wasm",
    );
    expect(typescriptBuildProbeArtifactPath("/fixtures/typescript-binder-workload.ts")).toBe(
      "/private/tmp/ts2wasm-typescript-binder-latest.wasm",
    );
    expect(typescriptBuildProbeArtifactPath("/fixtures/type checker workload.ts", "/artifacts")).toBe(
      "/artifacts/ts2wasm-type-checker-workload-latest.wasm",
    );
    expect(typescriptBuildProbeArtifactPath("/typescript/src/typescript/typescript.ts", "/artifacts", "source")).toBe(
      "/artifacts/ts2wasm-typescript-source-latest.wasm",
    );
    expect(typescriptBuildProbeArtifactPath("/typescript/lib/typescript.js", "/artifacts", "bundle")).toBe(
      "/artifacts/ts2wasm-typescript-bundle-latest.wasm",
    );
    expect(
      typescriptBuildProbeArtifactPath("/fixtures/typescript-parser-workload.ts", "/private/tmp", null, "standalone"),
    ).toBe("/private/tmp/ts2wasm-typescript-parser-standalone-latest.wasm");
    expect(
      typescriptBuildProbeArtifactPath(
        "/typescript/src/typescript/typescript.ts",
        "/artifacts",
        "source",
        "standalone",
      ),
    ).toBe("/artifacts/ts2wasm-typescript-source-standalone-latest.wasm");
    expect(typescriptBuildProbeArtifactPath("../../escape/evil workload.ts", "/artifacts", "../bundle")).toBe(
      "/artifacts/ts2wasm-evil-workload-bundle-latest.wasm",
    );
  });

  it("accepts only explicit deployment targets and limits standalone to static zero-argument oracles", () => {
    expect(typescriptBuildProbeTarget(null)).toBe("gc");
    expect(typescriptBuildProbeTarget("gc")).toBe("gc");
    expect(typescriptBuildProbeTarget("standalone")).toBe("standalone");
    expect(() => typescriptBuildProbeTarget(undefined)).toThrow("--target expects gc or standalone");
    expect(() => typescriptBuildProbeTarget("wasi")).toThrow("--target expects gc or standalone");
    expect(typescriptBuildProbeTargetFromArgs(["node", "probe.mjs"])).toBe("gc");
    expect(typescriptBuildProbeTargetFromArgs(["node", "probe.mjs", "--target=standalone"])).toBe("standalone");
    expect(() =>
      typescriptBuildProbeTargetFromArgs(["node", "probe.mjs", "--target", "gc", "--target=standalone"]),
    ).toThrow("--target may be specified only once");

    expect(() => assertTypescriptBuildProbeInvocationSupported("gc", true)).not.toThrow();
    expect(() => assertTypescriptBuildProbeInvocationSupported("standalone", false)).not.toThrow();
    expect(() => assertTypescriptBuildProbeInvocationSupported("standalone", true, true)).not.toThrow();
    expect(() => assertTypescriptBuildProbeInvocationSupported("standalone", true)).toThrow(
      /supports only static --invoke-zero-case oracles/,
    );
  });

  it("rejects legacy oracle flags that omit the export to invoke", () => {
    const probe = fileURLToPath(new URL("./typescript-upstream-build-probe.mjs", import.meta.url));
    for (const orphanedFlags of [
      ["--invoke-string", "const x = 1;"],
      ["--expected-number", "42"],
      ["--invoke-string", "const x = 1;", "--expected-number", "42"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [probe, "--root", tmpdir(), "--entry", "missing.ts", ...orphanedFlags, "--json"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "--invoke-string/--expected-number require --invoke-export",
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("entry does not exist");
    }
  });

  it("publishes only accepted diagnostic artifacts and preserves the last-good pair on failure", () => {
    const root = mkdtempSync(join(tmpdir(), "ts2wasm-typescript-artifact-"));
    const artifactPath = join(root, "ts2wasm-typescript-parser-latest.wasm");
    const mapPath = `${artifactPath}.map`;
    const oldBinary = Buffer.from("last-good-wasm");
    const oldMap = "last-good-map";
    try {
      writeFileSync(artifactPath, oldBinary);
      writeFileSync(mapPath, oldMap);

      expect(
        publishTypescriptBuildProbeArtifact({
          artifactPath,
          binary: new Uint8Array(0),
          sourceMap: "failed-map",
          accepted: false,
        }),
      ).toEqual({ artifactPath, mapPath, published: false, sourceMapPublished: false });
      expect(readFileSync(artifactPath)).toEqual(oldBinary);
      expect(readFileSync(mapPath, "utf8")).toBe(oldMap);
      expect(readdirSync(root).sort()).toEqual([
        "ts2wasm-typescript-parser-latest.wasm",
        "ts2wasm-typescript-parser-latest.wasm.map",
      ]);

      expect(() =>
        publishTypescriptBuildProbeArtifact({
          artifactPath,
          binary: {} as unknown as Uint8Array,
          sourceMap: "uncommitted-map",
          accepted: true,
        }),
      ).toThrow();
      expect(readFileSync(artifactPath)).toEqual(oldBinary);
      expect(readFileSync(mapPath, "utf8")).toBe(oldMap);
      expect(readdirSync(root).sort()).toEqual([
        "ts2wasm-typescript-parser-latest.wasm",
        "ts2wasm-typescript-parser-latest.wasm.map",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the previous map even when moving the rejected map aside fails", () => {
    const root = mkdtempSync(join(tmpdir(), "ts2wasm-typescript-artifact-rollback-"));
    const artifactPath = join(root, "ts2wasm-typescript-parser-latest.wasm");
    const mapPath = `${artifactPath}.map`;
    const oldBinary = Buffer.from("last-good-wasm");
    let binaryCommitFailed = false;
    let rejectedMapMoveAttempted = false;
    let previousMapRestoreAttempted = false;
    try {
      writeFileSync(artifactPath, oldBinary);
      writeFileSync(mapPath, "last-good-map");

      let thrown: unknown;
      try {
        publishTypescriptBuildProbeArtifact(
          {
            artifactPath,
            binary: Buffer.from("candidate-wasm"),
            sourceMap: "candidate-map",
            accepted: true,
          },
          {
            existsSync,
            writeFileSync,
            rmSync,
            renameSync(from: string, to: string) {
              if (to === artifactPath) {
                binaryCommitFailed = true;
                throw new Error("forced binary commit failure");
              }
              if (binaryCommitFailed && from === mapPath && to.endsWith(".tmp")) {
                rejectedMapMoveAttempted = true;
                throw new Error("forced rejected-map rollback failure");
              }
              if (binaryCommitFailed && from.endsWith(".previous") && to === mapPath) {
                previousMapRestoreAttempted = true;
              }
              renameSync(from, to);
            },
          },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError & { cause?: unknown };
      expect((aggregate.cause as Error).message).toBe("forced binary commit failure");
      expect(aggregate.errors.map((error: Error) => error.message)).toEqual([
        "forced binary commit failure",
        "forced rejected-map rollback failure",
      ]);
      expect(aggregate.message).toContain("the previous map was restored despite the rollback error");
      expect(rejectedMapMoveAttempted).toBe(true);
      expect(previousMapRestoreAttempted).toBe(true);
      expect(readFileSync(artifactPath)).toEqual(oldBinary);
      expect(readFileSync(mapPath, "utf8")).toBe("last-good-map");
      expect(readdirSync(root).sort()).toEqual([
        "ts2wasm-typescript-parser-latest.wasm",
        "ts2wasm-typescript-parser-latest.wasm.map",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the previous map as a recovery file when restoration itself fails", () => {
    const root = mkdtempSync(join(tmpdir(), "ts2wasm-typescript-artifact-rollback-"));
    const artifactPath = join(root, "ts2wasm-typescript-parser-latest.wasm");
    const mapPath = `${artifactPath}.map`;
    const oldBinary = Buffer.from("last-good-wasm");
    let binaryCommitFailed = false;
    try {
      writeFileSync(artifactPath, oldBinary);
      writeFileSync(mapPath, "last-good-map");

      let thrown: unknown;
      try {
        publishTypescriptBuildProbeArtifact(
          {
            artifactPath,
            binary: Buffer.from("candidate-wasm"),
            sourceMap: "candidate-map",
            accepted: true,
          },
          {
            existsSync,
            writeFileSync,
            rmSync,
            renameSync(from: string, to: string) {
              if (to === artifactPath) {
                binaryCommitFailed = true;
                throw new Error("forced binary commit failure");
              }
              if (binaryCommitFailed && from.endsWith(".previous") && to === mapPath) {
                throw new Error("forced previous-map restoration failure");
              }
              renameSync(from, to);
            },
          },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError & { cause?: unknown };
      expect((aggregate.cause as Error).message).toBe("forced binary commit failure");
      expect(aggregate.errors.map((error: Error) => error.message)).toEqual([
        "forced binary commit failure",
        "forced previous-map restoration failure",
      ]);
      const recoveryFile = readdirSync(root).find((name) => name.endsWith(".previous"));
      expect(recoveryFile).toBeDefined();
      expect(aggregate.message).toContain(join(root, recoveryFile!));
      expect(readFileSync(artifactPath)).toEqual(oldBinary);
      expect(existsSync(mapPath)).toBe(false);
      expect(readFileSync(join(root, recoveryFile!), "utf8")).toBe("last-good-map");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically replaces an accepted diagnostic artifact and retires a stale map", () => {
    const root = mkdtempSync(join(tmpdir(), "ts2wasm-typescript-artifact-"));
    const artifactPath = join(root, "ts2wasm-typescript-binder-latest.wasm");
    const mapPath = `${artifactPath}.map`;
    try {
      writeFileSync(artifactPath, "old-wasm");
      writeFileSync(mapPath, "old-map");
      const binary = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

      expect(
        publishTypescriptBuildProbeArtifact({
          artifactPath,
          binary,
          sourceMap: "new-map",
          accepted: true,
        }),
      ).toEqual({ artifactPath, mapPath, published: true, sourceMapPublished: true });
      expect(readFileSync(artifactPath)).toEqual(binary);
      expect(readFileSync(mapPath, "utf8")).toBe("new-map");
      expect(readdirSync(root).sort()).toEqual([
        "ts2wasm-typescript-binder-latest.wasm",
        "ts2wasm-typescript-binder-latest.wasm.map",
      ]);

      expect(
        publishTypescriptBuildProbeArtifact({
          artifactPath,
          binary,
          sourceMap: undefined,
          accepted: true,
        }),
      ).toEqual({ artifactPath, mapPath, published: true, sourceMapPublished: false });
      expect(readFileSync(artifactPath)).toEqual(binary);
      expect(existsSync(mapPath)).toBe(false);
      expect(readdirSync(root)).toEqual(["ts2wasm-typescript-binder-latest.wasm"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for a clean worker exit before replacing a diagnostic artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "ts2wasm-typescript-artifact-exit-"));
    const artifactPath = join(root, "ts2wasm-typescript-parser-latest.wasm");
    const mapPath = `${artifactPath}.map`;
    const oldBinary = Buffer.from("last-good-wasm");
    const candidateBinary = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    try {
      writeFileSync(artifactPath, oldBinary);
      writeFileSync(mapPath, "last-good-map");

      for (const lifecycle of [
        { timedOut: true, workerExitCode: 0 },
        { timedOut: false, workerExitCode: 1 },
      ]) {
        expect(
          publishTypescriptBuildProbeArtifactAfterExit({
            artifactPath,
            binary: candidateBinary,
            sourceMap: "candidate-map",
            finalMessage: passingProbeResult(),
            invocationRequirement: true,
            ...lifecycle,
          }),
        ).toEqual({ artifactPath, mapPath, published: false, sourceMapPublished: false });
        expect(readFileSync(artifactPath)).toEqual(oldBinary);
        expect(readFileSync(mapPath, "utf8")).toBe("last-good-map");
      }

      expect(
        publishTypescriptBuildProbeArtifactAfterExit({
          artifactPath,
          binary: candidateBinary,
          sourceMap: "candidate-map",
          finalMessage: passingProbeResult(),
          invocationRequirement: true,
          timedOut: false,
          workerExitCode: 0,
        }),
      ).toEqual({ artifactPath, mapPath, published: true, sourceMapPublished: true });
      expect(readFileSync(artifactPath)).toEqual(candidateBinary);
      expect(readFileSync(mapPath, "utf8")).toBe("candidate-map");
      expect(readdirSync(root).sort()).toEqual([
        "ts2wasm-typescript-parser-latest.wasm",
        "ts2wasm-typescript-parser-latest.wasm.map",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let the bounded warning prefix hide a tail compile error", () => {
    const warnings = Array.from({ length: 25 }, (_, index) => ({
      message: `warning ${index}`,
      severity: "warning",
    }));
    const failure = { message: "binary emission failed", code: 9001, severity: "error" };

    const summary = typescriptBuildProbeErrorSummary([...warnings, failure]);
    expect(summary).toHaveLength(20);
    expect(summary[0]).toEqual(expect.objectContaining(failure));
    expect(summary.slice(1).every((diagnostic: { severity: string }) => diagnostic.severity === "warning")).toBe(true);
  });

  it("runs the pinned official diagnostics generator and verifies every generated artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "ts2wasm-typescript-diagnostics-"));
    const informationMap = "export const Diagnostics = { synthetic: true };\r\n";
    const messages = '{"synthetic":"message"}\r\n';
    const pin = {
      generatedDiagnostics: {
        script: "scripts/processDiagnosticMessages.mjs",
        input: "src/compiler/diagnosticMessages.json",
        artifacts: [
          { path: "src/compiler/diagnosticInformationMap.generated.ts", sha256: sha256(informationMap) },
          { path: "src/compiler/diagnosticMessages.generated.json", sha256: sha256(messages) },
        ],
      },
    };
    try {
      const result = generatePinnedTypescriptDiagnostics(root, pin, {
        execFileSync(executable: string, args: string[], options: { cwd: string }) {
          expect(executable).toBe(process.execPath);
          expect(args).toEqual(["scripts/processDiagnosticMessages.mjs", "src/compiler/diagnosticMessages.json"]);
          expect(options.cwd).toBe(root);
          mkdirSync(join(root, "src", "compiler"), { recursive: true });
          writeFileSync(join(root, "src", "compiler", "diagnosticInformationMap.generated.ts"), informationMap);
          writeFileSync(join(root, "src", "compiler", "diagnosticMessages.generated.json"), messages);
        },
      });
      expect(result.artifacts).toEqual(pin.generatedDiagnostics.artifacts);

      expect(() =>
        generatePinnedTypescriptDiagnostics(root, pin, {
          execFileSync() {
            writeFileSync(join(root, "src", "compiler", "diagnosticInformationMap.generated.ts"), "stale");
          },
        }),
      ).toThrow(/generated diagnostic artifact mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps finite legacy oracles while requiring safe integers for packed parser results", () => {
    expect(typescriptInvocationMatches(-13.25, -13.25, false)).toBe(true);
    expect(typescriptInvocationMatches(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1, false)).toBe(true);
    expect(typescriptInvocationMatches(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1, true)).toBe(false);
    expect(typescriptInvocationMatches(13.25, 13.5, false)).toBe(false);
    expect(typescriptInvocationMatches(Infinity, Infinity, false)).toBe(false);
    expect(typescriptInvocationMatches(NaN, NaN, false)).toBe(false);

    const decimalLegacyResult = {
      ...passingProbeResult(),
      invocation: { actual: -13.25, expected: -13.25, matches: true },
    };
    expect(typescriptBuildProbeSucceeded(decimalLegacyResult, true)).toBe(true);
    expect(typescriptBuildProbeExitCode(decimalLegacyResult, true, false, 0)).toBe(0);
    expect(typescriptBuildProbeSucceeded(decimalLegacyResult, 1)).toBe(false);
  });

  it("requires positive selected-suite floors and every admitted callback to pass", () => {
    expect(typescriptUpstreamReportSucceeded(passingSuiteReport())).toBe(true);

    const admittedFailure = passingSuiteReport();
    admittedFailure.results.passed = 24;
    admittedFailure.results.failed = 1;
    expect(typescriptUpstreamReportSucceeded(admittedFailure)).toBe(false);

    const runtimeFailure = passingSuiteReport();
    runtimeFailure.results.passed = 24;
    runtimeFailure.results.runtimeFailed = 1;
    expect(typescriptUpstreamReportSucceeded(runtimeFailure)).toBe(false);

    const silentlyReduced = passingSuiteReport();
    silentlyReduced.extraction.testsRegistered = 24;
    silentlyReduced.extraction.nativePassed = 24;
    silentlyReduced.results.scored = 24;
    silentlyReduced.results.passed = 24;
    expect(typescriptUpstreamReportSucceeded(silentlyReduced)).toBe(false);

    const empty = passingSuiteReport();
    empty.extraction.testsRegistered = 0;
    empty.extraction.nativePassed = 0;
    empty.results.scored = 0;
    empty.results.passed = 0;
    expect(typescriptUpstreamReportSucceeded(empty)).toBe(false);

    const invalidModule = passingSuiteReport();
    invalidModule.compile.validated = 4;
    expect(typescriptUpstreamReportSucceeded(invalidModule)).toBe(false);

    const missingTarget = passingSuiteReport() as ReturnType<typeof passingSuiteReport> & { target?: unknown };
    missingTarget.target = undefined;
    expect(typescriptUpstreamReportSucceeded(missingTarget)).toBe(false);

    const runtimeCountMismatch = passingSuiteReport();
    runtimeCountMismatch.compile.details[0]!.wasmTestCount = 2;
    expect(typescriptUpstreamReportSucceeded(runtimeCountMismatch)).toBe(false);

    const runtimeStatusCountMismatch = passingSuiteReport();
    runtimeStatusCountMismatch.compile.details[0]!.wasmStatusCount = 2;
    expect(typescriptUpstreamReportSucceeded(runtimeStatusCountMismatch)).toBe(false);
  });

  it("turns a rejected strict report verdict into a nonzero CLI status", async () => {
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await cliUpstreamHarness(async () => passingSuiteReport(), {
        reportSucceeded: () => false,
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("requires validation and a requested invocation match for probe success", () => {
    expect(typescriptBuildProbeSucceeded(passingProbeResult(), false)).toBe(true);
    expect(typescriptBuildProbeSucceeded(passingProbeResult(), true)).toBe(true);

    const invalid = passingProbeResult();
    invalid.validates = false;
    expect(typescriptBuildProbeSucceeded(invalid, false)).toBe(false);

    const mismatch = passingProbeResult();
    mismatch.invocation.matches = false;
    expect(typescriptBuildProbeSucceeded(mismatch, true)).toBe(false);
    // A compile-only probe does not invent a runtime requirement.
    expect(typescriptBuildProbeSucceeded(mismatch, false)).toBe(true);

    const oracleMissing = passingProbeResult();
    oracleMissing.invocation.expected = undefined as unknown as number;
    expect(typescriptBuildProbeSucceeded(oracleMissing, true)).toBe(false);

    const missingInvocation = passingProbeResult();
    missingInvocation.invocation = undefined as unknown as { actual: number; expected: number; matches: boolean };
    expect(typescriptBuildProbeSucceeded(missingInvocation, true)).toBe(false);
  });

  it("requires coherent target provenance and zero Wasm imports for standalone acceptance", () => {
    const standalone = {
      ...passingProbeResult(),
      requestedTarget: "standalone",
      actualTarget: "standalone",
      moduleImports: [],
    };
    expect(typescriptBuildProbeSucceeded(standalone, false, "standalone")).toBe(true);
    expect(typescriptBuildProbeExitCode(standalone, false, false, 0, "standalone")).toBe(0);

    expect(
      typescriptBuildProbeSucceeded(
        {
          ...standalone,
          moduleImports: [{ module: "env", name: "__console_log", kind: "function" }],
        },
        false,
        "standalone",
      ),
    ).toBe(false);
    expect(typescriptBuildProbeSucceeded({ ...standalone, actualTarget: "gc" }, false, "standalone")).toBe(false);
    expect(typescriptBuildProbeSucceeded({ ...standalone, moduleImports: null }, false, "standalone")).toBe(false);

    const gc = {
      ...passingProbeResult(),
      requestedTarget: "gc",
      actualTarget: "gc",
      moduleImports: [{ module: "env", name: "__console_log", kind: "function" }],
    };
    expect(typescriptBuildProbeSucceeded(gc, false, "gc")).toBe(true);
    expect(typescriptBuildProbeSucceeded({ ...gc, requestedTarget: "standalone" }, false, "gc")).toBe(false);

    const zeroArgumentOracle = {
      ...standalone,
      invocation: null,
      invocations: [{ actual: 42, expected: 42, matches: true, zeroArguments: true }],
    };
    expect(typescriptBuildProbeSucceeded(zeroArgumentOracle, 1, "standalone")).toBe(true);
    expect(
      typescriptBuildProbeSucceeded(
        {
          ...zeroArgumentOracle,
          invocations: [{ actual: 42, expected: 42, matches: true, zeroArguments: false }],
        },
        1,
        "standalone",
      ),
    ).toBe(false);
    expect(
      typescriptBuildProbeSucceeded(
        {
          ...zeroArgumentOracle,
          invocations: [{ actual: 42, expected: 42, matches: true }],
        },
        1,
        "standalone",
      ),
    ).toBe(false);
  });

  it("recomputes every required parser oracle instead of trusting an aggregate verdict", () => {
    const result = {
      ...passingProbeResult(),
      invocation: null,
      invocations: [
        { actual: 11, expected: 11, matches: true },
        { actual: 22, expected: 22, matches: true },
        { actual: 33, expected: 33, matches: true },
      ],
    };
    expect(typescriptBuildProbeSucceeded(result, 3)).toBe(true);

    result.invocations[1]!.actual = 23;
    expect(typescriptBuildProbeSucceeded(result, 3)).toBe(false);
    result.invocations[1]!.actual = 22;
    result.invocations[1]!.matches = false;
    expect(typescriptBuildProbeSucceeded(result, 3)).toBe(false);
    result.invocations[1]!.matches = true;
    expect(typescriptBuildProbeSucceeded({ ...result, invocations: result.invocations.slice(0, 2) }, 3)).toBe(false);
    expect(
      typescriptBuildProbeSucceeded(
        {
          ...result,
          invocations: [
            ...result.invocations.slice(0, 2),
            { actual: Number.MAX_SAFE_INTEGER + 1, expected: Number.MAX_SAFE_INTEGER + 1, matches: true },
          ],
        },
        3,
      ),
    ).toBe(false);
  });

  it("fails closed when a passing worker result is followed by timeout or nonzero exit", () => {
    const passing = passingProbeResult();
    expect(typescriptBuildProbeExitCode(passing, true, false, 0)).toBe(0);
    expect(typescriptBuildProbeExitCode(passing, true, true, 0)).toBe(124);
    expect(typescriptBuildProbeExitCode(passing, true, true, 1)).toBe(124);
    expect(typescriptBuildProbeExitCode(passing, true, false, 1)).toBe(1);
    expect(typescriptBuildProbeExitCode(passing, true, false, null)).toBe(1);
  });
});
