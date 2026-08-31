import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const WORKFLOW = readFileSync(resolve(ROOT, ".github/workflows/retry-test262-baseline.yml"), "utf8");

describe("Test262 baseline promotion retries", () => {
  it("uses one retry controller for both canonical baseline workflows", () => {
    expect(WORKFLOW).toContain('workflows: ["Test262 Sharded", "Baseline Refresh (scheduled + emergency)"]');
    expect(WORKFLOW).toContain("actions: write");
    expect(WORKFLOW).toContain("github.event.workflow_run.head_branch == 'main'");
  });

  it("retries bounded mainline failures without touching measurement runs", () => {
    expect(WORKFLOW).toContain("github.event.workflow_run.run_attempt < 3");
    expect(WORKFLOW).toContain(
      "github.event.workflow_run.name == 'Test262 Sharded' && github.event.workflow_run.event == 'push'",
    );
    expect(WORKFLOW).toContain("github.event.workflow_run.event == 'schedule'");
    expect(WORKFLOW).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
  });

  it("reruns only failed shard cells and leaves semantic failures for diagnosis", () => {
    expect(WORKFLOW).toContain("^test262\\ (js-host|standalone)\\ shard\\ [0-9]+$");
    expect(WORKFLOW).toContain("Non-shard failure is not auto-retryable");
    expect(WORKFLOW).toContain("/rerun-failed-jobs");
  });
});
