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
// asked to hold ~40 whole-pipeline compilations of the benchmark graph. For the
// same reason these cases stop at `generateMultiModule`: the route decision and
// its legacy audit are complete there, and binary/WAT/DTS emission would only
// add memory, never evidence.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { generateMultiModule, type GeneratedCodegenModule } from "../src/codegen/index.js";
import { compileMulti } from "../src/index.js";

// Register the low-level codegen delegates used by generateMultiModule.
import "../src/codegen/expressions.js";

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

// One analysis is shared by every case: the mutations act on the SNAPSHOT and
// the inventory join, never on the typed AST, and re-binding the two sources 18
// times is the single largest memory cost in this file.
let sharedAst: ReturnType<typeof analyzeMultiSource> | undefined;

function generateBench(): GeneratedCodegenModule {
  vi.stubEnv(CUTOVER, "1");
  sharedAst ??= analyzeMultiSource({ "helpers.ts": HELPERS_SOURCE, "loop.ts": LOOP_SOURCE }, "loop.ts");
  return generateMultiModule(sharedAst, { experimentalIR: true, target: "standalone", trackIrOutcomes: true });
}

function hardErrors(result: GeneratedCodegenModule): string {
  return result.errors
    .filter((error) => error.severity !== "warning")
    .map((error) => error.message)
    .join("\n");
}

function benchLoopLegacyEntryPoints(result: GeneratedCodegenModule): readonly string[] {
  return (result.irBodyRouteAudit?.legacyEntries ?? [])
    .filter((row) => row.bodyName === "bench_loop")
    .map((row) => row.entryPoint);
}

describe("#4617 C1 declaration-replay mutation matrix", () => {
  it("routes the unmutated snapshot, so every rejection below is about the mutation", () => {
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    const result = generateBench();
    expect(hardErrors(result)).toBe("");
    expect(benchLoopLegacyEntryPoints(result)).toEqual([]);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "bench_loop")).toMatchObject({
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
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
  ])("withdraws before support allocation and skip for the %s mutation", (mutation) => {
    vi.stubEnv(MUTATE_SNAPSHOT, mutation);
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    const errors = hardErrors(generateBench());

    // The direct body ran: the route withdrew before requesting its skip.
    expect(errors).toContain("injected direct function-body poison: bench_loop");
    // A withdrawal, never a live-oracle fallback, a late guess, or a torn skip.
    expect(errors).not.toContain(POISON_MESSAGE);
    expect(errors).not.toContain("did not withdraw atomically before its skip");
    expect(errors).not.toContain("drifted after direct-body certification");
    expect(errors).not.toContain("could not preallocate exact support");
  });

  // One case carries the whole pipeline so the legacy-route AUDIT — not just the
  // poison message — witnesses that the direct body was physically emitted.
  it("records the direct body on the whole-pipeline legacy audit when a mutation withdraws", async () => {
    vi.stubEnv(MUTATE_SNAPSHOT, "drop-query");
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    vi.stubEnv(CUTOVER, "1");
    const result = await compileMulti({ "helpers.ts": HELPERS_SOURCE, "loop.ts": LOOP_SOURCE }, "loop.ts", {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: bench_loop",
    );
    expect(
      result.irBodyRouteAudit?.legacyEntries
        .filter((row) => row.bodyName === "bench_loop")
        .map((row) => row.entryPoint),
    ).toContain("compileFunctionBody");
  });

  it("fails an unknown mutation name instead of silently routing", () => {
    vi.stubEnv(MUTATE_SNAPSHOT, "not-a-declared-mutation");
    expect(hardErrors(generateBench())).toContain("unknown declaration-snapshot mutation not-a-declared-mutation");
  });
});
