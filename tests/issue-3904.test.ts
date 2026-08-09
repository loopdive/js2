// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #3904 — the four `dom/*` benchmarks published a JS-only bar.
 *
 * Two independent defects, both covered here:
 *
 * 1. `benchmarks/suites/dom.ts` handed `buildImports` the extern *classes*
 *    (`Document`, `Element`) but never `document` itself. The compiled module
 *    imports `env.global_document`, a `declared_global` intent keyed by the
 *    global's own name, so the lookup missed, fell through to the (absent)
 *    ambient `globalThis.document`, and the module got `undefined` as its
 *    Document handle. Every host-call lane then trapped on its first call with
 *    `Cannot read properties of undefined (reading 'createElement')`.
 *
 * 2. `benchmarks/harness.ts` turned any strategy failure into `return null`,
 *    so the trap never reached `latest.json` — the bar simply vanished from
 *    the chart, indistinguishable from a lane the benchmark deliberately
 *    skips. A failed strategy is now recorded as a `status: "failed"` row.
 */

import { describe, expect, it } from "vitest";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type BenchmarkDef, type BenchmarkResult, isMeasured, runBenchmark } from "../benchmarks/harness.js";
import { buildHistory, generateMarkdown } from "../benchmarks/report.js";
import { domBenchmarks } from "../benchmarks/suites/dom.js";
import { validateInternalSuite } from "../scripts/benchmark-lifecycle.mjs";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

