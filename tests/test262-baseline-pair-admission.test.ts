// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { admitPair, authenticateProducer, digest, validateCandidate } from "../scripts/admit-test262-baseline-pair.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "js2-baseline-admission-"));
  const settings = {
    include_proposals: true,
    semantic_providers: "auto",
    eval_engine: "quickjs",
    compiler_pool_size: 4,
    ir_first: false,
    layout_emit: false,
    native_first: false,
  };
  const rows = ["pass", "fail", "compile_timeout", "compile_error", "skip"].map((status, i) => ({
    file: `test/${i}.js`,
    status,
    oracle_version: 13,
    oracle_lane: "honest",
    semantic_providers: "auto",
  }));
  const bytes = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const lane = (name: string, file: string) => ({
    lane: name,
    file,
    sha256: digest(bytes),
    total: 5,
    registered: 5,
    verdicts: 5,
    excluded: 0,
    counts: { pass: 1, fail: 1, compile_timeout: 1, compile_error: 1, skip: 1 },
  });
  const manifest = {
    schema: 1,
    compiler_sha: "a".repeat(40),
    corpus_sha: "b".repeat(40),
    oracle_version: 13,
    settings,
    producer: {
      repository: "loopdive/js2",
      run_id: 1,
      artifact_id: 2,
      artifact_sha256: "c".repeat(64),
      workflow: ".github/workflows/test262-sharded.yml",
    },
    lanes: {
      host: lane("host", "test262-current.jsonl"),
      standalone: lane("standalone", "test262-standalone-current.jsonl"),
    },
  };
  const expected = {
    baselines_commit: "d".repeat(40),
    candidate_sha: "e".repeat(40),
    corpus_sha: manifest.corpus_sha,
    oracle_version: 13,
    settings: { ...settings },
  };
  for (const entry of Object.values(manifest.lanes)) writeFileSync(join(directory, entry.file), bytes);
  const rewrite = (newRows: unknown[]) => {
    const text = `${newRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    writeFileSync(join(directory, manifest.lanes.host.file), text);
    manifest.lanes.host.sha256 = digest(text);
  };
  return { directory, manifest, expected, rows, rewrite };
}

describe("measurement-only baseline pair admission", () => {
  it("admits a pinned original artifact with a receipt bound to the candidate commit", () => {
    const f = fixture();
    const { baselines_commit, ...expected } = f.expected;
    const receipt = admitPair(f.directory, f.manifest, {
      ...expected,
      artifact_id: 2,
      receipt_commit: expected.candidate_sha,
    });
    expect(receipt.artifact_id).toBe(2);
    expect(receipt.baselines_commit).toBeUndefined();
    expect(() =>
      admitPair(f.directory, f.manifest, { ...expected, artifact_id: 3, receipt_commit: expected.candidate_sha }),
    ).toThrow(/artifact/);
    expect(() =>
      admitPair(f.directory, f.manifest, { ...expected, artifact_id: 2, receipt_commit: "f".repeat(40) }),
    ).toThrow(/receipt/);
    expect(() =>
      admitPair(f.directory, f.manifest, { ...f.expected, artifact_id: 2, receipt_commit: expected.candidate_sha }),
    ).toThrow(/artifact/);
  });
  it("refuses acquisition without a producer manifest despite a plausible committed fallback", () => {
    const f = fixture();
    const result = spawnSync(process.execPath, ["scripts/acquire-test262-baseline-pair.mjs", f.directory], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(join(f.directory, "admission.json"), "utf8")).admitted).toBe(false);
    expect(readFileSync(join(f.directory, f.manifest.lanes.host.file), "utf8")).toContain('"status":"pass"');
  });
  it("passes an admitted real regression to the unchanged failing comparator", () => {
    const f = fixture();
    const candidate = join(f.directory, "regression.jsonl");
    const changed = f.rows.map((row) => ({ ...row, status: "fail" }));
    writeFileSync(candidate, changed.map((row) => JSON.stringify(row)).join("\n"));
    admitPair(f.directory, f.manifest, f.expected);
    validateCandidate(join(f.directory, f.manifest.lanes.host.file), candidate, f.manifest);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/diff-test262.ts",
        join(f.directory, f.manifest.lanes.host.file),
        candidate,
        "--quiet",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, REGRESSIONS_ALLOW_FILE: "/dev/null", ORACLE_REBASE: "0" },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/regression/i);
  });
  it("admits all five statuses without filtering failures/timeouts", () => {
    const f = fixture();
    const receipt = admitPair(f.directory, f.manifest, f.expected);
    expect(receipt.lanes.host.total).toBe(5);
    expect(receipt.lanes.standalone.counts.compile_timeout).toBe(1);
  });
  it.each(["corpus_sha", "oracle_version", "compiler_sha"])("rejects missing %s", (field) => {
    const f = fixture();
    (f.manifest as Record<string, unknown>)[field] = undefined;
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow();
  });
  it.each([
    "include_proposals",
    "semantic_providers",
    "eval_engine",
    "compiler_pool_size",
    "ir_first",
    "layout_emit",
    "native_first",
  ])("rejects unknown or mismatched producer setting %s", (field) => {
    const f = fixture();
    (f.manifest.settings as Record<string, unknown>)[field] = "unknown";
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow(/setting mismatch/);
    (f.manifest.settings as Record<string, unknown>)[field] = undefined;
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow(/unknown setting/);
  });
  it.each(["", "not-json\n", "{}\n"])("rejects damaged bytes: %j", (bytes) => {
    const f = fixture();
    writeFileSync(join(f.directory, f.manifest.lanes.host.file), bytes);
    f.manifest.lanes.host.sha256 = digest(bytes);
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow();
  });
  it("rejects duplicates even if their hash is updated", () => {
    const f = fixture();
    f.rewrite([...f.rows, f.rows[0]]);
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow(/duplicate/);
  });
  it("rejects truncation against producer population", () => {
    const f = fixture();
    f.rewrite(f.rows.slice(1));
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow(/population/);
  });
  it("rejects old unstamped JSONL with current metadata", () => {
    const f = fixture();
    f.rewrite(f.rows.map(({ oracle_version, ...row }) => row));
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow(/unstamped/);
  });
  it("rejects swapped lane identities", () => {
    const f = fixture();
    f.manifest.lanes.host.lane = "standalone";
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow(/swapped/);
  });
  it("rejects missing standalone rather than degrading to one lane", () => {
    const f = fixture();
    (f.manifest.lanes as Record<string, unknown>).standalone = undefined;
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow(/standalone/);
  });
  it.each(["sha256", "total", "registered", "verdicts", "excluded"])("rejects mismatched %s", (field) => {
    const f = fixture();
    (f.manifest.lanes.host as Record<string, unknown>)[field] = field === "sha256" ? "f".repeat(64) : 10;
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow();
  });
  it("rejects summary counts from a different file", () => {
    const f = fixture();
    f.manifest.lanes.host.counts.pass = 29587;
    expect(() => admitPair(f.directory, f.manifest, f.expected)).toThrow(/count mismatch/);
  });
  it("requires original API producer identity", () => {
    const f = fixture();
    const run = {
      id: 1,
      head_sha: f.manifest.compiler_sha,
      path: f.manifest.producer.workflow,
      status: "completed",
      repository: { full_name: "loopdive/js2" },
    };
    const artifact = {
      id: 2,
      digest: `sha256:${f.manifest.producer.artifact_sha256}`,
      expired: false,
      workflow_run: { id: 1, head_sha: f.manifest.compiler_sha },
    };
    expect(() => authenticateProducer(f.manifest, run, artifact)).not.toThrow();
    expect(() => authenticateProducer(f.manifest, { ...run, head_sha: "f".repeat(40) }, artifact)).toThrow();
    expect(() => authenticateProducer(f.manifest, run, { ...artifact, expired: true })).toThrow();
    expect(() => authenticateProducer(f.manifest, run, { ...artifact, digest: "unknown" })).toThrow();
  });
  it("admits valid regression rows but rejects missing candidate fixtures", () => {
    const f = fixture();
    const candidate = join(f.directory, "candidate.jsonl");
    const changed = f.rows.map((row) => ({ ...row, status: "fail" }));
    writeFileSync(candidate, changed.map((row) => JSON.stringify(row)).join("\n"));
    expect(() => validateCandidate(join(f.directory, f.manifest.lanes.host.file), candidate, f.manifest)).not.toThrow();
    writeFileSync(
      candidate,
      changed
        .slice(1)
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    expect(() => validateCandidate(join(f.directory, f.manifest.lanes.host.file), candidate, f.manifest)).toThrow(
      /population/,
    );
  });
  it("wires the same immutable pair before both consumers without altering legacy fetch selection", () => {
    const workflow = readFileSync(new URL("../.github/workflows/test262-sharded.yml", import.meta.url), "utf8");
    expect(workflow.match(/name: admitted-measurement-baseline/g)).toHaveLength(3);
    expect(workflow).toContain(
      "needs: [changes, mg-artifact-probe, runtime-eval-provider, temporal-provider, admit-measurement-baseline]",
    );
    expect(workflow).toContain(
      "if: env.HOST_RAN == 'true' && (github.event_name == 'pull_request' || github.event_name == 'merge_group')",
    );
    expect(workflow.indexOf("Check measurement candidate population")).toBeLessThan(
      workflow.indexOf("- name: Standalone pass-count high-water floor"),
    );
    expect(workflow.indexOf("Check measurement host population")).toBeLessThan(
      workflow.indexOf("- name: Compare against current main baseline"),
    );
  });
});
