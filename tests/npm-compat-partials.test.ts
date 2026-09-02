import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { mergeNpmCompatPartials } from "../scripts/lib/npm-compat-partials.mjs";

function partial(names: string[], sourceRevision = "source", downloadBase = 0) {
  return {
    sourceRevision,
    summaryMeta: {
      note: "test",
      popularity: { metric: "weekly npm downloads" },
      performanceMethodology: {
        optimizationLevels: { "js-host": 4, standalone: 4 },
      },
    },
    packages: names.map((name, index) => ({
      name,
      weeklyDownloads: downloadBase + index + 1,
      compile: { success: true },
      validation: { validates: true },
      tests: { status: "measured", passed: 1, total: 1 },
    })),
  };
}

describe("npm-compat partial aggregation", () => {
  it("combines focused workers and keeps the popularity ordering", () => {
    const result = mergeNpmCompatPartials([partial(["acorn"]), partial(["react"], "source", 10)], {
      expectedNames: ["acorn", "react"],
      sourceRevision: "source",
      generatedAt: "2026-08-22T00:00:00.000Z",
    });

    expect(result.summary.packages.map((entry) => entry.name)).toEqual(["react", "acorn"]);
    expect(result.summary.generatedAt).toBe("2026-08-22T00:00:00.000Z");
    expect(result.perfHistory.runs).toHaveLength(1);
  });

  it("rebuilds the ES-edition rollup, which the sharded path would otherwise drop (#5279)", () => {
    // The partial report carries a trimmed `summaryMeta`, and this merge builds
    // the shipped summary itself — so a rollup added only to the single-process
    // generator is present locally and absent from every artifact CI publishes.
    const withEditions = {
      ...partial(["acorn", "react"]),
      packages: [
        { name: "acorn", compile: { success: true }, esEdition: { required: 2022 } },
        { name: "react", compile: { success: true }, esEdition: { required: 2021 } },
      ],
    };
    const result = mergeNpmCompatPartials([withEditions], {
      expectedNames: ["acorn", "react"],
      sourceRevision: "source",
    });

    expect(result.summary.esEditions.editions.map((entry: { label: string }) => entry.label)).toEqual([
      "ES2021",
      "ES2022",
    ]);
    expect(result.summary.esEditions.unclassified).toEqual([]);
  });

  it("rejects duplicate or missing package rows instead of publishing a partial dashboard", () => {
    expect(() =>
      mergeNpmCompatPartials([partial(["acorn"]), partial(["acorn"])], {
        expectedNames: ["acorn"],
        sourceRevision: "source",
      }),
    ).toThrow(/duplicate package acorn/);

    expect(() =>
      mergeNpmCompatPartials([partial(["acorn"])], {
        expectedNames: ["acorn", "react"],
        sourceRevision: "source",
      }),
    ).toThrow(/missing: react/);
  });

  it("rejects a worker that measured a different immutable source revision", () => {
    expect(() =>
      mergeNpmCompatPartials([partial(["acorn"], "old")], {
        expectedNames: ["acorn"],
        sourceRevision: "source",
      }),
    ).toThrow(/source revision mismatch/);
  });

  it("carries a failed worker forward without recording stale perf as a new run", () => {
    const previous = {
      ...partial(["react"], "old"),
      packages: [
        {
          ...partial(["react"], "old").packages[0],
          perf: {
            lanes: {
              jsHost: { status: "measured", ratio: 0.5 },
            },
          },
        },
      ],
    };
    const fresh = partial(["acorn"]);
    (fresh.packages[0] as any).perf = {
      lanes: {
        jsHost: { status: "measured", ratio: 2 },
      },
    };
    const result = mergeNpmCompatPartials([fresh], {
      expectedNames: ["acorn", "react"],
      sourceRevision: "source",
      existingPackages: previous.packages,
      existingSummaryMeta: previous.summaryMeta,
      existingGeneratedAt: "2026-08-21T00:00:00.000Z",
      allowStaleFallback: true,
      generatedAt: "2026-08-22T00:00:00.000Z",
    });

    expect(result.summary.refresh).toEqual({
      status: "partial",
      stalePackages: ["react"],
      freshCount: 1,
      totalCount: 2,
    });
    expect(result.summary.packages.find((entry) => entry.name === "react")?.refresh).toEqual({
      status: "stale",
      reason: "measurement worker did not produce a partial report",
      lastMeasuredAt: "2026-08-21T00:00:00.000Z",
    });
    // The perf ARTIFACT keeps the carried-forward row: react's card still shows
    // its last measurement, so the chart beside it must too.
    expect(result.perfRows.map((entry) => entry.name)).toEqual([
      "acorn · JS host · runtime dynamic",
      "react · JS host · runtime dynamic",
    ]);
    // The HISTORY point does not — a stale measurement must not be recorded as
    // having happened in this run.
    expect(result.perfHistory.runs.at(-1)?.packages).toEqual({
      acorn: { jsHost: { dynamic: 2 }, standalone: {} },
    });
  });

  it("still produces perf rows when the only fresh package failed to compile", () => {
    // The live failure (2026-08-24T02:31Z). react-dom's lane promotes on its
    // own 3-4h cadence, so a promotion legitimately carries ONE fresh package;
    // that run's three react-dom lanes were all `compile-error`. With perf rows
    // built from fresh packages only, `npm-compat-perf.json` came out `[]` and
    // `check-npm-compat-promotion.mjs` failed the `quality` gate with
    // "must contain performance measurements", stranding the promotion PR with
    // 23 packages' worth of perfectly good carried-forward measurements on it.
    const previous = partial(["acorn", "react"], "old");
    previous.packages = previous.packages.map((entry) => ({
      ...entry,
      perf: { lanes: { jsHost: { status: "measured", ratio: 1.5, wasmUs: 10, nodeUs: 15 } } },
    })) as typeof previous.packages;

    const fresh = partial(["react-dom"]);
    (fresh.packages[0] as any).perf = {
      lanes: {
        jsHost: { status: "compile-error" },
        standalone: { status: "compile-error" },
        standaloneDynamic: { status: "compile-error" },
      },
    };

    const result = mergeNpmCompatPartials([fresh], {
      expectedNames: ["acorn", "react", "react-dom"],
      sourceRevision: "source",
      existingPackages: previous.packages,
      existingSummaryMeta: previous.summaryMeta,
      existingGeneratedAt: "2026-08-21T00:00:00.000Z",
      allowStaleFallback: true,
      generatedAt: "2026-08-24T02:31:23.145Z",
    });

    expect(result.summary.refresh.freshCount).toBe(1);
    // Both carried-forward rows survive into the perf artifact — the exact
    // thing that was `[]` before. Order follows the report's popularity sort.
    expect(result.perfRows.map((entry) => entry.name)).toEqual([
      "react · JS host · runtime dynamic",
      "acorn · JS host · runtime dynamic",
    ]);
    // The history point carries no packages: the one package measured this run
    // produced no timing. Stale rows are not backdated into it.
    expect(result.perfHistory.runs.at(-1)?.packages).toEqual({});
  });

  it("keeps a stale row's OWN measurement time instead of creeping it forward each refresh", () => {
    // The regression this pins: `lastMeasuredAt` used to be taken from the
    // previous SNAPSHOT's generatedAt, so a package that stayed stale across
    // several promotions reported the most recent one as its measurement date.
    // With the fast lane promoting every ~12 min and react-dom's row running
    // 3-4 h, that is the ordinary case.
    const measuredLongAgo = {
      ...partial(["react"], "old").packages[0],
      measuredAt: "2026-08-20T18:44:00.000Z",
    };
    let existingPackages: any[] = [measuredLongAgo];
    let existingGeneratedAt = "2026-08-21T00:00:00.000Z";

    // Three consecutive fast-lane promotions, react-dom stale through all.
    for (const generatedAt of ["2026-08-22T00:00:00.000Z", "2026-08-22T12:00:00.000Z", "2026-08-23T00:00:00.000Z"]) {
      const result: any = mergeNpmCompatPartials([partial(["acorn"])], {
        expectedNames: ["acorn", "react"],
        sourceRevision: "source",
        existingPackages,
        existingGeneratedAt,
        allowStaleFallback: true,
        generatedAt,
      });
      existingPackages = result.summary.packages;
      existingGeneratedAt = result.summary.generatedAt;
    }

    const react = existingPackages.find((entry) => entry.name === "react");
    expect(react.measuredAt).toBe("2026-08-20T18:44:00.000Z");
    expect(react.refresh.lastMeasuredAt).toBe("2026-08-20T18:44:00.000Z");
  });

  it("migrates a pre-measuredAt stale row from refresh.lastMeasuredAt, not the snapshot time", () => {
    // The live 2026-08-23 artifact: react-dom already stale, its real date only
    // in refresh.lastMeasuredAt because per-package stamping did not exist yet.
    // Falling back to existingGeneratedAt here commits the creep ONCE and
    // permanently — the real date is then unrecoverable by any later run.
    const legacyStale = {
      ...partial(["react"], "old").packages[0],
      refresh: {
        status: "stale",
        reason: "worker failed",
        lastMeasuredAt: "2026-08-20T18:44:18.260Z",
      },
    };
    const result: any = mergeNpmCompatPartials([partial(["acorn"])], {
      expectedNames: ["acorn", "react"],
      sourceRevision: "source",
      existingPackages: [legacyStale],
      existingGeneratedAt: "2026-08-23T15:27:53.137Z",
      allowStaleFallback: true,
      generatedAt: "2026-08-23T17:00:00.000Z",
    });

    const react = result.summary.packages.find((entry: any) => entry.name === "react");
    expect(react.measuredAt).toBe("2026-08-20T18:44:18.260Z");
    expect(react.refresh.lastMeasuredAt).toBe("2026-08-20T18:44:18.260Z");
  });

  it("stamps fresh rows and reports the measured range across a mixed-age corpus", () => {
    const stale = {
      ...partial(["react"], "old").packages[0],
      measuredAt: "2026-08-20T18:44:00.000Z",
    };
    const result: any = mergeNpmCompatPartials([partial(["acorn"])], {
      expectedNames: ["acorn", "react"],
      sourceRevision: "source",
      existingPackages: [stale],
      allowStaleFallback: true,
      generatedAt: "2026-08-23T15:27:00.000Z",
    });

    // A fresh row with no stamp of its own was measured in this run.
    expect(result.summary.packages.find((entry: any) => entry.name === "acorn").measuredAt).toBe(
      "2026-08-23T15:27:00.000Z",
    );
    expect(result.summary.measuredRange).toEqual({
      oldest: "2026-08-20T18:44:00.000Z",
      newest: "2026-08-23T15:27:00.000Z",
    });
    expect(result.summary.refresh.freshCount).toBe(1);
    expect(result.summary.refresh.totalCount).toBe(2);
  });

  it("can publish the prior complete snapshot when every worker fails", () => {
    const previous = partial(["acorn", "react"], "old");
    const result = mergeNpmCompatPartials([], {
      expectedNames: ["acorn", "react"],
      sourceRevision: "source",
      existingPackages: previous.packages,
      existingSummaryMeta: previous.summaryMeta,
      existingGeneratedAt: "2026-08-21T00:00:00.000Z",
      allowStaleFallback: true,
      generatedAt: "2026-08-22T00:00:00.000Z",
    });

    expect(result.summary.packages).toHaveLength(2);
    expect(result.summary.refresh.stalePackages).toEqual(["acorn", "react"]);
    expect(result.perfHistory.runs).toHaveLength(0);
  });
});