/** Compile a benchmark def the way the harness' `host-call` lane does. */
async function runHostCallLane(def: BenchmarkDef): Promise<number> {
  const result = await compile(def.source, {
    fast: false,
    emitWat: false,
    optimize: 0,
  });
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  const imports = buildImports(result.imports, def.deps ?? {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  const run = (instance.exports as Record<string, () => number>).run;
  expect(run, `${def.name} exports run`).toBeTypeOf("function");
  return run();
}

describe("#3904 — dom/* benchmarks publish a real host-call lane", () => {
  it("registers all four DOM benchmarks with host-call NOT skipped", () => {
    expect(domBenchmarks.map((d) => d.name)).toEqual([
      "dom/create-elements",
      "dom/set-attributes",
      "dom/read-attributes",
      "dom/modify-text",
    ]);
    for (const def of domBenchmarks) {
      // gc-native / linear-memory are legitimately skipped (DOM is host interop).
      expect(def.skip, `${def.name} skip list`).toEqual(["gc-native", "linear-memory"]);
      expect(def.skip).not.toContain("host-call");
    }
  });

  it("supplies the `document` global itself, not just the Document class", () => {
    for (const def of domBenchmarks) {
      const deps = def.deps ?? {};
      // The regression guard: `Document` alone is what shipped, and it is not
      // enough — `env.global_document` resolves on the lowercase global name.
      expect(deps, `${def.name} deps`).toHaveProperty("document");
      expect(deps.document, `${def.name} deps.document`).toBeTruthy();
      expect((deps.document as { createElement?: unknown }).createElement).toBeTypeOf("function");
    }
  });

  it.each(domBenchmarks.map((d) => [d.name, d] as const))(
    "%s runs its host-call lane without trapping",
    async (_name, def) => {
      await expect(runHostCallLane(def)).resolves.toBeTypeOf("number");
    },
    60_000,
  );

  it("read-attributes returns the expected count through the host boundary", async () => {
    const def = domBenchmarks.find((d) => d.name === "dom/read-attributes")!;
    expect(await runHostCallLane(def)).toBe(1000);
  }, 60_000);
});

describe("#3904 — a failed strategy is recorded, not silently dropped", () => {
  /** A def whose host-call lane traps exactly the way the DOM lanes used to. */
  const broken: BenchmarkDef = {
    name: "probe/broken",
    iterations: 2,
    warmup: 1,
    source: `
declare class Document {
  createElement(tag: string): Element;
}
declare class Element {
  appendChild(child: Element): void;
}
declare const document: Document;

export function run(): number {
  const parent = document.createElement("div");
  parent.appendChild(document.createElement("span"));
  return 0;
}`,
    // Deliberately no `document` entry — reproduces the original failure.
    deps: { Document: Object, Element: Object },
    js: () => {},
    skip: ["gc-native", "linear-memory"],
  };

  it("emits a status/error row for the failed lane and no row for a skipped one", async () => {
    const results = await runBenchmark(broken, ["js", "host-call", "gc-native"]);

    // Skipped lane: absent entirely — "not applicable".
    expect(results.map((r) => r.strategy)).toEqual(["js", "host-call"]);

    const failed = results.find((r) => r.strategy === "host-call")!;
    expect(failed.status).toBe("failed");
    expect(failed.failedPhase).toBe("warmup");
    expect(failed.error).toContain("Cannot read properties of undefined");
    expect(isMeasured(failed)).toBe(false);
    // Placeholder timings must be zero so no consumer mistakes them for data.
    expect(failed.medianMs).toBe(0);

    const js = results.find((r) => r.strategy === "js")!;
    expect(isMeasured(js)).toBe(true);
  }, 60_000);

  it("never lets a zero-median failed lane win the markdown summary", () => {
    const rows: BenchmarkResult[] = [
      {
        name: "b",
        strategy: "js",
        iterations: 1,
        batchSize: 1,
        totalMs: 5,
        avgMs: 5,
        medianMs: 5,
        p95Ms: 5,
      },
      {
        name: "b",
        strategy: "host-call",
        iterations: 0,
        batchSize: 0,
        totalMs: 0,
        avgMs: 0,
        medianMs: 0,
        p95Ms: 0,
        status: "failed",
        error: "boom",
        failedPhase: "setup",
      },
    ];
    const md = generateMarkdown(rows);
    expect(md).toContain("| b | 5.00ms | FAILED | — | — | js |");
    expect(md).toContain("## Failed strategies");
    expect(md).toContain("| b | host-call | setup | boom |");
    // The failed lane must not produce a speedup number.
    expect(md).not.toContain("x faster");
  });

  it("keeps failed lanes out of the history trend series", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "issue-3904-history-"));
    try {
      writeFileSync(
        resolve(dir, "2026-07-31T12-00-00-000Z.json"),
        JSON.stringify([
          { name: "b", strategy: "js", medianMs: 5 },
          {
            name: "b",
            strategy: "host-call",
            medianMs: 0,
            status: "failed",
            error: "boom",
          },
        ]),
      );
      buildHistory(dir);
      const history = JSON.parse(readFileSync(resolve(dir, "history.json"), "utf8"));
      expect(history).toHaveLength(1);
      expect(history[0].benchmarks.b).toEqual({ js: 5 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts failed rows in the published-artifact validator, but demands a message", () => {
    const ok = [
      { name: "b", strategy: "js", medianMs: 5 },
      {
        name: "b",
        strategy: "host-call",
        medianMs: 0,
        status: "failed",
        error: "boom",
      },
    ];
    expect(() => validateInternalSuite(ok)).not.toThrow();

    // A failed row with no explanation is worse than useless.
    expect(() =>
      validateInternalSuite([
        { name: "b", strategy: "js", medianMs: 5 },
        { name: "b", strategy: "host-call", medianMs: 0, status: "failed" },
      ]),
    ).toThrow(/error must be a non-empty message/);

    // The JS reference is the scale for every other lane; it may never fail.
    expect(() =>
      validateInternalSuite([
        {
          name: "b",
          strategy: "js",
          medianMs: 0,
          status: "failed",
          error: "boom",
        },
      ]),
    ).toThrow(/JS baseline must always measure/);

    // A non-failed row still has to carry a positive median.
    expect(() => validateInternalSuite([{ name: "b", strategy: "js", medianMs: 0 }])).toThrow(/medianMs/);
  });
});
