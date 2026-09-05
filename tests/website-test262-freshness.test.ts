import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

function readRepo(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("website Test262 pass-rate freshness", () => {
  it("builds report data from the canonical current snapshots before public mirrors", () => {
    const buildPages = readRepo("scripts/build-pages.js");

    const hostCurrent = buildPages.indexOf('join(BENCHMARKS_RESULTS_DIR, "test262-current.json")');
    const hostPublic = buildPages.indexOf('join(PUBLIC_BENCH, "test262-report.json")');
    const standaloneCurrent = buildPages.indexOf('join(BENCHMARKS_RESULTS_DIR, "test262-standalone-current.json")');
    const standalonePublic = buildPages.indexOf('join(PUBLIC_BENCH, "test262-standalone-report.json")');

    expect(hostCurrent).toBeGreaterThanOrEqual(0);
    expect(hostPublic).toBeGreaterThan(hostCurrent);
    expect(standaloneCurrent).toBeGreaterThanOrEqual(0);
    expect(standalonePublic).toBeGreaterThan(standaloneCurrent);
  });

  it("keeps the checked-in Vite report mirrors on the same baseline as current", () => {
    const currentHost = JSON.parse(readRepo("benchmarks/results/test262-current.json"));
    const servedHost = JSON.parse(readRepo("website/public/benchmarks/results/test262-report.json"));
    const currentStandalone = JSON.parse(readRepo("benchmarks/results/test262-standalone-current.json"));
    const servedStandalone = JSON.parse(readRepo("website/public/benchmarks/results/test262-standalone-report.json"));

    expect(servedHost.baseline_sha).toBe(currentHost.baseline_sha);
    expect(servedHost.summary).toEqual(currentHost.summary);
    expect(servedStandalone.baseline_sha).toBe(currentStandalone.baseline_sha);
    expect(servedStandalone.summary).toEqual(currentStandalone.summary);
  });

  it("refreshes and stages the Vite-served report in every baseline promotion path", () => {
    for (const workflowPath of [
      ".github/workflows/test262-sharded.yml",
      ".github/workflows/refresh-baseline.yml",
      ".github/workflows/baseline-summary-sync.yml",
    ]) {
      const workflow = readRepo(workflowPath);
      expect(workflow).toContain("website/public/benchmarks/results/test262-report.json");
      expect(workflow).toContain("website/public/benchmarks/results/test262-standalone-report.json");
    }
  });

  it("uses one shared mirror synchronizer for every report-producing workflow", () => {
    const syncScript = readRepo("scripts/sync-test262-report-mirrors.mjs");
    expect(syncScript).toContain('"benchmarks/results/test262-current.json"');
    expect(syncScript).toContain('"benchmarks/results/test262-standalone-current.json"');

    for (const workflowPath of [
      ".github/workflows/test262-sharded.yml",
      ".github/workflows/refresh-baseline.yml",
      ".github/workflows/baseline-summary-sync.yml",
      ".github/workflows/deploy-pages.yml",
    ]) {
      expect(readRepo(workflowPath)).toContain("node scripts/sync-test262-report-mirrors.mjs");
    }
  });

  it("does not skip a promotion while a served mirror is stale", () => {
    const sync = readRepo(".github/workflows/baseline-summary-sync.yml");
    const sharded = readRepo(".github/workflows/test262-sharded.yml");

    expect(sync).toContain("WEBSITE_HOST_UNCHANGED");
    expect(sync).toContain("WEBSITE_STANDALONE_UNCHANGED");
    expect(sharded).toContain("WEBSITE_HOST_REPORT_UNCHANGED");
    expect(sharded).toContain("WEBSITE_STANDALONE_REPORT_UNCHANGED");
  });

  it("dispatches Pages after the queue-only baseline promotion", () => {
    const workflow = readRepo(".github/workflows/test262-sharded.yml");
    const queueJobStart = workflow.indexOf("  write-run-cache-bot:");
    expect(queueJobStart).toBeGreaterThanOrEqual(0);

    const queueJob = workflow.slice(queueJobStart);
    expect(queueJob).toContain("actions: write");
    expect(queueJob).toContain("gh workflow run deploy-pages.yml --ref main");
  });

  it("gives scheduled and sharded promotions permission to dispatch Pages", () => {
    const sharded = readRepo(".github/workflows/test262-sharded.yml");
    const promoteStart = sharded.indexOf("  promote-baseline:");
    const queueStart = sharded.indexOf("  write-run-cache-bot:", promoteStart);
    expect(promoteStart).toBeGreaterThanOrEqual(0);
    expect(queueStart).toBeGreaterThan(promoteStart);
    expect(sharded.slice(promoteStart, queueStart)).toContain("actions: write");
    expect(readRepo(".github/workflows/refresh-baseline.yml")).toContain("actions: write");
  });
});
