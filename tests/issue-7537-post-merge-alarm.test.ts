// #7537 — phase 1 of the post-merge test262 path: who is labelled, and that
// the alarm is posted once (owner decision 2026-11-27: label and alarm only,
// the lead reverts by hand after 24 h).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { addLabel, commentOnce } from "../scripts/lib/pr-label-comment.mjs";
import { readWatch } from "../scripts/lib/test262-timeout-watch.mjs";
import {
  LABEL,
  UNATTRIBUTED_LABEL,
  incidents,
  labelFor,
  markerFor,
  renderIncident,
} from "../scripts/test262-post-merge-alarm.mjs";
import { type ScopeMeta, buildReport, nearerUnfinished } from "../scripts/test262-edition-scope.ts";

const A = "test/built-ins/Object/create/15.2.3.5-1-1.js";
const B = "test/built-ins/Array/prototype/forEach/15.4.4.18-4-1.js";
const paths = new Set([A, B]);
const statuses = (o: Record<string, string>) => new Map(Object.entries(o));
const meta = (sourceSha: string): ScopeMeta => ({
  scope: "edition",
  edition: "ES5",
  sourceSha,
  test262Sha: "t262",
  evalEngine: "quickjs",
});

describe("#7537 attribution", () => {
  it("one PR is charged by name; several are all unattributed", () => {
    expect(labelFor([7600])).toBe(LABEL);
    expect(labelFor([7600, 7601])).toBe(UNATTRIBUTED_LABEL);
  });

  it("a fallback that widened the range to k > 1 labels all of them unattributed", () => {
    // The predecessor's run never finished, so the comparison falls back two
    // pushes: the range now holds both pushes' PRs.
    const report = buildReport({
      run: statuses({ [A]: "fail", [B]: "pass" }),
      meta: meta("c2"),
      paths,
      baseline: { statuses: statuses({ [A]: "pass", [B]: "pass" }), meta: meta("c0") },
    });
    const [incident] = incidents(report, "legacy", [7600, 7601, 7602]);
    expect(incident.prs).toEqual([7600, 7601, 7602]);
    expect(labelFor(incident.prs)).toBe(UNATTRIBUTED_LABEL);
  });

  it("while main stays red, the next push labels nothing", () => {
    const report = buildReport({
      run: statuses({ [A]: "fail", [B]: "pass" }),
      meta: meta("c3"),
      paths,
      baseline: { statuses: statuses({ [A]: "fail", [B]: "pass" }), meta: meta("c2") },
    });
    expect(incidents(report, "legacy", [7603])).toEqual([]);
  });

  it("the IR lane charges only confirmed repeats, never an ordinary regression (that one parks the group)", () => {
    const report = buildReport({
      run: statuses({ [A]: "compile_timeout", [B]: "fail" }),
      meta: meta("g2"),
      paths,
      baseline: {
        statuses: statuses({ [A]: "compile_timeout", [B]: "pass" }),
        meta: meta("p1"),
        watch: readWatch({ watch: [{ file: A, firstSeenSha: "p1", prs: [7590] }] }),
      },
      rechecked: new Set([A]),
    });
    const found = incidents(report, "ir", [7610, 7611]);
    expect(found).toEqual([
      {
        kind: "repeat",
        prs: [7590],
        suspects: [7610, 7611],
        rows: [{ file: A, now: "compile_timeout", firstSeenSha: "p1" }],
      },
    ]);
  });

  it("the comment names the charged PR, the second suspect and the 24 h deadline", () => {
    const incident = {
      kind: "repeat",
      prs: [7590],
      suspects: [7610],
      rows: [{ file: A, now: "fail", firstSeenSha: "p1" }],
    };
    const body = renderIncident({
      incident,
      lane: "ir",
      sha: "g2",
      runUrl: "https://run",
      now: new Date("2026-11-27T10:00:00Z"),
    });
    expect(body).toContain("Charged to #7590.");
    expect(body).toContain("Second suspect, not labelled: the change measured now (#7610)");
    expect(body).toContain("2026-11-28T10:00:00Z");
  });
});

