import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { mergeNpmCompatPartials } from "../scripts/lib/npm-compat-partials.mjs";

function partial(names: string[], sourceRevision = "source", downloadBase = 0) {
  return {
    sourceRevision,
    summaryMeta: {
      note: "test",
      popularity: { metric: "weekly npm downloads" },
      performanceMethodology: { optimizationLevels: { "js-host": 4, standalone: 4 } },
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

    expect(result.summary.refresh).toEqual({ status: "partial", stalePackages: ["react"] });
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
  it("measures independent groups and publishes successful groups after a worker failure", () => {
    const workflow = readFileSync(new URL("../.github/workflows/npm-compat-refresh.yml", import.meta.url), "utf8");

    expect(workflow).toContain("github.repository == 'loopdive/js2'");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain(
      "group: npm-compat-refresh-${{ github.event_name == 'push' && github.sha || format('{0}-{1}', github.ref, github.run_id) }}",
    );
    expect(workflow).toMatch(/concurrency:[\s\S]*?cancel-in-progress: false/);
    expect(workflow).toContain("needs: measure");
    expect(workflow).toContain("always() && needs.measure.result != 'cancelled'");
    expect(workflow).toContain("--partial-output");
    expect(workflow).toContain("actions/download-artifact@v7");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("if-no-files-found: warn");
    expect(workflow).toContain("scripts/merge-npm-compat-partials.mjs");
    expect(workflow).toContain("id: typescript");
    expect(workflow).toContain("id: react-dom");
    expect(workflow).toContain("packages: react-dom");
    expect(workflow).toContain('DOGFOOD_REACT_DOM_PROJECT_CONCURRENCY: "2"');
    expect(workflow).not.toContain("id: renderers");
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
    const workflow = readFileSync(new URL("../.github/workflows/npm-compat-refresh.yml", import.meta.url), "utf8");

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
