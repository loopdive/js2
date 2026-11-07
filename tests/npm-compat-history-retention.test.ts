// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The npm-compat perf charts read `benchmarks/results/npm-compat-history.json`,
// which ACCUMULATES one point per refresh. It stopped accumulating: from
// 2026-08-08 to 2026-08-11 the file was rewritten on every refresh and stayed
// at exactly 14 runs, the newest one replacing its predecessor, so the charts
// showed thirteen points from July and a single point from August with a
// twelve-day hole between them. The file kept changing, so nothing looked
// broken.
//
// The cause was one overloaded field. `sourceRevision` means "the commit this
// run was measured at", and the merge uses it as a secondary identity so that
// re-running the generator at an unchanged HEAD replaces its own point instead
// of appending a second one. The git backfill was tagging points with the
// commit that COMMITTED the measurement under that same name — and the refresh
// workflow checks out `fetch-depth: 1`, so that commit is always HEAD. Each
// refresh therefore re-keyed the previous run onto the current HEAD, where the
// live point (also HEAD) matched it and overwrote it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeNpmPerfHistory, npmPerfHistoryPoint } from "../scripts/lib/npm-compat-perf.mjs";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const HISTORY_PATH = resolve(ROOT, "benchmarks", "results", "npm-compat-history.json");
const PUBLIC_HISTORY_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "npm-compat-history.json");

const snapshot = (ratio: number) => ({ acorn: { jsHost: { dynamic: ratio }, standalone: { dynamic: ratio } } });

/** One refresh cycle as CI actually runs it (`fetch-depth: 1`). */
function refreshCycle(history: unknown, head: string, generatedAt: string) {
  const runs = (history as { runs: Array<{ generatedAt: string; packages: unknown }> }).runs;
  const previous = runs.at(-1)!;
  return mergeNpmPerfHistory(history, [
    // The backfill re-reads the artifact committed at HEAD, which holds the
    // PREVIOUS run's measurement.
    { generatedAt: previous.generatedAt, recordedIn: head, packages: previous.packages },
    // The freshly measured point, at the same HEAD.
    { generatedAt, sourceRevision: head, packages: snapshot(2) },
  ]);
}

describe("npm-compat perf history retention", () => {
  it("keeps every run across consecutive refresh cycles", () => {
    let history: any = {
      schemaVersion: 1,
      runs: [{ generatedAt: "2026-08-08T10:00:00.000Z", sourceRevision: "measured0", packages: snapshot(1) }],
    };

    for (let cycle = 1; cycle <= 5; cycle++) {
      history = refreshCycle(history, `head${cycle}`, `2026-08-08T1${cycle}:00:00.000Z`);
    }

    expect(history.runs).toHaveLength(6);
    expect(history.runs.map((run: any) => run.generatedAt)).toEqual([
      "2026-08-08T10:00:00.000Z",
      "2026-08-08T11:00:00.000Z",
      "2026-08-08T12:00:00.000Z",
      "2026-08-08T13:00:00.000Z",
      "2026-08-08T14:00:00.000Z",
      "2026-08-08T15:00:00.000Z",
    ]);
  });

  it("does not let a backfilled point re-key an existing run onto the recording commit", () => {
    // The exact shape that deleted a run: the backfill claims HEAD as the
    // measurement's own source revision, so the live point for HEAD then
    // matches the old run and replaces it.
    const history = {
      schemaVersion: 1,
      runs: [{ generatedAt: "2026-08-10T22:31:00.000Z", sourceRevision: "measured-at", packages: snapshot(1) }],
    };
    const merged: any = mergeNpmPerfHistory(history, [
      { generatedAt: "2026-08-10T22:31:00.000Z", recordedIn: "HEAD", packages: snapshot(1) },
      { generatedAt: "2026-08-11T03:22:00.000Z", sourceRevision: "HEAD", packages: snapshot(2) },
    ]);

    expect(merged.runs).toHaveLength(2);
    // Provenance is fixed at measurement time — the recording commit is
    // recorded alongside it, never in its place.
    expect(merged.runs[0].sourceRevision).toBe("measured-at");
    expect(merged.runs[0].recordedIn).toBe("HEAD");
  });

  it("still collapses a re-measurement at an unchanged source revision", () => {
    // This is what `sourceRevision` dedup is FOR: running the generator twice
    // at the same commit is one data point, not two.
    const merged: any = mergeNpmPerfHistory(
      {
        schemaVersion: 1,
        runs: [{ generatedAt: "2026-08-11T01:00:00.000Z", sourceRevision: "abc", packages: snapshot(1) }],
      },
      [{ generatedAt: "2026-08-11T02:00:00.000Z", sourceRevision: "abc", packages: snapshot(2) }],
    );

    expect(merged.runs).toHaveLength(1);
    expect(merged.runs[0].generatedAt).toBe("2026-08-11T02:00:00.000Z");
    expect(merged.runs[0].packages.acorn.jsHost.dynamic).toBe(2);
  });

  it("unions another copy of the artifact additively", () => {
    // What `scripts/merge-npm-compat-history.mjs` relies on when the refresh
    // force-pushes its reused promotion branch: a run that exists only in the
    // pending copy must survive.
    const ours = {
      schemaVersion: 1,
      runs: [{ generatedAt: "2026-08-11T01:00:00.000Z", sourceRevision: "a", packages: snapshot(1) }],
    };
    const pending = [{ generatedAt: "2026-08-11T02:00:00.000Z", sourceRevision: "b", packages: snapshot(2) }];

    const merged: any = mergeNpmPerfHistory(ours, pending);
    expect(merged.runs.map((run: any) => run.generatedAt)).toEqual([
      "2026-08-11T01:00:00.000Z",
      "2026-08-11T02:00:00.000Z",
    ]);
    // Idempotent: unioning the same copy again changes nothing.
    expect(mergeNpmPerfHistory(merged, pending).runs).toHaveLength(2);
  });

  it("ships a committed history the charts can actually plot", () => {
    const history = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
    const runs = history.runs as Array<{ generatedAt: string; packages: Record<string, unknown> }>;

    // A floor, not a target. The symptom of the bug was a run count that never
    // moved; one point per package draws nothing.
    expect(runs.length).toBeGreaterThanOrEqual(20);

    const stamps = runs.map((run) => run.generatedAt);
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
    expect(runs.every((run) => Object.keys(run.packages ?? {}).length > 0)).toBe(true);

    // The page is served from `website/public/`, so a drifted twin means the
    // dashboard renders history nobody can see in the source artifact.
    expect(readFileSync(PUBLIC_HISTORY_PATH, "utf-8")).toBe(readFileSync(HISTORY_PATH, "utf-8"));
  });
});

