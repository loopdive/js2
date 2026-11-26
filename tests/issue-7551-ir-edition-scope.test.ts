// #7551 — per-merge test262 scope: the current ES edition on the IR path.
// Exercises scripts/test262-edition-scope.ts on a fixture test262 tree (real
// frontmatter shapes, classified by the edition ratchet's own classifier) and
// through its CLI, including the exit codes the workflow gates on.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readJobAnnotations, renderFailureLines } from "../scripts/auto-park-merge-group-failure.mjs";
import { DEFAULT_MAX_FLOOR_AGE_HOURS, floorAge } from "../scripts/check-baseline-floor-staleness.mjs";
import { GH_RETRY_DELAYS_SECONDS, ghWithRetry } from "../scripts/lib/gh-api-retry.mjs";
import { REGRESSION_ANNOTATION_TITLE } from "../scripts/lib/regression-annotation.mjs";
import {
  buildReport,
  compareEditionRuns,
  editionPaths,
  MISSING_STATUS,
  nearestBaseline,
  REGRESSION_EXIT_CODE,
  readCurrentEdition,
  regressionAnnotation,
  renderSummary,
  type ScopeMeta,
} from "../scripts/test262-edition-scope.ts";

const ES5_A = "test/built-ins/Object/create/15.2.3.5-1-1.js";
const ES5_B = "test/built-ins/Array/prototype/forEach/15.4.4.18-4-1.js";
const ES5_C = "test/language/statements/with/S12.10_A1.1_T1.js";
const ES2015 = "test/built-ins/Map/constructor.js";
const FIXTURE = "test/built-ins/Object/create/helper_FIXTURE.js";

const header = (yaml: string) => `/*---\n${yaml}\n---*/\n`;
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "issue-7551-"));
  const files: Record<string, string> = {
    [ES5_A]: header("es5id: 15.2.3.5-1-1"),
    [ES5_B]: header("es5id: 15.4.4.18-4-1"),
    [ES5_C]: header("es5id: 12.10-0-1"),
    [ES2015]: header("es6id: 23.1.1.1\nfeatures: [Map]"),
    [FIXTURE]: header("es5id: 0"),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body + "assert(true);\n");
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const meta = (over: Partial<ScopeMeta> = {}): ScopeMeta => ({
  scope: "edition",
  edition: "ES5",
  sourceSha: "head",
  test262Sha: "t262",
  evalEngine: "quickjs",
  ...over,
});
const statuses = (rows: Record<string, string>) => new Map(Object.entries(rows));

describe("#7551 edition path list", () => {
  it("selects the edition's test files by the ratchet classifier, skipping fixtures", () => {
    expect(editionPaths(root, 5)).toEqual([ES5_B, ES5_A, ES5_C].sort());
    expect(editionPaths(root, 2015)).toEqual([ES2015]);
  });

  it("reads the committed current edition and refuses a non-edition", () => {
    const committed = readCurrentEdition();
    expect(committed.year).toBeGreaterThanOrEqual(5);
    expect(committed.chunks).toBeGreaterThan(0);
    const bad = join(root, "bad.json");
    for (const config of [
      { edition: "Proposals", chunks: 8 },
      { edition: "ES5", chunks: 0 },
    ]) {
      writeFileSync(bad, JSON.stringify(config));
      expect(() => readCurrentEdition(bad)).toThrow();
    }
  });
});

