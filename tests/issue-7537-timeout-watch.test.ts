// #7537 — a first pass -> compile_timeout is listed and watched, not gated; a
// repeat in the next measurement is charged to the PRs where the timeout first
// appeared (owner decision 2026-11-27). Covers the shared helper and its use by
// the per-test comparison of scripts/test262-edition-scope.ts, plus the
// re-check plumbing (`candidates`, `override`) and the completed-edition scope.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyRow, nextWatch, readWatch } from "../scripts/lib/test262-timeout-watch.mjs";
import {
  LEGACY_ARTIFACT,
  type ScopeMeta,
  baselineCandidates,
  buildReport,
  overrideRows,
  readCompletedYears,
  recheckCandidates,
  scopePaths,
} from "../scripts/test262-edition-scope.ts";

const A = "test/built-ins/Object/create/15.2.3.5-1-1.js";
const B = "test/built-ins/Array/prototype/forEach/15.4.4.18-4-1.js";
const ES2015 = "test/built-ins/Map/constructor.js";
const paths = new Set([A, B]);
const statuses = (o: Record<string, string>) => new Map(Object.entries(o));
const meta = (sourceSha: string): ScopeMeta => ({
  scope: "edition",
  edition: "ES5",
  sourceSha,
  test262Sha: "t262",
  evalEngine: "quickjs",
});

describe("#7537 classifyRow", () => {
  it("lists a first timeout and gates an ordinary regression", () => {
    expect(classifyRow("pass", false, "compile_timeout", false)).toBe("listed");
    expect(classifyRow("pass", false, "fail", false)).toBe("regression");
    expect(classifyRow("pass", false, "pass", false)).toBe("pass");
  });

  it("never gates a row that never passed", () => {
    expect(classifyRow("compile_timeout", false, "compile_timeout", false)).toBe("unchanged");
    expect(classifyRow("fail", false, "pass", false)).toBe("improvement");
  });

  it("a watched row: re-check on a repeat, resolve on pass, a fail is a confirmed repeat", () => {
    expect(classifyRow("compile_timeout", true, "compile_timeout", false)).toBe("recheck");
    expect(classifyRow("compile_timeout", true, "compile_timeout", true)).toBe("confirmedRepeat");
    expect(classifyRow("compile_timeout", true, "fail", false)).toBe("confirmedRepeat");
    expect(classifyRow("compile_timeout", true, "pass", false)).toBe("resolved");
    expect(classifyRow("compile_timeout", true, "pass", true)).toBe("flake");
  });

  it("a re-checked regression that passes is a flake", () => {
    expect(classifyRow("pass", false, "pass", true)).toBe("flake");
  });
});

describe("#7537 nextWatch", () => {
  const origin = { file: A, firstSeenSha: "p1", prs: [101] };
  it("adds first sightings with this measurement's origin and keeps the old origin while in question", () => {
    const watch = readWatch({ watch: [origin] });
    expect(nextWatch(new Map(), new Map([[A, "listed" as const]]), { sha: "p1", prs: [101] })).toEqual([origin]);
    expect(nextWatch(watch, new Map([[A, "flake" as const]]), { sha: "p2", prs: [102] })).toEqual([origin]);
    expect(nextWatch(watch, new Map([[A, "recheck" as const]]), { sha: "p2", prs: [102] })).toEqual([origin]);
  });

  it("drops resolved and confirmed rows", () => {
    const watch = readWatch({ watch: [origin] });
    expect(nextWatch(watch, new Map([[A, "resolved" as const]]), { sha: "p2", prs: [102] })).toEqual([]);
    expect(nextWatch(watch, new Map([[A, "confirmedRepeat" as const]]), { sha: "p2", prs: [102] })).toEqual([]);
  });
});