// The merge can only defend what it is handed. The two producers of history
// points are pinned structurally — same approach as
// issue-4130-npm-compat-refresh-staleness-gate.test.ts, because when either
// regresses the run still exits 0 and the loss is silent.
const executable = (source: string) =>
  source
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/|\*)/.test(line))
    .join("\n");

describe("npm-compat history producers", () => {
  it("labels git-backfilled points with the recording commit, not the source revision", () => {
    const generator = readFileSync(resolve(ROOT, "scripts", "generate-npm-compat-report.mjs"), "utf-8");
    const start = generator.indexOf("function committedHistoryPoints");
    const backfill = executable(generator.slice(start, generator.indexOf("function currentRevision", start)));

    expect(start).toBeGreaterThan(-1);
    expect(backfill).toContain("recordedIn: revision");
    // `npmPerfHistoryPoint(pkgs, generatedAt, revision)` is the call that froze
    // the history: its third parameter IS `sourceRevision`.
    expect(backfill).not.toMatch(/npmPerfHistoryPoint\([^)]*,[^)]*,[^)]*revision/);
  });

  it("unions the pending and landed copies before force-updating the promotion branch", () => {
    let workflow = executable(readFileSync(resolve(ROOT, ".github/workflows/npm-compat-refresh.yml"), "utf-8"));
    const reusablePromotion = /^\s+uses:\s+\.\/\.github\/workflows\/npm-compat-promote\.yml\s*$/m;
    if (reusablePromotion.test(workflow)) {
      // Follow only the real reusable promotion edge; older workflows remain inline.
      expect(workflow).toMatch(reusablePromotion);
      workflow = executable(readFileSync(resolve(ROOT, ".github/workflows/npm-compat-promote.yml"), "utf-8"));
    }
    const union = workflow.indexOf("scripts/merge-npm-compat-history.mjs");
    const commit = workflow.indexOf('git add -f -- "${ARTIFACTS[@]}"');

    // The branch is reused and force-pushed, so anything it carries that our
    // measurement predates is deleted unless it is merged in first.
    expect(union).toBeGreaterThan(-1);
    expect(union).toBeLessThan(commit);
    expect(workflow).toContain('for REF in deploykey/main "deploykey/${PROMOTION_BRANCH}"');
  });
});

// Fast and long-pole lanes can publish different measurements of one revision.
// Exercise the coordinator and the subsequent pending/main history union.
import { mergeNpmCompatPartials } from "../scripts/lib/npm-compat-partials.mjs";

const laneRevision = "40007cf98a3c2fb34e21a3830b19996e8bcf4423";
const slowStamp = "2026-11-06T00:06:00.329Z";
const fastStamp = "2026-11-06T00:22:02.486Z";
const preserveMeasurements = { preserveDistinctMeasurements: true };

function lanePackage(name: string, ratio: number, measuredAt: string) {
  return {
    name,
    measuredAt,
    correctness: { status: "verified" },
    perf: { lanes: { jsHost: { status: "measured", ratio, wasmUs: 1, nodeUs: ratio } } },
  };
}