describe("npm-compat refresh matrix wiring", () => {
  it("measures every package independently and publishes a lane after a worker failure", () => {
    // The per-package split (2026-08-23) moved the coordinator into its own
    // reusable workflow and replaced the hardcoded package GROUPS with
    // catalog-planned matrices, so these guards read both files. The
    // group-era assertions this replaces (`id: typescript`, `packages:
    // react-dom`, one `needs: measure`) described a shape that no longer
    // exists — they broke the moment the split landed.
    const refresh = readFileSync(new URL("../.github/workflows/npm-compat-refresh.yml", import.meta.url), "utf8");
    const promote = readFileSync(new URL("../.github/workflows/npm-compat-promote.yml", import.meta.url), "utf8");

    expect(refresh).toContain("github.repository == 'loopdive/js2'");
    expect(refresh).toContain("fail-fast: false");

    // Per-PACKAGE serialization: each row coalesces on its own queue, so a
    // slow or failing package never delays another package's measurement.
    expect(refresh).toContain("group: npm-compat-pkg-${{ matrix.package }}");
    expect(refresh).toMatch(/concurrency:[\s\S]*?cancel-in-progress: false/);

    // Matrices are planned from the catalog at run time — adding a package
    // must never require a YAML edit.
    expect(refresh).toContain("scripts/list-npm-compat-packages.mjs");
    expect(refresh).toContain("fromJSON(needs.resolve.outputs.fast_packages)");
    expect(refresh).toContain("fromJSON(needs.resolve.outputs.slow_packages)");
    expect(refresh).not.toContain("id: typescript");
    expect(refresh).not.toContain("id: renderers");

    // Two lanes, each promoting on its own cadence — and NEITHER gated on the
    // measure job's aggregate result. A matrix job reports `cancelled` when ANY
    // row cancels, so gating on it made one superseded package discard every
    // other package's completed work: run 822 (2026-08-23) threw away lit's
    // successful 29-minute measurement because react-dom's row was cancelled
    // 17 minutes in. The coordinator recognises "this lane measured nothing"
    // itself, by counting partial reports.
    expect(refresh).not.toContain("needs.measure-fast.result != 'cancelled'");
    expect(refresh).not.toContain("needs.measure-slow.result != 'cancelled'");
    expect(promote).toContain("Stop if this lane produced no measurements");
    expect(promote).toContain("steps.partials.outputs.count != '0'");
    expect(refresh).toContain("uses: ./.github/workflows/npm-compat-promote.yml");
    expect(refresh).toContain("--partial-output");
    expect(refresh).toContain("if-no-files-found: warn");
    expect(refresh).toContain("DOGFOOD_REACT_DOM_PROJECT_CONCURRENCY: 2");

    // Do not MEASURE what cannot be published: a run started while a promotion
    // PR is open would spend ~24 runners for ~15 minutes on an artifact the
    // coordinator then refuses to push. The gate lives in `resolve` so it costs
    // one 30-second job instead.
    expect(refresh).toContain("Is a promotion PR already open?");
    expect(refresh).toContain("needs.resolve.outputs.promotion_pr == ''");

    expect(promote).toContain("actions/download-artifact@v7");
    expect(promote).toContain("continue-on-error: true");
    expect(promote).toContain("scripts/merge-npm-compat-partials.mjs");
  });

  it("keeps the renamed repository guards active for refresh promotion", () => {
    const refresh = readFileSync(new URL("../.github/workflows/npm-compat-refresh.yml", import.meta.url), "utf8");
    const staleness = readFileSync(new URL("../.github/workflows/npm-compat-staleness.yml", import.meta.url), "utf8");
    const enqueue = readFileSync(new URL("../.github/workflows/auto-enqueue.yml", import.meta.url), "utf8");

    for (const workflow of [refresh, staleness, enqueue]) {
      expect(workflow).toContain("github.repository == 'loopdive/js2'");
    }
  });

  it("never force-updates the promotion branch while its PR is open", () => {
    // See issue-4130-npm-compat-refresh-staleness-gate.test.ts for the full
    // history. Short version: the old "push if it looks idle" guard lost a
    // race it now ran several times an hour, and froze the dashboard for six
    // hours behind green CI.
    const workflow = readFileSync(new URL("../.github/workflows/npm-compat-promote.yml", import.meta.url), "utf8");

    expect(workflow).toContain("Skip the push while a promotion PR is open");
    expect(workflow).not.toContain("mergeQueue(branch:");
    expect(workflow).not.toContain("check-runs?per_page=100");
    expect(workflow).toContain('echo "skip=1" >> "$GITHUB_OUTPUT"');
  });

  it("keeps the generic behind-PR sweep away from the npm promotion branch", () => {
    const autoRefresh = readFileSync(new URL("../.github/workflows/auto-refresh-prs.yml", import.meta.url), "utf8");

    expect(autoRefresh).toContain("headRefName");
    expect(autoRefresh).toContain('select(.headRefName != "ci/npm-compat-refresh")');
  });
});
