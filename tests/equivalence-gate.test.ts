// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6785) The required `equivalence-gate` check used to read only
// `assertionResults`. A test file that failed to import, failed to parse, threw
// while collecting, crashed its worker, or was deleted contributed no assertion
// — and the gate printed "No new equivalence regressions". These cases drive
// the gate's evaluation over vitest-shaped JSON reports and assert it FAILS on
// each blind spot, and still passes the clean / known-failure-only report (the
// control: a gate that failed on everything would satisfy the other cases).
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  bankBaseline,
  evaluateGate,
  fromPartial,
  mergeSummaries,
  summarizeReport,
  toPartial,
} from "../scripts/equivalence-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_PATH = join(REPO_ROOT, "scripts", "equivalence-gate.mjs");
const ROOT = "/ci/checkout/tests/equivalence/";

type Assertion = { fullName: string; status: string };
type FileEntry = { name: string; status: string; message: string; assertionResults: Assertion[] };

function file(
  name: string,
  tests: Record<string, string>,
  opts: { status?: string; message?: string } = {},
): FileEntry {
  const assertionResults = Object.entries(tests).map(([fullName, status]) => ({ fullName, status }));
  const failed = assertionResults.some((a) => a.status === "failed");
  return {
    name: `${ROOT}${name}`,
    status: opts.status ?? (failed ? "failed" : "passed"),
    message: opts.message ?? "",
    assertionResults,
  };
}

function report(files: FileEntry[]) {
  const success = files.every((f) => f.status === "passed");
  return { success, numFailedTestSuites: files.filter((f) => f.status === "failed").length, testResults: files };
}

const KNOWN = "tests/equivalence/b.test.ts :: b known-broken";
/** Full-suite baseline matching `cleanFiles()`: 3 files, 4 passing tests, 1 known failure. */
const BASELINE = { passingFloor: 4, fileCount: 3, knownFailures: [KNOWN] };

function cleanFiles(): FileEntry[] {
  return [
    file("a.test.ts", { "a one": "passed", "a two": "passed" }),
    file("b.test.ts", { "b ok": "passed", "b known-broken": "failed" }),
    file("spec/c.test.ts", { "c ok": "passed" }),
  ];
}

function gate(files: FileEntry[], opts: { partial?: boolean; diskFiles?: string[] | null } = {}) {
  return evaluateGate(summarizeReport(report(files)), BASELINE, opts);
}

describe("#6785 equivalence gate — failures with no assertion to carry them", () => {
  it("control: a full report whose only failure is a known one passes", () => {
    const v = gate(cleanFiles());
    expect(v).toMatchObject({ ok: true, regressions: [], fileFailures: [], unexplained: [], floorFailures: [] });
  });

  it("assertion failure: an id outside knownFailures is a regression, a listed one is masked", () => {
    const files = cleanFiles();
    files[0] = file("a.test.ts", { "a one": "passed", "a two": "failed" });
    const v = gate(files);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual(["tests/equivalence/a.test.ts :: a two"]);
    expect(v.fileFailures).toEqual([]);
  });

  it("file-level failure: an import error (no tests collected) fails and names the file", () => {
    const files = cleanFiles();
    files[2] = file(
      "spec/c.test.ts",
      {},
      { status: "failed", message: "Cannot find module './gone.js' imported from '/ci/x.test.ts'" },
    );
    const v = gate(files);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual([]); // the old gate's whole verdict: nothing to see
    expect(v.fileFailures).toEqual([
      { file: "tests/equivalence/spec/c.test.ts", reason: expect.stringContaining("no tests collected: Cannot find") },
    ]);
  });

  it("file-level failure: a syntax error, a file error beside passing tests, an unfinished test", () => {
    const files = [
      file(
        "a.test.ts",
        {},
        { status: "failed", message: 'Transform failed with 1 error:\nx.ts:2:58: ERROR: Unexpected ")"' },
      ),
      file("b.test.ts", { "b ok": "passed", "b known-broken": "failed" }, { message: "afterAll boom" }),
      file("spec/c.test.ts", { "c ok": "passed", "c hung": "pending" }),
    ];
    const v = gate(files);
    expect(v.ok).toBe(false);
    expect(v.fileFailures.map((f) => f.file)).toEqual([
      "tests/equivalence/a.test.ts",
      "tests/equivalence/b.test.ts",
      "tests/equivalence/spec/c.test.ts",
    ]);
    expect(v.fileFailures[0]!.reason).toBe(
      'no tests collected: Transform failed with 1 error: x.ts:2:58: ERROR: Unexpected ")"',
    );
    expect(v.fileFailures[1]!.reason).toBe("file-level error: afterAll boom");
    expect(v.fileFailures[2]!.reason).toContain("1 test(s) never finished");
  });

  it("report failure: success=false with nothing failing is not 'no regressions'", () => {
    const r = { ...report([file("a.test.ts", { "a one": "passed" })]), success: false };
    const s = summarizeReport(r, "shard 3/8");
    expect(s.unexplained).toEqual([expect.stringContaining("shard 3/8: vitest reported success=false")]);
    expect(evaluateGate(s, BASELINE, { partial: true }).ok).toBe(false);
  });

  it("passing-count drop: fewer passing tests than passingFloor fails", () => {
    const files = cleanFiles();
    files[0] = file("a.test.ts", { "a one": "passed", "a two": "skipped" });
    const v = gate(files);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual([]);
    expect(v.floorFailures).toEqual([expect.stringContaining("3 passing tests < committed passingFloor 4")]);
  });

  it("file-count drop: a deleted test file fails until the baseline changes", () => {
    const files = cleanFiles().filter((f) => !f.name.endsWith("spec/c.test.ts"));
    const v = gate(files);
    expect(v.ok).toBe(false);
    expect(v.floorFailures).toEqual([
      expect.stringContaining("3 passing tests < committed passingFloor 4"),
      expect.stringContaining("2 test files in the report < committed fileCount 3"),
    ]);
  });

  it("a test file on disk that reached no report is named", () => {
    const disk = ["tests/equivalence/a.test.ts", "tests/equivalence/b.test.ts", "tests/equivalence/spec/c.test.ts"];
    const files = cleanFiles().filter((f) => !f.name.endsWith("spec/c.test.ts"));
    const v = gate(files, { diskFiles: disk });
    expect(v.fileFailures).toEqual([
      { file: "tests/equivalence/spec/c.test.ts", reason: "on disk but absent from the report (never run)" },
    ]);
  });

  it("a baseline without floors fails closed on a full report", () => {
    const v = evaluateGate(summarizeReport(report(cleanFiles())), { knownFailures: [KNOWN] });
    expect(v.ok).toBe(false);
    expect(v.floorFailures).toEqual([expect.stringContaining("baseline has no passingFloor/fileCount")]);
  });
});

