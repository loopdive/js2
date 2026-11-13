import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveFrozenHostBaseline } from "../scripts/preserve-frozen-host-baseline.mjs";

function withBaseline(run: (dir: string, report: string, rows: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "frozen-host-"));
  const report = JSON.stringify(
    {
      summary: { pass: 32000, total: 40000 },
      baseline_sha: "old-source-sha",
      baseline_generated_at: "2026-09-01T00:00:00Z",
    },
    null,
    2,
  );
  const rows = `${JSON.stringify({ file: "test/example.js", status: "pass" })}\n`.repeat(40000);
  writeFileSync(join(dir, "test262-current.json"), report);
  writeFileSync(join(dir, "test262-current.jsonl"), rows);
  try {
    run(dir, report, rows);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("frozen host publishing compatibility", () => {
  it("preserves measured rows and original SHA/timestamp byte for byte", () => {
    withBaseline((dir, report, rows) => {
      const output = join(dir, "output");
      preserveFrozenHostBaseline(dir, output);
      expect(readFileSync(join(output, "test262-report-merged.json"), "utf8")).toBe(report);
      expect(readFileSync(join(output, "test262-results-merged.jsonl"), "utf8")).toBe(rows);
    });
  });
  it("refuses missing snapshots instead of pretending the lane was measured", () => {
    withBaseline((dir) => {
      rmSync(join(dir, "test262-current.jsonl"));
      expect(() => preserveFrozenHostBaseline(dir, join(dir, "output"))).toThrow();
    });
  });
  it("refuses a corrupt report or truncated rows", () => {
    withBaseline((dir, report) => {
      writeFileSync(join(dir, "test262-current.json"), '{"summary":{"pass":0,"total":40000}}');
      expect(() => preserveFrozenHostBaseline(dir, join(dir, "output"))).toThrow(/corrupt/);
      writeFileSync(join(dir, "test262-current.json"), report);
      writeFileSync(join(dir, "test262-current.jsonl"), '{"status":"pass"}\n');
      expect(() => preserveFrozenHostBaseline(dir, join(dir, "output"))).toThrow(/truncated/);
    });
  });
});

const workflowRoot = new URL("../", import.meta.url);
const shardedWorkflow = readFileSync(new URL(".github/workflows/test262-sharded.yml", workflowRoot), "utf8");
const refreshWorkflow = readFileSync(new URL(".github/workflows/refresh-baseline.yml", workflowRoot), "utf8");

function workflowJob(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`Missing job ${name}`);
  const rest = workflow.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function workflowStep(job: string, name: string): string {
  const start = job.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`Missing step ${name}`);
  const rest = job.slice(start);
  const end = rest.slice(1).indexOf("\n      - name: ");
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function runBody(step: string): string {
  const start = step.indexOf("        run: |\n");
  if (start < 0) throw new Error("Missing shell body");
  return step
    .slice(start + "        run: |\n".length)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

const promotionJobs = [
  [
    "push/dispatch/queue",
    workflowJob(shardedWorkflow, "promote-baseline"),
    "shard-artifacts",
    "Promote merged artifacts to stable baseline",
  ],
  [
    "scheduled refresh",
    workflowJob(refreshWorkflow, "merge-and-promote"),
    "merged-reports",
    "Promote merged report to baseline",
  ],
] as const;

describe("standalone-only publishing workflow integration", () => {
  it.each(promotionJobs)(
    "%s copies frozen metadata unchanged through real report mirroring",
    (_name, job, artifactDir, stepName) => {
      withBaseline((dir, frozenReport, rows) => {
        preserveFrozenHostBaseline(dir, join(dir, artifactDir));
        const standaloneReport = JSON.stringify({
          summary: { pass: 33000, total: 40000 },
          baseline_sha: "new-source-sha",
        });
        writeFileSync(join(dir, artifactDir, "test262-standalone-report-merged.json"), standaloneReport);
        writeFileSync(join(dir, artifactDir, "test262-standalone-results-merged.jsonl"), rows);
        mkdirSync(join(dir, "scripts"));
        mkdirSync(join(dir, "website/public/benchmarks/results"), { recursive: true });
        copyFileSync(
          new URL("scripts/sync-test262-report-mirrors.mjs", workflowRoot),
          join(dir, "scripts/sync-test262-report-mirrors.mjs"),
        );
        const script = runBody(workflowStep(job, stepName)).replaceAll(
          "/tmp/js2wasm-before-refresh",
          join(dir, "before-refresh"),
        );
        execFileSync("bash", ["-e", "-c", script], { cwd: dir });
        for (const path of [
          "benchmarks/results/test262-current.json",
          "public/benchmarks/results/test262-report.json",
          "website/public/benchmarks/results/test262-report.json",
        ]) {
          expect(readFileSync(join(dir, path), "utf8")).toBe(frozenReport);
        }
        expect(readFileSync(join(dir, "benchmarks/results/test262-standalone-current.json"), "utf8")).toBe(
          standaloneReport,
        );
      });
    },
  );

  it.each(promotionJobs)("%s never heals, rebuilds or assigns fresh history to the retired host", (_name, job) => {
    expect(job).not.toMatch(/(?:--in |--input |--results ).*test262-(?!standalone)(?:results|current)/);
    expect(job).not.toMatch(
      /cp (?:shard-artifacts|merged-reports)\/test262-(?!standalone)\S*\s+\/tmp\/js2wasm-baselines\//,
    );
    expect(job).not.toContain("scripts/write-run-cache.mjs");
    expect(job).not.toContain("--editions website/public/benchmarks/results/test262-editions.json");
    expect(job).toContain("scripts/preserve-frozen-host-baseline.mjs");
    expect(job).toContain("test262-standalone-current.jsonl");
  });

  it("accepts a complete standalone-only queue artifact and refuses truncated or missing rows", () => {
    withBaseline((dir, _report, rows) => {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      writeFileSync(join(binDir, "gh"), '#!/bin/sh\nprintf "123\\n"\n', { mode: 0o755 });
      writeFileSync(
        join(binDir, "unzip"),
        '#!/bin/sh\nmkdir -p "$4"\nif [ -f "$GROUP_CANDIDATE" ]; then cp "$GROUP_CANDIDATE" "$4/test262-standalone-results-merged.jsonl"; fi\n',
        { mode: 0o755 },
      );
      const candidate = join(dir, "candidate.jsonl");
      const script = runBody(workflowStep(promotionJobs[0][1], "Download merged reports (merge_group artifact, #3448)"))
        .replaceAll("${{ github.sha }}", "new-source-sha")
        .replaceAll("/tmp/mg-group.zip", join(dir, "group.zip"));
      const run = () =>
        spawnSync("bash", ["-e", "-c", script], {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GITHUB_REPOSITORY: "loopdive/js2",
            GROUP_CANDIDATE: candidate,
          },
          encoding: "utf8",
        });
      writeFileSync(candidate, rows);
      expect(run().status).toBe(0);
      expect(existsSync(join(dir, "shard-artifacts/test262-results-merged.jsonl"))).toBe(false);
      writeFileSync(candidate, '{"status":"pass"}\n');
      const truncated = run();
      expect(truncated.status).not.toBe(0);
      expect(truncated.stdout).toContain("Standalone group artifact is truncated");
      rmSync(candidate);
      rmSync(join(dir, "shard-artifacts"), { recursive: true });
      expect(run().status).not.toBe(0);
    });
  });

  it("refresh still requires all 102 shard manifests before promoting measured standalone results", () => {
    const validation = workflowStep(
      promotionJobs[1][1],
      "Validate merged standalone Test262 verdict completeness (#5215)",
    );
    expect(validation).toContain('EXPECTED_SHARDS: "102"');
    expect(validation).toContain("scripts/validate-test262-completeness.mjs");
    expect(validation).toContain('--expected-shards "$EXPECTED_SHARDS"');
    expect(validation).toContain('--manifest "$manifest"');
  });
});