describe("#7551 per-test comparison", () => {
  const paths = new Set([ES5_A, ES5_B, ES5_C]);

  it("gates every pass -> not-pass, compile_timeout included, and lists improvements", () => {
    const diff = compareEditionRuns(
      statuses({ [ES5_A]: "compile_error", [ES5_B]: "pass", [ES5_C]: "compile_timeout", [ES2015]: "fail" }),
      statuses({ [ES5_A]: "pass", [ES5_B]: "fail", [ES5_C]: "pass", [ES2015]: "pass" }),
      paths,
      true,
    );
    expect(diff.regressions).toEqual([
      { file: ES5_A, now: "compile_error" },
      { file: ES5_C, now: "compile_timeout" },
    ]);
    expect(diff.improvements).toEqual([ES5_B]);
    // ES2015 regressed too, but it is outside the edition.
    expect(diff.regressions.some((r) => r.file === ES2015)).toBe(false);
  });

  it("counts edition tests the baseline never ran instead of calling them regressions", () => {
    const diff = compareEditionRuns(statuses({ [ES5_A]: "fail" }), statuses({}), paths, true);
    expect(diff).toMatchObject({ regressions: [], unbaselined: 1 });
  });

  it("gates a baseline-passing test the run dropped, unless the test262 revision changed", () => {
    const run = statuses({ [ES5_A]: "pass" });
    const baseline = statuses({ [ES5_A]: "pass", [ES5_B]: "pass", [ES5_C]: "fail" });
    expect(compareEditionRuns(run, baseline, paths, true)).toMatchObject({
      regressions: [{ file: ES5_B, now: MISSING_STATUS }],
      notComparable: [],
    });
    expect(compareEditionRuns(run, baseline, paths, false)).toMatchObject({ regressions: [], notComparable: [ES5_B] });
    const changed = buildReport({
      run,
      meta: meta(),
      paths,
      baseline: { statuses: baseline, meta: meta({ sourceSha: "base", test262Sha: "older" }) },
    });
    expect(changed.baseline?.test262Changed).toEqual({ from: "older", to: "t262" });
    expect(renderSummary(changed)).toContain("Not comparable (test262 revision changed)");
  });

  it("never reports 'no regressions' without a comparable baseline", () => {
    const run = statuses({ [ES5_A]: "fail" });
    const none = buildReport({ run, meta: meta(), paths });
    expect(none.diff).toBeUndefined();
    expect(renderSummary(none)).toContain("No baseline — not compared");
    expect(renderSummary(none)).not.toContain("Regressions (pass");
    expect(renderSummary(none)).toContain("Regressions cannot be ruled out");

    const baseline = { statuses: statuses({ [ES5_A]: "pass" }), meta: meta({ sourceSha: "base" }) };
    for (const other of [meta({ evalEngine: "interpreter", sourceSha: "base" }), meta({ edition: "ES2015" })]) {
      const report = buildReport({ run, meta: meta(), paths, baseline: { ...baseline, meta: other } });
      expect(report.diff).toBeUndefined();
      expect(report.noBaselineReason).toMatch(/not comparable/);
    }
  });

  it("accepts a full-corpus baseline and lists the regression in the summary", () => {
    const report = buildReport({
      run: statuses({ [ES5_A]: "fail", [ES5_B]: "pass" }),
      meta: meta(),
      paths,
      baseline: {
        statuses: statuses({ [ES5_A]: "pass", [ES2015]: "pass" }),
        meta: meta({ scope: "full", edition: undefined, sourceSha: "daily" }),
        distance: 3,
      },
    });
    expect(report.counts).toMatchObject({ pass: 1, fail: 1, total: 2 });
    expect(report.diff?.regressions).toHaveLength(1);
    const summary = renderSummary(report);
    expect(summary).toContain("Regressions (pass → not pass): 1");
    expect(summary).toContain(`\`${ES5_A}\` → fail`);
    expect(summary).toContain("3 first-parent commit(s) back");
  });
});

describe("#7551 baseline resolution", () => {
  const art = (id: number, sha: string, createdAt: string) => ({ id, name: "a", runId: id, sha, createdAt });

  it("takes the measurement of the first commit in the lineage — the predecessor in the normal case", () => {
    const found = nearestBaseline(
      ["parent", "grandparent"],
      [art(1, "grandparent", "2026-11-26T01:00:00Z"), art(2, "parent", "2026-11-26T02:00:00Z")],
    );
    expect(found).toEqual({ artifact: art(2, "parent", "2026-11-26T02:00:00Z"), distance: 0 });
  });

  it("walks back past commits without a measurement and prefers the newest re-run of a commit", () => {
    const found = nearestBaseline(
      ["docs-only", "parent"],
      [
        art(1, "parent", "2026-11-26T01:00:00Z"),
        art(3, "parent", "2026-11-26T03:00:00Z"),
        art(9, "unrelated", "2026-11-27T00:00:00Z"),
      ],
    );
    expect(found?.artifact.id).toBe(3);
    expect(found?.distance).toBe(1);
  });

  it("returns null when nothing on the lineage was measured", () => {
    expect(nearestBaseline(["a", "b"], [art(1, "elsewhere", "2026-11-26T00:00:00Z")])).toBeNull();
  });
});

