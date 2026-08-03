// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2928 E5/E6 — a parser-injected interpreter provider and its user module
 * exchange native strings and an interpreted callable through core Wasm only.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

describe("#2928 — linked runtime Function provider", () => {
  it("returns and invokes an interpreted closure across the Wasm module boundary", { timeout: 1_200_000 }, async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=3072", "--import", "tsx", join(HERE, "interp", "runtime-function-link-probe.mjs")],
      {
        cwd: join(HERE, ".."),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const report = JSON.parse(stdout);

    expect(report.runtimeErrors).toEqual([]);
    expect(report.runtimeSuccess).toBe(true);
    expect(report.runtimeBytes).toBeGreaterThan(0);
    expect(report.runtimeImports).toEqual([]);
    expect(report.userErrors).toEqual([]);
    expect(report.userSuccess).toBe(true);
    expect(report.userImports).toEqual([
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_apply_interpreted",
        kind: "function",
      },
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_new_function",
        kind: "function",
      },
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_indirect_eval",
        kind: "function",
      },
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_direct_eval",
        kind: "function",
      },
    ]);
    expect(report.executionErrors).toEqual({});
    expect(report.values).toEqual({
      provider: 3,
      providerDirect: 84,
      providerVar: 240,
      create: 1,
      invokeNew: 3,
      invokeNewImmediate: 3,
      invokeCall: 5,
      invokeCallImmediate: 5,
      invokeFunctionAlias: 31,
      constructFunctionAlias: 7,
      interpretedIdentity: 1,
      sloppyThis: 1,
      strictThis: 1,
      aotIdentityRoundTrip: 1,
      indirectEval: 42,
      indirectEvalLiteralScope: 42,
      indirectEvalAlias: 42,
      indirectEvalNonString: 42,
      directEvalMutation: 84,
      directEvalNonString: 42,
      nestedDirectEvalMutation: 84,
      directEvalVarPersistence: 2,
      directEvalVarCreate: 7,
      nestedDirectEvalVarPersistence: 240,
      functionExpressionDirectEvalMutation: 84,
      arrowDirectEvalMutation: 84,
    });
  });
});
