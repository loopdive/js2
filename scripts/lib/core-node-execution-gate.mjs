// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const limits = Object.freeze({
  cutAssessed: false,
  cutWitnessCount: null,
  cutStatus: "unknown",
  closureCertified: false,
  retirementCertified: false,
});
export const CORE_NODE_EXECUTION_TIMEOUT_MS = 120_000;

/** The deadline applies only to this newly launched, owned observation child. */
export function runCoreNodeExecutionChild({ root, launch, timeoutMs = CORE_NODE_EXECUTION_TIMEOUT_MS }) {
  const env = {
    ...process.env,
    NODE_OPTIONS: launch.nodeOptions,
    NODE_V8_COVERAGE: launch.coverageDirectory,
    TSX_TSCONFIG_PATH: resolve(root, "tsconfig.json"),
    TSX_DISABLE_CACHE: "1",
  };
  Reflect.deleteProperty(env, "ESBUILD_BINARY_PATH");
  return spawnSync(process.execPath, [...launch.execArgv, ...launch.argv], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
}

/** An explicit additional group; absence of an opt-in is never a passing proof. */
export async function assessCoreNodeExecution({ root, required }) {
  const group = {
    required,
    assessed: required,
    denominator: 12,
    scope: "observed canonical function calls during public compilation; not dispatch-cut or retirement proof",
    fullWitnessCount: null,
    ...limits,
    failures: [],
    ok: null,
    evidence: null,
  };
  if (!required) return group;
  group.ok = false;
  try {
    const {
      CORE_NODE_EXECUTION_TARGETS,
      coreNodeExecutionRuntimeIdentity,
      coreNodeExecutionSourceSnapshot,
      validateCoreNodeExecution,
    } = await import("./core-node-execution-witness.mjs");
    root = realpathSync(root);
    if (CORE_NODE_EXECUTION_TARGETS.length !== 12) throw new Error("fixed twelve-target population changed");
    const before = coreNodeExecutionSourceSnapshot(root);
    const scratchRoot = join(root, ".tmp");
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, "core-node-execution-"));
    const coverageDirectory = join(scratch, "source-map-content");
    mkdirSync(coverageDirectory);
    const json = join(scratch, "execution.json");
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../audit-core-node-execution.mjs");
    const launch = {
      execArgv: ["--import", "tsx"],
      argv: [cli, "--root", root, "--json", json],
      nodeOptions: "--max-old-space-size=2048",
      coverageDirectory,
      loaderOverrides: {
        ESBUILD_BINARY_PATH: null,
        TSX_TSCONFIG_PATH: resolve(root, "tsconfig.json"),
        TSX_DISABLE_CACHE: "1",
      },
    };
    const expectedRuntimeIdentity = coreNodeExecutionRuntimeIdentity({ root, launch });
    // tsx needs this child-only setting before initialization to embed actual
    // source content. Coverage output is NOT read or used as caller evidence.
    const child = runCoreNodeExecutionChild({ root, launch });
    group.evidencePath = json;
    group.child = {
      status: child.status,
      signal: child.signal,
      stderr: child.stderr?.slice(-8000) ?? "",
      timeoutMs: CORE_NODE_EXECUTION_TIMEOUT_MS,
    };
    if (child.error) throw child.error;
    if (child.signal) throw new Error(`execution child terminated: ${child.signal}`);
    const report = JSON.parse(readFileSync(json, "utf8"));
    group.evidence = report;
    const after = coreNodeExecutionSourceSnapshot(root);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("source changed during child execution");
    if (JSON.stringify(expectedRuntimeIdentity) !== JSON.stringify(coreNodeExecutionRuntimeIdentity({ root, launch })))
      throw new Error("runtime/loader/implementation changed during child execution");
    const verdict = validateCoreNodeExecution(report, {
      expectedRoot: root,
      expectedSourceTreeSha256: before.sha256,
      expectedRuntimeIdentity,
    });
    group.failures.push(...verdict.errors);
    if (child.status !== 0) group.failures.push(`execution child exited ${child.status}`);
    if (report.ok !== true) group.failures.push("execution child did not certify positive caller preservation");
    group.fullWitnessCount = report.fullWitnessCount ?? null;
    group.ok = verdict.ok === true && group.failures.length === 0;
  } catch (error) {
    group.failures.push(error.message);
  }
  return group;
}

/** Conjoin the group without changing any older graph, denominator or receipt. */
export function conjoinCoreNodeExecution(movedRuntime, coreNodes) {
  movedRuntime.coreNodes = coreNodes;
  const complete =
    coreNodes.assessed === true &&
    coreNodes.ok === true &&
    coreNodes.denominator === 12 &&
    coreNodes.fullWitnessCount === 12 &&
    coreNodes.failures.length === 0 &&
    Object.entries(limits).every(([key, value]) => coreNodes[key] === value);
  if (coreNodes.required && !complete) {
    const failures = coreNodes.failures.length ? coreNodes.failures : ["required node execution proof is missing"];
    movedRuntime.failures.push(...failures.map((failure) => `core nodes: ${failure}`));
    movedRuntime.preservation.failures.push(...failures.map((failure) => `core nodes: ${failure}`));
    movedRuntime.ok = false;
    movedRuntime.preservation.sourceIntegrityOK = false;
    movedRuntime.preservation.ok = false;
  }
  return movedRuntime;
}
