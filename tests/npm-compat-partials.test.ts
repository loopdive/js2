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
    expect(result.perfRows.map((entry) => entry.name)).toEqual(["acorn · JS host · runtime dynamic"]);
    expect(result.perfHistory.runs.at(-1)?.packages).toEqual({
      acorn: { jsHost: { dynamic: 2 }, standalone: {} },
    });
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

    // Two lanes, each promoting on its own cadence.
    expect(refresh).toContain("needs.measure-fast.result != 'cancelled'");
    expect(refresh).toContain("needs.measure-slow.result != 'cancelled'");
    expect(refresh).toContain("uses: ./.github/workflows/npm-compat-promote.yml");
    expect(refresh).toContain("--partial-output");
    expect(refresh).toContain("if-no-files-found: warn");
    expect(refresh).toContain("DOGFOOD_REACT_DOM_PROJECT_CONCURRENCY: 2");

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

  it("does not force-update a promotion PR while its checks are in flight", () => {
    // Lives in the reusable coordinator since the per-package split.
    const workflow = readFileSync(new URL("../.github/workflows/npm-compat-promote.yml", import.meta.url), "utf8");

    expect(workflow).toContain("headRefOid");
    expect(workflow).toContain("--paginate");
    expect(workflow).toContain("awk '{ total += $1 } END { print total + 0 }'");
    expect(workflow).not.toContain("--slurp");
    expect(workflow).toContain("/commits/${PR_HEAD_SHA}/check-runs?per_page=100");
    expect(workflow).toContain("leaving its branch untouched to avoid cancelling CI");
    expect(workflow).toContain("Do not age this guard out");
    expect(workflow).not.toContain("CHECK_CUTOFF");
    expect(workflow).toContain('echo "skip=1" >> "$GITHUB_OUTPUT"');
  });

  it("keeps the generic behind-PR sweep away from the npm promotion branch", () => {
    const autoRefresh = readFileSync(new URL("../.github/workflows/auto-refresh-prs.yml", import.meta.url), "utf8");

    expect(autoRefresh).toContain("headRefName");
    expect(autoRefresh).toContain('select(.headRefName != "ci/npm-compat-refresh")');
  });
});
