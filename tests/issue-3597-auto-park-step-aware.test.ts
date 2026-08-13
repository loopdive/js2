/**
 * #3597 — the auto-park bot must be STEP-aware.
 *
 * Motivating incident (2026-07-24): two merge-queue parks landed the same day
 * with textually identical comments — "Failed checks: - check for test262
 * regressions", no run URL, no step name.
 *
 *   • PR #3566 — BOGUS park. The shard-artifact download 403'd, so the verdict
 *     step never ran. The PR merged cleanly once unparked.
 *   • PR #3563 — CORRECT park. The verdict step ran and caught a real
 *     uncatchable-trap regression.
 *
 * Two opposite situations, indistinguishable from the comment, each costing a
 * full manual investigation. `classifyRun` now reads the per-step `conclusion`
 * from the Actions jobs API and refuses to park when EVERY failed step is a
 * recognised setup/infra step.
 *
 * DIRECTIONALITY (the load-bearing invariant): being wrong in the PERMISSIVE
 * direction lets a real regression into main; being wrong in the STRICT
 * direction costs one label removal. So anything we cannot positively classify
 * as infra must still park.
 */
import { describe, expect, it } from "vitest";
import { classifyRun, isInfraStep, renderFailureLines } from "../scripts/auto-park-merge-group-failure.mjs";

interface Step {
  name: string;
  conclusion: string;
}
interface Job {
  name: string;
  conclusion: string;
  html_url?: string;
  steps?: Step[];
}

const job = (name: string, conclusion: string, steps?: Step[], html_url?: string): Job => ({
  name,
  conclusion,
  html_url,
  steps,
});