describe("#6785 equivalence gate — sharded CI layout", () => {
  // Shard 1 holds a.test.ts, shard 2 holds b + c. Each alone is far below the
  // whole-suite floor, which is why a shard scores per-test/per-file only.
  const shard1 = summarizeReport(report(cleanFiles().slice(0, 1)), "shard 1/2");
  shard1.shards.push("1/2");
  const shard2 = summarizeReport(report(cleanFiles().slice(1)), "shard 2/2");
  shard2.shards.push("2/2");

  it("a single shard does not trip the global floor", () => {
    expect(evaluateGate(shard1, BASELINE, { partial: true }).ok).toBe(true);
    expect(evaluateGate(shard1, BASELINE).floorFailures.length).toBeGreaterThan(0);
  });

  it("merged partials (round-tripped through JSON) are scored against the floor", () => {
    const roundTrip = (s: typeof shard1, label: string) =>
      fromPartial(JSON.parse(JSON.stringify(toPartial(s, label))) as ReturnType<typeof toPartial>);
    const merged = mergeSummaries([roundTrip(shard1, "1/2"), roundTrip(shard2, "2/2")]);
    expect(evaluateGate(merged, BASELINE).ok).toBe(true);
  });

  it("a missing shard partial fails the merge", () => {
    const merged = mergeSummaries([shard2]);
    const v = evaluateGate(merged, BASELINE);
    expect(v.ok).toBe(false);
    expect(v.unexplained).toContain("no partial for shard 1/2");
    expect(bankBaseline(merged, {}).refusals).toContain("no partial for shard 1/2");
  });
});

describe("#6785 --update banks floors, never lowers them", () => {
  it("raises passingFloor / fileCount and records the failing set", () => {
    const { baseline, refusals } = bankBaseline(summarizeReport(report(cleanFiles())), {
      passingFloor: 2,
      fileCount: 1,
      knownFailures: [],
    });
    expect(refusals).toEqual([]);
    expect(baseline).toEqual({ passingFloor: 4, fileCount: 3, knownFailures: [KNOWN] });
  });

  it("refuses a run below the committed floor or with a file-level failure", () => {
    const files = cleanFiles().slice(0, 2);
    files[0] = file("a.test.ts", {}, { status: "failed", message: "boom" });
    const { baseline, refusals } = bankBaseline(summarizeReport(report(files)), BASELINE);
    expect(refusals).toHaveLength(3);
    expect(baseline.passingFloor).toBe(4);
    expect(baseline.fileCount).toBe(3);
  });
});

describe("#6785 CLI wiring", () => {
  function runGate(partial: object, env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "equiv-6785-"));
    try {
      writeFileSync(join(dir, "partial.json"), JSON.stringify(partial));
      const res = spawnSync(process.execPath, [GATE_PATH], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, MERGE_PARTIALS_DIR: dir, PARTIAL_OUT: "", ...env },
      });
      return { status: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a shard partial carrying a file-level failure exits 1 and names the file", () => {
    const { status, output } = runGate(
      {
        shard: "1/8",
        failing: [],
        passing: [],
        files: ["tests/equivalence/broken.test.ts"],
        fileFailures: [{ file: "tests/equivalence/broken.test.ts", reason: "no tests collected: SyntaxError" }],
        unexplained: [],
      },
      { SHARD: "1/8" },
    );
    expect(status, output).toBe(1);
    expect(output).toContain("FILE FAILURE: tests/equivalence/broken.test.ts — no tests collected: SyntaxError");
  });

  it("a merged report below the committed floor exits 1 with FLOOR lines", () => {
    const { status, output } = runGate(
      { shard: "1/1", failing: [], passing: ["tests/equivalence/a.test.ts :: a"], files: [], fileFailures: [] },
      { SHARD: "" },
    );
    expect(status, output).toBe(1);
    expect(output).toMatch(/FLOOR: 1 passing tests < committed passingFloor \d+/);
    expect(output).toMatch(/FLOOR: 0 test files in the report < committed fileCount \d+/);
  });
});