describe("#7537 the P1/P2/P3 sequence never parks a later group", () => {
  it("P1 merges on a first timeout; P2's repeat alarms P1 and P3 is clean", () => {
    // P0 → P1: A first times out. Listed, not gated; the watch names P1.
    const p1 = buildReport({
      run: statuses({ [A]: "compile_timeout", [B]: "pass" }),
      meta: meta("p1"),
      paths,
      baseline: { statuses: statuses({ [A]: "pass", [B]: "pass" }), meta: meta("p0") },
      prs: [101],
    });
    expect(p1.diff?.regressions).toEqual([]);
    expect(p1.diff?.timeouts).toEqual([A]);
    expect(p1.timeoutWatch).toEqual([{ file: A, firstSeenSha: "p1", prs: [101] }]);

    // P2 (base p1): A times out again. Before the re-check it awaits one.
    const p2base = { statuses: statuses({ [A]: "compile_timeout", [B]: "pass" }), meta: meta("p1") };
    const watch = readWatch({ watch: p1.timeoutWatch });
    const pre = buildReport({
      run: statuses({ [A]: "compile_timeout", [B]: "pass" }),
      meta: meta("p2"),
      paths,
      baseline: { ...p2base, watch },
      prs: [102],
    });
    expect(pre.diff?.regressions).toEqual([]);
    expect(recheckCandidates(pre)).toEqual({ watched: [A], other: [] });

    // The raised-timeout re-check still times out: a confirmed repeat, charged
    // to P1, not a regression of P2 — P2 is not parked.
    const post = buildReport({
      run: statuses({ [A]: "compile_timeout", [B]: "pass" }),
      meta: meta("p2"),
      paths,
      baseline: { ...p2base, watch },
      rechecked: new Set([A]),
      prs: [102],
    });
    expect(post.diff?.regressions).toEqual([]);
    expect(post.diff?.confirmedRepeats).toEqual([
      { file: A, now: "compile_timeout", origin: { file: A, firstSeenSha: "p1", prs: [101] } },
    ]);
    expect(post.timeoutWatch).toEqual([]);

    // P3 (base p2): A is a known failure now — neither gated nor re-alarmed.
    const p3 = buildReport({
      run: statuses({ [A]: "compile_timeout", [B]: "pass" }),
      meta: meta("p3"),
      paths,
      baseline: {
        statuses: statuses({ [A]: "compile_timeout", [B]: "pass" }),
        meta: meta("p2"),
        watch: readWatch({ watch: post.timeoutWatch }),
      },
      prs: [103],
    });
    expect(p3.diff?.regressions).toEqual([]);
    expect(p3.diff?.confirmedRepeats).toEqual([]);
    expect(p3.diff?.timeouts).toEqual([]);
  });

  it("a watched row that now fails is a confirmed repeat, and one that is dropped still gates", () => {
    const base = {
      statuses: statuses({ [A]: "compile_timeout", [B]: "pass" }),
      meta: meta("p1"),
      watch: readWatch({ watch: [{ file: A, firstSeenSha: "p1", prs: [101] }] }),
    };
    const failed = buildReport({
      run: statuses({ [A]: "fail", [B]: "pass" }),
      meta: meta("p2"),
      paths,
      baseline: base,
    });
    expect(failed.diff?.confirmedRepeats.map((x) => x.file)).toEqual([A]);
    const dropped = buildReport({ run: statuses({ [B]: "pass" }), meta: meta("p2"), paths, baseline: base });
    expect(dropped.diff?.regressions).toEqual([{ file: A, now: "missing" }]);
  });
});

describe("#7537 re-check plumbing", () => {
  it("re-checks every present regression and the watched repeats, not a dropped row", () => {
    const report = buildReport({
      run: statuses({ [A]: "fail" }),
      meta: meta("p2"),
      paths,
      baseline: { statuses: statuses({ [A]: "pass", [B]: "pass" }), meta: meta("p1") },
    });
    expect(recheckCandidates(report)).toEqual({ watched: [], other: [A] });
  });

  it("a re-checked row replaces the shard row and is marked", () => {
    const rows = overrideRows(
      [
        { file: A, status: "fail" },
        { file: B, status: "pass" },
      ],
      [{ file: A, status: "pass", compileMs: 9 }],
    );
    expect(rows).toEqual([
      { file: A, status: "pass", compileMs: 9, recheck: true },
      { file: B, status: "pass" },
    ]);
  });

  it("a re-check that passes clears the regression and reports a flake", () => {
    const report = buildReport({
      run: statuses({ [A]: "pass", [B]: "pass" }),
      meta: meta("p2"),
      paths,
      baseline: { statuses: statuses({ [A]: "pass", [B]: "pass" }), meta: meta("p1") },
      rechecked: new Set([A]),
    });
    expect(report.diff?.regressions).toEqual([]);
    expect(report.diff?.flakes).toEqual([A]);
  });
});

describe("#7537 the legacy lane's completed-edition scope", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "issue-7537-"));
    const files = { [A]: "es5id: 15.2.3.5-1-1", [B]: "es5id: 15.4.4.18-4-1", [ES2015]: "es6id: 23.1.1.1" };
    for (const [rel, yaml] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), `/*---\n${yaml}\n---*/\nassert(true);\n`);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads the completed editions from the ratchet baseline (ES5 today) and lists only their files", () => {
    const committed = readCompletedYears();
    expect(committed).toContain(5);
    const baseline = join(root, "ratchet.json");
    writeFileSync(
      baseline,
      JSON.stringify({ editions: { "5": { completed: true, ratcheted: true }, "2015": { ratcheted: true } } }),
    );
    expect(readCompletedYears(baseline)).toEqual([5]);
    expect(scopePaths(root, { label: "ES5", years: [5] })).toEqual([B, A].sort());
  });

  it("refuses a baseline with no completed edition", () => {
    const baseline = join(root, "none.json");
    writeFileSync(baseline, JSON.stringify({ editions: { "5": { ratcheted: true } } }));
    expect(() => readCompletedYears(baseline)).toThrow();
  });

  it("the legacy artifact is looked up on its own, never as an IR measurement", () => {
    const art = (name: string, sha: string) => ({ id: 1, name, runId: 1, sha, createdAt: "2026-11-27T00:00:00Z" });
    const lineage = ["c1", "c0"];
    const artifacts = [art("test262-ir-standalone-edition-measurement", "c1"), art(LEGACY_ARTIFACT, "c0")];
    expect(baselineCandidates(lineage, artifacts, [LEGACY_ARTIFACT]).map((c) => c.artifact.sha)).toEqual(["c0"]);
  });

  it("the committed current-edition config carries the legacy lane's shard count", () => {
    const config = JSON.parse(readFileSync("scripts/test262-current-edition.json", "utf-8"));
    expect(Number.isInteger(config.completedChunks) && config.completedChunks > 0).toBe(true);
  });
});
