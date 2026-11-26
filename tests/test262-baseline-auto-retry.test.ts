import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const WORKFLOW = readFileSync(resolve(ROOT, ".github/workflows/retry-test262-baseline.yml"), "utf8");

describe("Test262 baseline promotion retries", () => {
  it("uses one retry controller for both canonical baseline workflows", () => {
    expect(WORKFLOW).toContain('workflows: ["Test262 Sharded", "Baseline Refresh (manual + emergency)"]');
    expect(WORKFLOW).toContain("actions: write");
    expect(WORKFLOW).toContain("github.event.workflow_run.head_branch == 'main'");
  });

  it("retries bounded mainline failures without touching measurement runs", () => {
    expect(WORKFLOW).toContain("github.event.workflow_run.run_attempt < 3");
    expect(WORKFLOW).toContain(
      "github.event.workflow_run.name == 'Test262 Sharded' && github.event.workflow_run.event == 'schedule'",
    );
    expect(WORKFLOW).toContain("github.event.workflow_run.event == 'schedule'");
    expect(WORKFLOW).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
  });

  it("treats both full-run shard matrices as retryable, and nothing else (#7551)", () => {
    const bash = /\[\[ ! "\$job_name" =~ (.+?) \]\]/.exec(WORKFLOW)?.[1];
    expect(bash, "shard-name pattern not found").toBeDefined();
    // Bash ERE with escaped spaces -> the same pattern as a JS RegExp.
    const shard = new RegExp(bash!.replace(/\\ /g, " "));
    for (const name of [
      "test262 standalone shard 7",
      "test262 js-host shard 12",
      "test262 IR standalone measurement shard 102",
    ])
      expect(shard.test(name), name).toBe(true);
    for (const name of [
      "merge shard reports",
      "merge complete IR standalone measurement",
      "test262 standalone shard x",
    ])
      expect(shard.test(name), name).toBe(false);
  });

  it("reruns only failed shard cells and leaves semantic failures for diagnosis", () => {
    expect(WORKFLOW).toContain("Non-shard failure is not auto-retryable");
    expect(WORKFLOW).toContain("/rerun-failed-jobs");
  });
});
