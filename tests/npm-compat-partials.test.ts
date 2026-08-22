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
});

describe("npm-compat refresh matrix wiring", () => {
  it("measures independent groups and assembles only after every group succeeds", () => {
    const workflow = readFileSync(new URL("../.github/workflows/npm-compat-refresh.yml", import.meta.url), "utf8");

    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain(
      "group: npm-compat-refresh-${{ github.event_name == 'push' && github.sha || github.ref }}",
    );
    expect(workflow).toMatch(/concurrency:[\s\S]*?cancel-in-progress: false/);
    expect(workflow).toContain("needs: measure");
    expect(workflow).toContain("--partial-output");
    expect(workflow).toContain("actions/download-artifact@v7");
    expect(workflow).toContain("scripts/merge-npm-compat-partials.mjs");
    expect(workflow).toContain("id: typescript");
  });

  it("does not force-update a promotion PR while its checks are in flight", () => {
    const workflow = readFileSync(new URL("../.github/workflows/npm-compat-refresh.yml", import.meta.url), "utf8");

    expect(workflow).toContain("headRefOid");
    expect(workflow).toContain("/commits/${PR_HEAD_SHA}/check-runs?per_page=100");
    expect(workflow).toContain("leaving its branch untouched to avoid cancelling CI");
    expect(workflow).toContain("CHECK_CUTOFF");
    expect(workflow).toContain('echo "skip=1" >> "$GITHUB_OUTPUT"');
  });
});
