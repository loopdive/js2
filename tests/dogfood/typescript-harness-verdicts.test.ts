import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood helpers have no declaration files
import {
  typescriptBuildProbeExitCode,
  typescriptBuildProbeSucceeded,
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
  return {
    upstreamSuite: {
      selectedFiles: ["base64.ts", "comments.ts", "convertToBase64.ts", "parsePseudoBigInt.ts"],
    },
    extraction: { testsRegistered: 14, nativePassed: 14, nativeFailed: 0 },
    compile: { modules: 4, succeeded: 4, validated: 4 },
    results: { scored: 14, passed: 14, failed: 0, runtimeFailed: 0 },
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
    admittedFailure.results.passed = 13;
    admittedFailure.results.failed = 1;
    expect(typescriptUpstreamReportSucceeded(admittedFailure)).toBe(false);

    const runtimeFailure = passingSuiteReport();
    runtimeFailure.results.passed = 13;
    runtimeFailure.results.runtimeFailed = 1;
    expect(typescriptUpstreamReportSucceeded(runtimeFailure)).toBe(false);

    const silentlyReduced = passingSuiteReport();
    silentlyReduced.extraction.testsRegistered = 13;
    silentlyReduced.extraction.nativePassed = 13;
    silentlyReduced.results.scored = 13;
    silentlyReduced.results.passed = 13;
    expect(typescriptUpstreamReportSucceeded(silentlyReduced)).toBe(false);

    const empty = passingSuiteReport();
    empty.extraction.testsRegistered = 0;
    empty.extraction.nativePassed = 0;
    empty.results.scored = 0;
    empty.results.passed = 0;
    expect(typescriptUpstreamReportSucceeded(empty)).toBe(false);

    const invalidModule = passingSuiteReport();
    invalidModule.compile.validated = 3;
    expect(typescriptUpstreamReportSucceeded(invalidModule)).toBe(false);
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
