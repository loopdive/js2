// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4617 C1 — the one-fact-at-a-time mutation matrix for the PRODUCTION
// `bench_loop` Prepared function-value route. Each case corrupts exactly one
// declaration fact (or one inventory join) between snapshot finalization and
// replay, and requires the route to withdraw BEFORE it allocates the
// trampoline/cache support pair or requests the direct-body skip — proven by
// the direct body running into its own injected poison.
//
// This lives beside tests/issue-4590-bench-loop-prepared-cutover.test.ts (which
// keeps the positive replay, anti-vacuity, live-lane parity, and
// post-certification tamper cases) purely so one CI fork's 512 MB heap is not
// asked to hold ~40 compilations of the real two-source benchmark graph.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compileMulti, type CompileResult } from "../src/index.js";

const ENTRY = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/loop.ts");
const HELPERS = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/helpers.ts");
const LOOP_SOURCE = readFileSync(ENTRY, "utf8");
const HELPERS_SOURCE = readFileSync(HELPERS, "utf8");
const CUTOVER = "JS2WASM_MULTI_PREPARED_BENCH_LOOP_CUTOVER";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const MUTATE_SNAPSHOT = "JS2WASM_TEST_MUTATE_DECLARATION_SNAPSHOT";
const POISON_MESSAGE = "live declaration oracle poisoned after semantic-snapshot finalization";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function compileBenchSources(): Promise<CompileResult> {
  vi.stubEnv(CUTOVER, "1");
  return compileMulti({ "helpers.ts": HELPERS_SOURCE, "loop.ts": LOOP_SOURCE }, "loop.ts", {
    experimentalIR: true,
    target: "standalone",
    trackIrOutcomes: true,
  });
}

describe("#4617 C1 declaration-replay mutation matrix", () => {
  it("routes the unmutated snapshot, so every rejection below is about the mutation", async () => {
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    const result = await compileBenchSources();
    expect(
      result.success,
      `unmutated replay lane failed:\n${result.errors.map((error) => error.message).join("\n")}`,
    ).toBe(true);
    expect(result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "bench_loop")).toEqual([]);
  });

  it.each([
    "drop-query",
    "answer-to-null",
    "duplicate-query",
    "unknown-query",
    "wrong-version",
    "extra-field",
    "wrong-source",
    "wrong-range",
    "wrong-role",
    "empty-population",
    "duplicate-population",
    "value-not-in-population",
    "foreign-import",
    "foreign-target",
    "copied-source",
    "stale-inventory",
  ])("withdraws before support allocation and skip for the %s mutation", async (mutation) => {
    vi.stubEnv(MUTATE_SNAPSHOT, mutation);
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    const result = await compileBenchSources();
    const messages = result.errors.map((error) => error.message).join("\n");

    expect(result.success).toBe(false);
    // The direct body ran: the route withdrew before requesting its skip.
    expect(messages).toContain("injected direct function-body poison: bench_loop");
    expect(
      result.irBodyRouteAudit?.legacyEntries
        .filter((row) => row.bodyName === "bench_loop")
        .map((row) => row.entryPoint),
    ).toContain("compileFunctionBody");
    // A withdrawal, never a live-oracle fallback, a late guess, or a torn skip.
    expect(messages).not.toContain(POISON_MESSAGE);
    expect(messages).not.toContain("did not withdraw atomically before its skip");
    expect(messages).not.toContain("drifted after direct-body certification");
    expect(messages).not.toContain("could not preallocate exact support");
  });

  it("fails an unknown mutation name instead of silently routing", async () => {
    vi.stubEnv(MUTATE_SNAPSHOT, "not-a-declared-mutation");
    const result = await compileBenchSources();
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "unknown declaration-snapshot mutation not-a-declared-mutation",
    );
  });
});
