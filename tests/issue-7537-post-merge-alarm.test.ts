// #7537 — phase 1 of the post-merge test262 path: who is labelled, and that
// the alarm is posted once (owner decision 2026-11-27: label and alarm only,
// the lead reverts by hand after 24 h).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { COMPLETED_RULE_SHA, readWatch } from "../scripts/lib/test262-timeout-watch.mjs";
import {
  LABEL,
  UNATTRIBUTED_LABEL,
  addLabel,
  commentOnce,
  incidents,
  labelFor,
  markerFor,
  renderIncident,
  sanitizeReport,
} from "../scripts/test262-post-merge-alarm.mjs";
import {
  type ScopeMeta,
  buildReport,
  completedRuleStatuses,
  nearerUnfinished,
} from "../scripts/test262-edition-scope.ts";

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
      measuredOn: "merge-group",
    });
    expect(body).toContain("Charged to #7590.");
    expect(body).toContain("Second suspect, not labelled: the change measured now (#7610)");
    expect(body).toContain("2026-11-28T10:00:00Z");
    // A merge group is not main yet; the comment says so instead of claiming main fails.
    expect(body).toContain("measured a merge group at `g2`, which is not main yet");
  });

  it("the daily full run raises only confirmed repeats, never its day-wide new failures", () => {
    const report = {
      diff: {
        regressions: [{ file: A, now: "fail" }],
        confirmedRepeats: [{ file: B, now: "compile_timeout", origin: { file: B, firstSeenSha: "p1", prs: [7590] } }],
      },
    };
    expect(incidents(report, "legacy", [7600], { repeatsOnly: true }).map((i) => i.kind)).toEqual(["repeat"]);
    expect(incidents(report, "legacy", [7600]).map((i) => i.kind)).toEqual(["regression", "repeat"]);
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

describe("#7537 no earlier measurement: the completed rule is the baseline", () => {
  it("a first run still finds and re-checks a completed-edition failure, but charges no PR", () => {
    const paths = new Set([A, B]);
    const report = buildReport({
      run: statuses({ [A]: "fail", [B]: "pass" }),
      meta: meta("c1"),
      paths,
      baseline: {
        statuses: completedRuleStatuses(paths, new Set()),
        meta: { ...meta("c1"), sourceSha: COMPLETED_RULE_SHA },
      },
    });
    expect(report.diff?.regressions).toEqual([{ file: A, now: "fail" }]);
    // The failure may predate every PR of the push: one notice, no label.
    const [incident] = incidents(report, "legacy", [7600]);
    expect(incident).toMatchObject({ kind: "noBaseline", prs: [] });
    const body = renderIncident({
      incident,
      lane: "legacy",
      sha: "c1",
      runUrl: "https://run",
      now: new Date(),
      measuredOn: "main",
    });
    expect(body).toContain("no earlier measurement: 1 completed-edition rows fail; not attributed");
    expect(body).not.toContain("Revert window");
  });

  it("a row the earlier measurement lacks counts as passing, but a reviewed exception never does", () => {
    const paths = new Set([A, B]);
    const rule = completedRuleStatuses(paths, new Set([B]), statuses({}));
    expect(rule.get(A)).toBe("pass");
    expect(rule.has(B)).toBe(false);
    // The earlier measurement's own verdict wins where it has one.
    expect(completedRuleStatuses(paths, new Set(), statuses({ [A]: "fail" })).get(A)).toBe("fail");
  });
});

describe("#7537 the alarm trusts no number the report supplies", () => {
  const sha = "a".repeat(40);
  const allowed = new Set([7590, 7600]);
  const repeat = (file: string, prs: number[]) => ({
    file,
    now: "compile_timeout",
    origin: { file, firstSeenSha: sha, prs },
  });

  it("drops PR numbers that are not merges on trusted history, and malformed rows", () => {
    const report = {
      sourceSha: sha,
      diff: {
        regressions: [
          { file: A, now: "fail" },
          { file: "../../etc/passwd", now: "fail" },
          { file: B, now: "<b>forged</b>" },
        ],
        confirmedRepeats: [],
      },
    };
    const clean = sanitizeReport(report, [7600, 1, "7601"], allowed, new Map());
    expect(clean.currentPrs).toEqual([7600]);
    expect(clean.report.diff.regressions).toEqual([{ file: A, now: "fail" }]);
    expect(clean.dropped).toHaveLength(4);
  });

  it("a repeat's origin comes from the baseline run's own watch list, never from the report", () => {
    const report = {
      sourceSha: "not-a-sha",
      diff: { regressions: [], confirmedRepeats: [repeat(A, [1]), repeat(B, [7590])] },
    };
    const watch = readWatch({ watch: [{ file: A, firstSeenSha: sha, prs: [7590] }] });
    const clean = sanitizeReport(report, [], allowed, watch);
    expect(clean.report.diff.confirmedRepeats).toEqual([repeat(A, [7590])]);
    expect(clean.report.sourceSha).toBe("(unrecognised sha)");
    expect(clean.dropped.join("\n")).toContain(B);
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

  it("merge-report re-checks before the merged report is built, and the ratchet excuses only listed first timeouts", () => {
    const report = job("merge-report");
    const verdict = report.indexOf(
      "scripts/test262-edition-verdict.sh merged-reports/test262-standalone-results-merged.jsonl",
    );
    const build = report.indexOf("- name: Build merged standalone test262 report");
    const ratchet = report.indexOf("--listed-timeouts legacy-measurement/edition-report.json");
    expect(verdict).toBeGreaterThan(0);
    // The floor, the #1897 guard and promotion read the report built after the override.
    expect(build).toBeGreaterThan(verdict);
    expect(ratchet).toBeGreaterThan(verdict);
    expect(report).toContain("EXPECTED_SHARDS: ${{ needs.compiler-path-measurement-plan.outputs.legacy_chunks }}");
  });

  it("uploads the measurement every run; only the separate alarm job can write, and it runs no measured code", () => {
    expect(job("merge-report")).toContain("name: test262-legacy-completed-measurement");
    for (const name of ["merge-report", "merge-ir-measurement"]) {
      expect(job(name), name).not.toMatch(/pull-requests: write|issues: write/);
      expect(job(name), name).toContain("persist-credentials: false");
      expect(job(name), name).toMatch(/timeout-minutes: \d+/);
    }
    const alarm = job("post-merge-alarm");
    expect(alarm).toContain("pull-requests: write");
    expect(alarm).toContain(
      "ref: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.sha }}",
    );
    expect(alarm).not.toMatch(/pnpm install|vitest|test262-runner-setup/);
    // Every step after the checkout is continue-on-error: an alarm never fails a run.
    const steps = alarm.split("\n      - ").slice(2);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(step).toContain("continue-on-error: true");
    expect(alarm).toContain("--repeats-only");
    // PR numbers are checked against main's history, so the checkout carries it.
    expect(alarm).toContain("fetch-depth: 200");
    expect(alarm).toMatch(/uses: actions\/setup-node@v6\n\s+continue-on-error: true\n\s+with:\n\s+node-version: "25"/);
  });

  it("the whole-corpus gates run only under the full scope", () => {
    const report = job("merge-report");
    for (const name of ["Standalone pass-count high-water floor (#2097)", "Standalone regression guard (#1897)"]) {
      const step = report.slice(report.indexOf(`- name: ${name}`), report.indexOf(`- name: ${name}`) + 400);
      expect(step, name).toContain("env.LEGACY_SCOPE == 'full'");
    }
  });
});