describe("#7537 idempotent alarm", () => {
  it("the marker is stable for the same incident and differs for other rows", () => {
    const one = { kind: "regression", prs: [1], suspects: [], rows: [{ file: A, now: "fail" }] };
    const two = { ...one, rows: [{ file: B, now: "fail" }] };
    expect(markerFor("legacy", one)).toBe(markerFor("legacy", { ...one, suspects: [9] }));
    expect(markerFor("legacy", one)).not.toBe(markerFor("legacy", two));
  });

  it("commentOnce posts once; the label call goes to the REST endpoint", () => {
    const calls: string[][] = [];
    const posted: string[] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      if (args.includes("--paginate")) return posted.join("\n");
      const body = args.find((a) => a.startsWith("body="));
      if (body) posted.push(body.slice(5));
      return "";
    };
    expect(commentOnce(gh, "o/r", 1, "<!-- m -->", "hello")).toBe(true);
    expect(commentOnce(gh, "o/r", 1, "<!-- m -->", "hello")).toBe(false);
    expect(posted).toHaveLength(1);
    addLabel(gh, "o/r", 1, LABEL);
    expect(calls.at(-1)).toEqual(["api", "-X", "POST", "repos/o/r/issues/1/labels", "-f", `labels[]=${LABEL}`]);
  });
});

describe("#7537 waiting for the predecessor", () => {
  const lineage = ["c3", "c2", "c1"];
  it("waits for a nearer commit whose run is still in flight", () => {
    expect(nearerUnfinished(lineage, new Set(["c1"]), new Set(["c2"]))).toBe("c2");
  });
  it("does not wait for a commit beyond the nearest measured one, or when nothing is in flight", () => {
    expect(nearerUnfinished(lineage, new Set(["c3"]), new Set(["c2"]))).toBeUndefined();
    expect(nearerUnfinished(lineage, new Set(["c1"]), new Set())).toBeUndefined();
  });
});

describe("#7537 workflow wiring of the completed-edition push lane", () => {
  const workflow = readFileSync(".github/workflows/test262-sharded.yml", "utf8");
  const job = (name: string) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    const next = workflow.slice(start + 1).search(/\n {2}[\w-]+:\n/);
    return workflow.slice(start, next < 0 ? undefined : start + 1 + next);
  };

  it("the plan gives push the completed editions and everything else the full corpus", () => {
    const plan = job("compiler-path-measurement-plan");
    expect(plan).toContain("legacy_scope: ${{ steps.legacy.outputs.scope }}");
    expect(plan).toContain("completedChunks");
    expect(plan).toMatch(/if \[ "\$EVENT_NAME" = push \]; then\n\s+scope=completed/);
  });

  it("merge-report re-checks before the ratchet, which excuses only the listed first timeouts", () => {
    const report = job("merge-report");
    const verdict = report.indexOf(
      "scripts/test262-edition-verdict.sh merged-reports/test262-standalone-results-merged.jsonl",
    );
    const ratchet = report.indexOf("--listed-timeouts legacy-measurement/edition-report.json");
    expect(verdict).toBeGreaterThan(0);
    expect(ratchet).toBeGreaterThan(verdict);
  });

  it("uploads the measurement every run and alarms on push without ever failing the verdict", () => {
    const report = job("merge-report");
    expect(report).toContain("name: test262-legacy-completed-measurement");
    const alarm = report.slice(report.indexOf("Alarm the PRs a completed-edition failure is charged to (#7537)"));
    expect(alarm).toMatch(/^[^\n]*\n\s+if: always\(\) && github\.event_name == 'push'/);
    expect(alarm.slice(0, 400)).toContain("continue-on-error: true");
  });

  it("the whole-corpus gates run only under the full scope", () => {
    const report = job("merge-report");
    for (const name of ["Standalone pass-count high-water floor (#2097)", "Standalone regression guard (#1897)"]) {
      const step = report.slice(report.indexOf(`- name: ${name}`), report.indexOf(`- name: ${name}`) + 400);
      expect(step, name).toContain("env.LEGACY_SCOPE == 'full'");
    }
  });
});