function assembleBothLanes() {
  const slow = mergeNpmCompatPartials(
    [{ sourceRevision: laneRevision, packages: [lanePackage("react-dom", 1, slowStamp)] }],
    {
      sourceRevision: laneRevision,
      generatedAt: slowStamp,
      expectedNames: ["acorn", "react-dom"],
      existingPackages: [lanePackage("acorn", 2, "2026-11-05T23:00:00.000Z")],
      allowStaleFallback: true,
    },
  );
  const fast = mergeNpmCompatPartials(
    [{ sourceRevision: laneRevision, packages: [lanePackage("acorn", 3, fastStamp)] }],
    {
      sourceRevision: laneRevision,
      generatedAt: fastStamp,
      expectedNames: ["acorn", "react-dom"],
      existingPackages: slow.summary.packages,
      existingHistory: slow.perfHistory,
      allowStaleFallback: true,
    },
  );
  return { slow, fast };
}

describe("npm-compat independent lane measurement identity", () => {
  it("retains both timestamped measurements and keeps carried-forward packages out of the new point", () => {
    const { slow, fast } = assembleBothLanes();
    expect(fast.perfHistory.runs).toHaveLength(2);
    expect(fast.perfHistory.runs[0]).toEqual(slow.perfHistory.runs[0]);
    expect(fast.perfHistory.runs[1]).toMatchObject({
      generatedAt: fast.summary.generatedAt,
      sourceRevision: laneRevision,
      packages: { acorn: { jsHost: { dynamic: 3 } } },
    });
    expect(Object.keys(fast.perfHistory.runs[1].packages)).toEqual(["acorn"]);
    expect(fast.summary.packages.find((row: any) => row.name === "react-dom")?.measuredAt).toBe(slowStamp);
  });

  it("cannot replace the newer measurement when an older main or pending copy is unioned afterward", () => {
    const { slow, fast } = assembleBothLanes();
    const before = JSON.stringify({ slow, fast });
    const union = mergeNpmPerfHistory(fast.perfHistory, slow.perfHistory.runs, preserveMeasurements);
    expect(union).toEqual(fast.perfHistory);
    expect(mergeNpmPerfHistory(slow.perfHistory, fast.perfHistory.runs, preserveMeasurements)).toEqual(union);
    expect(mergeNpmPerfHistory(union, fast.perfHistory.runs, preserveMeasurements)).toEqual(union);
    expect(JSON.stringify({ slow, fast })).toBe(before);
  });

  it("does not invent a new history measurement when every package is carried forward", () => {
    const { fast } = assembleBothLanes();
    const stale = mergeNpmCompatPartials([], {
      sourceRevision: laneRevision,
      generatedAt: "2026-11-06T00:30:00.000Z",
      expectedNames: ["acorn", "react-dom"],
      existingPackages: fast.summary.packages,
      existingHistory: fast.perfHistory,
      allowStaleFallback: true,
    });
    expect(stale.summary.refresh.freshCount).toBe(0);
    expect(stale.perfHistory).toEqual(fast.perfHistory);
  });
});

describe("npm-compat mixed-age committed report backfill", () => {
  it("derives only fresh measurements from a mixed-age report", () => {
    const fresh = lanePackage("acorn", 3, fastStamp);
    const stale = { ...lanePackage("react-dom", 1, slowStamp), refresh: { status: "stale" } };
    const point = npmPerfHistoryPoint([fresh, stale], fastStamp);
    expect(Object.keys(point.packages)).toEqual(["acorn"]);
    expect(point.packages.acorn.jsHost.dynamic).toBe(3);
    expect(npmPerfHistoryPoint([stale], fastStamp).packages).toEqual({});
  });

  it.each([laneRevision, undefined])(
    "keeps an existing timestamp's measurement on backfill replay (provenance %s)",
    (sourceRevision) => {
      const original = {
        generatedAt: fastStamp,
        ...(sourceRevision ? { sourceRevision } : {}),
        packages: { acorn: { jsHost: { dynamic: 3 }, standalone: {} } },
      };
      const replay = {
        generatedAt: fastStamp,
        recordedIn: "a-recording-commit",
        packages: { acorn: { jsHost: { dynamic: 99 } }, "react-dom": { jsHost: { dynamic: 1 } } },
      };
      const before = JSON.stringify(original);
      const result = mergeNpmPerfHistory({ schemaVersion: 1, runs: [original] }, [replay], preserveMeasurements);
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].packages).toEqual(original.packages);
      expect(result.runs[0].sourceRevision).toBe(sourceRevision);
      expect(result.runs[0].recordedIn).toBe("a-recording-commit");
      expect(JSON.stringify(original)).toBe(before);
    },
  );
});