describe("#7551 queue gate plumbing", () => {
  it("the park comment lists the regressed tests the edition report annotated", () => {
    const report = buildReport({
      run: statuses({ [ES5_A]: "fail", [ES5_B]: "compile_error" }),
      meta: meta(),
      paths: new Set([ES5_A, ES5_B]),
      baseline: { statuses: statuses({ [ES5_A]: "pass", [ES5_B]: "pass" }), meta: meta({ sourceSha: "base" }) },
    });
    const line = regressionAnnotation(report);
    const match = /^::error title=([^:]+)::(.*)$/.exec(line);
    expect(match).not.toBeNull();
    // What GitHub stores: the workflow-command data, percent-decoded.
    const annotation = {
      title: match![1],
      message: match![2]!.replace(/%0A/g, "\n").replace(/%0D/g, "\r").replace(/%25/g, "%"),
    };
    expect(annotation.title).toBe(REGRESSION_ANNOTATION_TITLE);
    const { regressionNotes } = readJobAnnotations([annotation]);
    const comment = renderFailureLines([
      {
        job: "merge complete IR standalone measurement",
        url: null,
        failedSteps: ["Fail on an edition regression (#7551)"],
        notes: regressionNotes,
      },
    ]);
    expect(comment).toContain(`  - ${ES5_A} -> fail`);
    expect(comment).toContain(`  - ${ES5_B} -> compile_error`);
  });

  // Kept outside the files a gate rollback restores, so the owner's
  // no-auto-heal decision (2026-11-26) survives a rollback of the gate.
  it("the staleness alert only alerts: nothing in it dispatches a baseline refresh", () => {
    const code = readFileSync(join(process.cwd(), ".github/workflows/baseline-floor-staleness-alert.yml"), "utf-8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // No dispatch call (the messages may still NAME the manual lever).
    expect(code).not.toMatch(/gh workflow run|actions\/workflows\/[^"]*\/dispatches/);
    // Without actions:write it could not dispatch even if a step tried.
    expect(code).not.toMatch(/actions:\s*write/);
    // Still fails loudly on a breach.
    expect(code).toMatch(/if: steps\.staleness\.outputs\.breach == 'true'[\s\S]*?exit 1/);
  });

  it("the floor goes stale by age, after a missed daily promotion, not by merge count", () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    expect(floorAge("2026-11-25T22:30:00Z", now, DEFAULT_MAX_FLOOR_AGE_HOURS)).toEqual({
      ageHours: 37.5,
      breach: true,
    });
    expect(floorAge("2026-11-27T02:30:00Z", now, DEFAULT_MAX_FLOOR_AGE_HOURS)).toEqual({
      ageHours: 9.5,
      breach: false,
    });
    // No usable timestamp is "undetermined", never a false breach.
    expect(floorAge(null, now, DEFAULT_MAX_FLOOR_AGE_HOURS)).toBeNull();
    expect(floorAge("not a date", now, DEFAULT_MAX_FLOOR_AGE_HOURS)).toBeNull();
  });
});

describe("#7551 gh calls survive one transient GitHub error", () => {
  const failure = (stderr: string) => Object.assign(new Error("Command failed: gh api x"), { stderr });
  const scripted = (outcomes: (string | Error)[]) => {
    const calls: string[][] = [];
    const exec = (_: string, args: string[]) => {
      calls.push(args);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next!;
    };
    return { calls, exec };
  };

  it("retries an HTTP 5xx or a network failure with backoff, then returns the success", () => {
    const { calls, exec } = scripted([
      failure("HTTP 502: Bad Gateway"),
      failure("read: connection reset by peer"),
      "ok",
    ]);
    const slept: number[] = [];
    expect(ghWithRetry(["api", "x"], { exec, sleep: (s: number) => slept.push(s), log: () => {} })).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(slept).toEqual(GH_RETRY_DELAYS_SECONDS.slice(0, 2));
  });

  it("fails at once on an HTTP 4xx, and after the last retry on a persistent 5xx", () => {
    const notFound = scripted([failure("HTTP 404: Not Found"), "never"]);
    expect(() => ghWithRetry(["api", "x"], { exec: notFound.exec, sleep: () => {}, log: () => {} })).toThrow(/gh api/);
    expect(notFound.calls).toHaveLength(1);

    const down = scripted(Array.from({ length: 10 }, () => failure("HTTP 503")));
    expect(() => ghWithRetry(["api", "x"], { exec: down.exec, sleep: () => {}, log: () => {} })).toThrow();
    expect(down.calls).toHaveLength(GH_RETRY_DELAYS_SECONDS.length + 1);
  });

  it("retries a failed artifact download and clears its half-written --dir first", () => {
    const blob = failure('error downloading x: Get "https://blob/x.zip": unexpected EOF');
    const { calls, exec } = scripted([blob, "done"]);
    const cleaned: string[] = [];
    const args = ["run", "download", "42", "--name", "a", "--dir", "dest"];
    expect(ghWithRetry(args, { exec, sleep: () => {}, log: () => {}, clean: (d: string) => cleaned.push(d) })).toBe(
      "done",
    );
    expect(calls).toHaveLength(2);
    expect(cleaned).toEqual(["dest"]);
  });
});

describe("#7551 report CLI exit codes", () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "scripts/test262-edition-scope.ts", ...args], {
      encoding: "utf-8",
    });
  const write = (dir: string, rows: Record<string, string>, m: ScopeMeta) => {
    mkdirSync(dir, { recursive: true });
    const lines = Object.entries(rows).map(([file, status]) => JSON.stringify({ file, status }));
    writeFileSync(join(dir, "results.jsonl"), lines.join("\n") + "\n");
    writeFileSync(join(dir, "scope.json"), JSON.stringify(m));
  };
  const report = (run: string, baselineDir: string) =>
    cli([
      "report",
      ...["--results", join(run, "results.jsonl"), "--meta", join(run, "scope.json"), "--test262", root],
      ...["--baseline-dir", baselineDir, "--summary", join(run, "s.md"), "--json", join(run, "r.json")],
    ]);

  it("fails on a regression, passes on an unchanged run, and passes loudly without a baseline", () => {
    const base = join(root, "cli-base");
    const run = join(root, "cli-run");
    const same = join(root, "cli-same");
    write(base, { [ES5_A]: "pass", [ES5_B]: "fail" }, meta({ sourceSha: "base" }));
    write(run, { [ES5_A]: "fail", [ES5_B]: "fail" }, meta());
    write(same, { [ES5_A]: "pass", [ES5_B]: "pass" }, meta());

    const regressed = report(run, base);
    expect(regressed.status).toBe(REGRESSION_EXIT_CODE);
    expect(readFileSync(join(run, "s.md"), "utf-8")).toContain(ES5_A);
    expect(existsSync(join(run, "r.json"))).toBe(true);

    expect(report(same, base).status).toBe(0);
    expect(readFileSync(join(same, "s.md"), "utf-8")).toContain("Improvements (not pass → pass): 1");

    const missing = report(run, join(root, "absent"));
    expect(missing.status).toBe(0);
    expect(readFileSync(join(run, "s.md"), "utf-8")).toContain("No baseline — not compared");
  });

  it("a crash (truncated baseline JSONL) exits neither 0 nor the regression code, and writes no report", () => {
    const base = join(root, "cli-truncated");
    const run = join(root, "cli-crash");
    write(base, { [ES5_A]: "pass" }, meta({ sourceSha: "base" }));
    writeFileSync(join(base, "results.jsonl"), '{"file":"test/a.js","status":"pa');
    write(run, { [ES5_A]: "fail" }, meta());
    const crashed = report(run, base);
    expect([0, REGRESSION_EXIT_CODE]).not.toContain(crashed.status);
    expect(existsSync(join(run, "r.json"))).toBe(false);
  });
});
