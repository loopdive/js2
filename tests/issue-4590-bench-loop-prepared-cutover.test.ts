// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compileProject, type CompileResult } from "../src/index.js";

const ENTRY = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/loop.ts");
const CUTOVER = "JS2WASM_MULTI_PREPARED_BENCH_LOOP_CUTOVER";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";

function expectSuccess(result: CompileResult, label: string): void {
  expect(
    result.success,
    `${label} failed:\n${result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")}`,
  ).toBe(true);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#4590 exact bench_loop Prepared cutover", () => {
  it("bypasses the real compileProject direct body and restores it with the dedicated kill switch", async () => {
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    const prepared = await compileProject(ENTRY, {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectSuccess(prepared, "default-on Prepared compile");
    expect(prepared.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "bench_loop")).toEqual([]);
    expect(prepared.irOutcomes?.find((outcome) => outcome.displayName === "bench_loop")).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
    });

    vi.stubEnv(CUTOVER, "0");
    const direct = await compileProject(ENTRY, {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(direct.success).toBe(false);
    expect(direct.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: bench_loop",
    );
  });
});
