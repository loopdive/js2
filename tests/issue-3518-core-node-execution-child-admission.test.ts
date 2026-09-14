// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// These adapter controls deliberately mock the child and receipt validator.
// Their synthetic schema cannot be accepted by the real production validator;
// no mock output is evidence of an observed compiler caller.
const state = vi.hoisted(() => ({
  mode: "pass",
  sourceReads: 0,
  runtimeReads: 0,
  childCalls: [] as any[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn((executable, args, options) => {
      state.childCalls.push({ executable, args, options });
      const output = args[args.indexOf("--json") + 1];
      if (state.mode !== "missing-receipt") {
        writeFileSync(
          output,
          state.mode === "malformed-receipt"
            ? "{"
            : JSON.stringify({
                schema: "synthetic-admission-control-only",
                ok: state.mode !== "report-false",
                fullWitnessCount: 12,
              }),
        );
      }
      return {
        status: state.mode === "nonzero" ? 7 : 0,
        signal: state.mode === "signal" ? "SIGTERM" : null,
        error:
          state.mode === "timeout"
            ? Object.assign(new Error("simulated timeout with passing-looking receipt"), { code: "ETIMEDOUT" })
            : undefined,
        stdout: "",
        stderr: "",
      };
    }),
  };
});

vi.mock("../scripts/lib/core-node-execution-witness.mjs", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    coreNodeExecutionSourceSnapshot: vi.fn(() => {
      state.sourceReads++;
      return {
        sha256: state.mode === "source-changed" && state.sourceReads > 1 ? "changed" : "before",
        files: { synthetic: "only" },
      };
    }),
    coreNodeExecutionRuntimeIdentity: vi.fn(({ launch }) => {
      state.runtimeReads++;
      return { launch, identity: state.mode === "runtime-changed" && state.runtimeReads > 1 ? "changed" : "before" };
    }),
    validateCoreNodeExecution: vi.fn(() => ({
      ok: state.mode !== "validator-false",
      errors: state.mode === "validator-false" ? ["simulated validator rejection"] : [],
    })),
  };
});

import { assessCoreNodeExecution, CORE_NODE_EXECUTION_TIMEOUT_MS } from "../scripts/lib/core-node-execution-gate.mjs";
import { validateCoreNodeExecution } from "../scripts/lib/core-node-execution-witness.mjs";

const root = resolve(import.meta.dirname, "..");

beforeEach(() => {
  state.mode = "pass";
  state.sourceReads = 0;
  state.runtimeReads = 0;
  state.childCalls = [];
  vi.clearAllMocks();
});

describe("#3518 child admission adapter controls, not compiler evidence", () => {
  it("admits the positive adapter control with independent source and launch expectations", async () => {
    const group = await assessCoreNodeExecution({ root, required: true });
    expect(group.ok).toBe(true);
    expect(group.failures).toEqual([]);
    expect(state.childCalls).toHaveLength(1);
    expect(state.sourceReads).toBe(2);
    expect(state.runtimeReads).toBe(2);
    const launch = state.childCalls[0];
    expect(launch.options.timeout).toBe(CORE_NODE_EXECUTION_TIMEOUT_MS);
    expect(launch.options.killSignal).toBe("SIGKILL");
    expect(launch.options.env.ESBUILD_BINARY_PATH).toBeUndefined();
    expect(launch.options.env.TSX_TSCONFIG_PATH).toBe(resolve(root, "tsconfig.json"));
    expect(launch.options.env.TSX_DISABLE_CACHE).toBe("1");
    expect(validateCoreNodeExecution).toHaveBeenCalledWith(group.evidence, {
      expectedRoot: root,
      expectedSourceTreeSha256: "before",
      expectedRuntimeIdentity: expect.objectContaining({ identity: "before" }),
    });
  });

  it("proves the synthetic positive adapter receipt is not real compiler evidence", async () => {
    const actual = await vi.importActual<any>("../scripts/lib/core-node-execution-witness.mjs");
    expect(
      actual.validateCoreNodeExecution({ schema: "synthetic-admission-control-only", ok: true, fullWitnessCount: 12 })
        .ok,
    ).toBe(false);
  });

  it.each([
    ["nonzero", "exited 7"],
    ["timeout", "simulated timeout"],
    ["signal", "terminated: SIGTERM"],
    ["missing-receipt", "ENOENT"],
    ["malformed-receipt", "JSON"],
    ["source-changed", "source changed during child execution"],
    ["runtime-changed", "runtime/loader/implementation changed during child execution"],
    ["validator-false", "simulated validator rejection"],
    ["report-false", "child did not certify"],
  ])("rejects %s independently of a passing-looking child", async (mode, message) => {
    state.mode = mode;
    const group = await assessCoreNodeExecution({ root, required: true });
    expect(group.required).toBe(true);
    expect(group.assessed).toBe(true);
    expect(group.ok).toBe(false);
    expect(group.failures.join(" ")).toContain(message);
    expect(group.cutStatus).toBe("unknown");
    expect(group.closureCertified).toBe(false);
    expect(group.retirementCertified).toBe(false);
    expect(state.childCalls).toHaveLength(1);
  });
});
