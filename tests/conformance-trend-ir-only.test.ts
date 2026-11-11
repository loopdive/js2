// The standalone IR-only lane on the conformance trend graph: the share of
// test262 tests that pass with every unit compiled by the IR (no legacy
// fallback). The history only carries `ir_only_pass` from the first run after
// it was recorded, so the lane must start there — not ramp up from zero at the
// project's start — and must keep a low rate the pass-rate lanes would drop.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module without type declarations
import * as trend from "../website/components/t262-conformance-trend.js";

const { t262BuildHistoryPoints, t262MergeConformanceLanes } = trend as any;

const irOnly = (run: any) =>
  run?.ir_only_pass === undefined ? null : { pass: run.ir_only_pass, total: run.total, timestampRaw: run.timestamp };
const IR_ONLY_OPTIONS = { minRate: 0, anchorAtProjectStart: false };

describe("standalone IR-only trend lane", () => {
  const runs = [
    { timestamp: "2026-11-01T00:00:00Z", pass: 42000, total: 48232 },
    { timestamp: "2026-11-07T00:00:00Z", pass: 42400, total: 48232, ir_only_pass: 1190 },
    { timestamp: "2026-11-08T00:00:00Z", pass: 42450, total: 48232, ir_only_pass: 1824 },
  ];

  it("starts at its first recorded run and keeps a rate below 5%", () => {
    const points = t262BuildHistoryPoints(runs, irOnly, IR_ONLY_OPTIONS);
    expect(points[0].timestamp).toBe("2026-11-07T00:00:00Z");
    expect(points[0].pass).toBe(1190);
    expect(points.every((p: any) => p.pass > 0)).toBe(true);
  });

  it("is null before its first run in the merged series", () => {
    const standalone = t262BuildHistoryPoints(runs, (run: any) => ({
      pass: run.pass,
      total: run.total,
      timestampRaw: run.timestamp,
    }));
    const merged = t262MergeConformanceLanes({
      standaloneRate: standalone,
      irOnlyRate: t262BuildHistoryPoints(runs, irOnly, IR_ONLY_OPTIONS),
    });
    const before = merged.filter((p: any) => p.time < new Date("2026-11-07T00:00:00Z").getTime());
    expect(before.length).toBeGreaterThan(0);
    for (const p of before) expect(p.irOnlyRate).toBeNull();
    expect(merged.at(-1).irOnlyRate).toBeCloseTo((1824 / 48232) * 100);
  });
});

describe("append-run-history records ir_only_pass", () => {
  const append = (dir: string, summary: Record<string, number>) => {
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify({ summary }));
    execFileSync(process.execPath, [
      "scripts/append-run-history.mjs",
      "--runs-dir",
      dir,
      "--standalone-report",
      report,
      "--sha",
      "abc",
    ]);
    return JSON.parse(readFileSync(join(dir, "standalone-index.json"), "utf8"));
  };

  it("stores it, and appends a run whose only change is the IR-only count", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-history-"));
    append(dir, { pass: 100, total: 200, ir_only_pass: 10 });
    const index = append(dir, { pass: 100, total: 200, ir_only_pass: 12 });
    expect(index.map((e: any) => e.ir_only_pass)).toEqual([10, 12]);
  });

  it("omits it when the report did not measure it", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-history-"));
    expect(append(dir, { pass: 100, total: 200 })[0]).not.toHaveProperty("ir_only_pass");
  });
});