describe("#3597 — auto-park step awareness", () => {
  describe("the two shapes that were indistinguishable on 2026-07-24", () => {
    it("#3566 shape: artifact download failed, verdict never ran → does NOT park", () => {
      const r = classifyRun([
        job("check for test262 regressions", "failure", [
          { name: "Set up job", conclusion: "success" },
          { name: "Download shard artifacts", conclusion: "failure" },
          { name: "Compare against baseline", conclusion: "skipped" },
        ]),
      ]);
      expect(r.realFailure).toBe(true); // the run really did fail …
      expect(r.infraOnly).toBe(true); // … but only in infra
      expect(r.shouldPark).toBe(false);
    });

    it("#3563 shape: the verdict step itself failed → MUST park", () => {
      const r = classifyRun([
        job("check for test262 regressions", "failure", [
          { name: "Download shard artifacts", conclusion: "success" },
          { name: "Compare against baseline", conclusion: "failure" },
        ]),
      ]);
      expect(r.infraOnly).toBe(false);
      expect(r.shouldPark).toBe(true);
    });
  });

  describe("conservative defaults — anything unclassifiable still parks", () => {
    it("a failed job with NO step data parks (cannot classify)", () => {
      const r = classifyRun([job("quality", "failure")]);
      expect(r.unclassifiable).toBe(true);
      expect(r.shouldPark).toBe(true);
    });

    it("a failed job with an empty steps array parks", () => {
      const r = classifyRun([job("quality", "failure", [])]);
      expect(r.unclassifiable).toBe(true);
      expect(r.shouldPark).toBe(true);
    });

    it("infra failure in one job + verdict failure in another parks", () => {
      const r = classifyRun([
        job("shard-a", "failure", [{ name: "Download shard artifacts", conclusion: "failure" }]),
        job("shard-b", "failure", [{ name: "Compare against baseline", conclusion: "failure" }]),
      ]);
      expect(r.shouldPark).toBe(true);
    });

    it("infra failure + an unclassifiable job parks", () => {
      const r = classifyRun([
        job("shard-a", "failure", [{ name: "Download shard artifacts", conclusion: "failure" }]),
        job("shard-b", "failure", []),
      ]);
      expect(r.shouldPark).toBe(true);
    });

    it("a job whose FAILED step is infra but which also has an unrelated non-failed verdict step does not park", () => {
      const r = classifyRun([
        job("check for test262 regressions", "failure", [
          { name: "Download shard artifacts", conclusion: "failure" },
          { name: "Compare against baseline", conclusion: "skipped" },
        ]),
      ]);
      expect(r.shouldPark).toBe(false);
    });
  });

  describe("cancellation handling is unchanged (#2547 invariant)", () => {
    it("zero failed jobs (queue rebuild cancellation) does not park", () => {
      const r = classifyRun([
        job("quality", "cancelled"),
        job("test262 shard 1", "cancelled"),
        job("test262 shard 2", "success"),
      ]);
      expect(r.realFailure).toBe(false);
      expect(r.shouldPark).toBe(false);
    });

    it("an empty jobs list does not park", () => {
      expect(classifyRun([]).shouldPark).toBe(false);
    });
  });

  describe("isInfraStep — tight by design", () => {
    it.each([
      "Set up job",
      "Complete job",
      "Checkout",
      "Check out",
      "Post Checkout",
      "Set up Node",
      "Setup pnpm",
      "Download shard artifacts",
      "Download artifact",
      "Upload merged artifacts",
    ])("treats %j as infra", (name) => {
      expect(isInfraStep(name)).toBe(true);
    });

    it.each([
      "check for test262 regressions",
      "Compare against baseline",
      "Run standalone floor gate",
      "quality",
      "Required guard suite (#3552)",
      "Issue-ID fresh-claim gate (#2531)",
      "",
      "   ",
    ])("does NOT treat %j as infra", (name) => {
      expect(isInfraStep(name)).toBe(false);
    });

    it("non-string step names are not infra", () => {
      expect(isInfraStep(undefined as unknown as string)).toBe(false);
      expect(isInfraStep(null as unknown as string)).toBe(false);
      expect(isInfraStep(42 as unknown as string)).toBe(false);
    });

    // GROUNDING: these are the ACTUAL step names, harvested 2026-07-25 from
    // .github/workflows/test262-sharded.yml and from a real jobs-API response
    // (run 30131351838). Three of the transfer steps carry no "artifact" token,
    // so an artifact-word-only pattern would have missed the #3566 class
    // entirely. If a workflow rename breaks one of these, it surfaces HERE
    // rather than as another manual park investigation.
    it.each([
      "Download shard artifacts",
      "Upload shard artifacts",
      "Upload merged reports",
      "Download merged reports (full-matrix path)",
      "Download merged reports (merge_group artifact, #3448)",
      "Download just-landed group artifact (#3467)",
      "Upload regressions report",
      "Retry shard artifact upload on transient flake (#3404)",
      "Run actions/checkout@v5",
      "Post Run actions/checkout@v5",
      "Setup Node and pnpm (cached)",
      "Post Setup Node and pnpm (cached)",
    ])("real workflow step %j classifies as infra", (name) => {
      expect(isInfraStep(name)).toBe(true);
    });

    // Real VERDICT step names from the same run — these must never be infra, or
    // a genuine regression would slip through unparked.
    it.each([
      "Issue-ID fresh-claim gate (#2531)",
      "Lint, format, and typecheck (parallel)",
      "Dead-export gate (#3090 Phase 2)",
      "Required guard suite (#3552)",
      "Promote merged artifacts to stable baseline",
      "Push baseline artifacts to js2wasm-baselines repo",
    ])("real workflow step %j is NOT infra", (name) => {
      expect(isInfraStep(name)).toBe(false);
    });
  });

  describe("the park comment is actionable", () => {
    it("names the failing step and links the job log", () => {
      const r = classifyRun([
        job(
          "check for test262 regressions",
          "failure",
          [{ name: "Compare against baseline", conclusion: "failure" }],
          "https://github.com/loopdive/js2wasm/actions/runs/1/job/2",
        ),
      ]);
      const line = renderFailureLines(r.failedDetails);
      expect(line).toContain("check for test262 regressions");
      expect(line).toContain("Compare against baseline");
      expect(line).toContain("https://github.com/loopdive/js2wasm/actions/runs/1/job/2");
    });

    it("says 'unknown' rather than lying when the step cannot be identified", () => {
      const r = classifyRun([job("quality", "failure")]);
      expect(renderFailureLines(r.failedDetails)).toBe("- quality — failing step: unknown");
    });
  });
});
