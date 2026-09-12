// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assessCoreNodeExecution,
  conjoinCoreNodeExecution,
  runCoreNodeExecutionChild,
  CORE_NODE_EXECUTION_TIMEOUT_MS,
} from "../scripts/lib/core-node-execution-gate.mjs";

const root = resolve(import.meta.dirname, "..");
const limits = {
  cutAssessed: false,
  cutWitnessCount: null,
  cutStatus: "unknown",
  closureCertified: false,
  retirementCertified: false,
};

// Synthetic admission inputs exercise conjunction only. They are not compiler
// execution receipts and cannot pass validateCoreNodeExecution.
function oldReport(strict = true, preservation = true) {
  return {
    ok: strict,
    closureCertified: false,
    retirementCertified: false,
    graphState: strict ? "MODELED-SOURCE-RESOLVED" : "OPEN",
    functions: Array.from({ length: 6 }, (_, index) => ({ id: index, full: [index], cut: [index] })),
    diagnostics: strict ? [] : [{ id: "actual-open-site" }],
    coreTypes: { expectedSymbols: 10, fullWitnessCount: 10, cutWitnessCount: 10 },
    failures: strict ? [] : ["original strict failure"],
    preservation: {
      sourceIntegrityOK: preservation,
      ok: preservation,
      fullWitnessCount: 6,
      cutWitnessCount: 6,
      receipts: [{ id: "original receipt" }],
      oldRatchet: { baselineCount: 25, currentCount: 25, added: [], removed: [] },
      failures: preservation ? [] : ["original preservation failure"],
    },
  };
}

function assessedGroup() {
  return { required: true, assessed: true, denominator: 12, fullWitnessCount: 12, ...limits, failures: [], ok: true };
}

describe("#3518 additive node execution admission", () => {
  it("bounds a fresh hanging diagnostic child and treats its deadline as failure", () => {
    expect(CORE_NODE_EXECUTION_TIMEOUT_MS).toBe(120_000);
    const result = runCoreNodeExecutionChild({
      root,
      launch: { execArgv: [], argv: ["-e", "setInterval(() => {}, 1000)"], nodeOptions: "", coverageDirectory: "" },
      timeoutMs: 100,
    });
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(result.signal).toBe("SIGKILL");
    expect(result.status).toBeNull();
  });

  it("pins only the child loader environment without changing inherited settings", () => {
    vi.stubEnv("ESBUILD_BINARY_PATH", "/invalid/untrusted-esbuild");
    vi.stubEnv("TSX_TSCONFIG_PATH", "/invalid/untrusted-tsconfig");
    vi.stubEnv("TSX_DISABLE_CACHE", "untrusted-cache-mode");
    try {
      const result = runCoreNodeExecutionChild({
        root,
        launch: {
          execArgv: [],
          argv: [
            "-e",
            "console.log(JSON.stringify({esbuild:process.env.ESBUILD_BINARY_PATH??null,config:process.env.TSX_TSCONFIG_PATH,cache:process.env.TSX_DISABLE_CACHE}))",
          ],
          nodeOptions: "--max-old-space-size=2048",
          coverageDirectory: "",
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ esbuild: null, config: resolve(root, "tsconfig.json"), cache: "1" });
      expect(process.env.ESBUILD_BINARY_PATH).toBe("/invalid/untrusted-esbuild");
      expect(process.env.TSX_TSCONFIG_PATH).toBe("/invalid/untrusted-tsconfig");
      expect(process.env.TSX_DISABLE_CACHE).toBe("untrusted-cache-mode");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not inspect a tree or report success when the group is not required", async () => {
    const group = await assessCoreNodeExecution({ root: "/absent/no-source-tree", required: false });
    expect(group).toMatchObject({
      required: false,
      assessed: false,
      denominator: 12,
      fullWitnessCount: null,
      ok: null,
      ...limits,
    });
    expect(group.failures).toEqual([]);
    expect(group.evidence).toBeNull();
  });

  it("fails a required group when its source tree is absent", async () => {
    const group = await assessCoreNodeExecution({ root: "/absent/no-source-tree", required: true });
    expect(group).toMatchObject({ required: true, assessed: true, denominator: 12, ok: false, ...limits });
    expect(group.failures.length).toBeGreaterThan(0);
  });

  it.each([
    [true, true],
    [false, true],
    [false, false],
    [true, false],
  ])("never promotes existing strict=%s / preservation=%s verdicts", (strict, preservation) => {
    const old = oldReport(strict, preservation);
    const before = structuredClone(old);
    const result = conjoinCoreNodeExecution(old, assessedGroup());
    const { coreNodes, ...unchanged } = result;
    expect(unchanged).toEqual(before);
    expect(coreNodes).toMatchObject(limits);
  });

  it.each([
    ["ok", false],
    ["ok", null],
    ["assessed", false],
    ["denominator", 0],
    ["denominator", 11],
    ["denominator", 13],
    ["fullWitnessCount", null],
    ["fullWitnessCount", 0],
    ["fullWitnessCount", 11],
    ["fullWitnessCount", 13],
    ["cutAssessed", true],
    ["cutWitnessCount", 12],
    ["cutStatus", "passed"],
    ["closureCertified", true],
    ["retirementCertified", true],
    ["failures", ["observer error"]],
  ])("rejects incomplete or promoted required group field %s=%j", (key, value) => {
    const old = oldReport();
    const before = structuredClone(old);
    const group = { ...assessedGroup(), [key as string]: value };
    const result = conjoinCoreNodeExecution(old, group);
    expect(result.ok).toBe(false);
    expect(result.preservation.ok).toBe(false);
    expect(result.preservation.sourceIntegrityOK).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.preservation.failures.length).toBeGreaterThan(0);
    for (const field of ["functions", "diagnostics", "coreTypes", "graphState"] as const)
      expect(result[field]).toEqual(before[field]);
    for (const field of ["fullWitnessCount", "cutWitnessCount", "receipts", "oldRatchet"] as const)
      expect(result.preservation[field]).toEqual(before.preservation[field]);
    expect(result.closureCertified).toBe(false);
    expect(result.retirementCertified).toBe(false);
  });

  it("keeps pre-existing failure reasons when the additional requirement fails", () => {
    const result = conjoinCoreNodeExecution(oldReport(false, false), {
      ...assessedGroup(),
      ok: false,
      failures: ["new node failure"],
    });
    expect(result.failures).toEqual(["original strict failure", "core nodes: new node failure"]);
    expect(result.preservation.failures).toEqual(["original preservation failure", "core nodes: new node failure"]);
  });

  it("keeps all prior gates and explicitly opts the package command into nodes", () => {
    const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
    expect(scripts["check:dead-exports"]).toBe(
      "node scripts/audit-legacy-reachability.mjs --check --moved-reference-contract=preservation-v1 --require-core-types --require-core-nodes",
    );
  });

  it.each([
    [["--require-core-nodes"], "requires --check"],
    [["--check", "--require-core-nodes", "--require-core-nodes"], "duplicate --require-core-nodes"],
  ])("rejects invalid node-gate invocation %j", (args, message) => {
    const result = spawnSync(
      process.execPath,
      [resolve(root, "scripts/audit-legacy-reachability.mjs"), ...(args as string[])],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});
