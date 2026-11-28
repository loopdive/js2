#!/usr/bin/env node
// #7537 — phase 1 of the post-merge test262 regression path: label and alarm,
// never revert (owner decision 2026-11-27). The lead reverts by hand after a
// 24 h window; the false-positive count of the first week decides whether this
// is ever automated.
//
//   pr-set --from <sha> --to <sha> --out <json>
//       the PRs the first-parent commits from..to merged (a queue push or a
//       merge group carries 2–5), as a JSON array
//   alarm --report <edition-report.json> --lane legacy|ir --prs <json> --run-url <url>
//         --measured-on main|merge-group [--repeats-only] [--group-history <dir> --group-base <sha>]
//       label and comment on the PRs the report charges, once, and post one
//       incident comment on the coordination PR; `--repeats-only` (the daily
//       full run) raises confirmed repeated timeouts only
//
// The report is untrusted: on merge_group the group's own scripts wrote it. So
// before anything is posted, every row, status and sha is checked for shape,
// every PR number must appear in a first-parent merge subject of the checked-out
// main (or of the merge group's own history, `--group-history`), and a repeat's
// origin is re-read from the baseline run's own `timeout-watch.json`, after
// checking that the run is this workflow's and measured a commit of main.
//
// Who is charged:
//   - a new confirmed completed-edition failure (legacy lane, push): the PRs of
//     this push — `post-merge-regression` when there is one, all of them
//     `post-merge-regression-unattributed` when there are several (no bisect in
//     phase 1);
//   - a confirmed repeated timeout (either lane): the PRs where the timeout
//     first appeared, by the same rule; this push or group is named as a second
//     suspect, unlabelled.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { prNumbersFromCommitSubjects } from "./auto-park-merge-group-failure.mjs";
import { COMPLETED_RULE_SHA, readWatch } from "./lib/test262-timeout-watch.mjs";

// Same default as auto-park; CI sets GH_REPO.
const REPO = process.env.GH_REPO || "loopdive/js2wasm";
const COORDINATION_PR = 7526;
export const LABEL = "post-merge-regression";
export const UNATTRIBUTED_LABEL = "post-merge-regression-unattributed";
const REVERT_WINDOW_HOURS = 24;
const LIST_LIMIT = 50;
/** How far back the checked-out main is searched for a PR's merge commit. */
const MAIN_LOG_DEPTH = 200;
const WORKFLOW_PATH = ".github/workflows/test262-sharded.yml";
/** The artifacts a baseline can come from (fetch-baseline's names). */
const BASELINE_ARTIFACTS = [
  "test262-ir-standalone-edition-measurement",
  "test262-ir-standalone-measurement",
  "test262-legacy-completed-measurement",
];

const FILE_SHAPE = /^test\/[\w./+-]+\.js$/;
const SHA_SHAPE = /^[0-9a-f]{40}$/;
const STATUSES = new Set(["pass", "fail", "compile_error", "compile_timeout", "skip", "missing"]);

// `gh` is `(args: string[]) => string` and throws on failure, as
// execFileSync("gh", args) does; injected so tests need no network.

/** The REST endpoint, as auto-park uses (`gh pr edit --add-label` has hit a Projects-classic error here). */
export function addLabel(gh, repo, pr, label) {
  gh(["api", "-X", "POST", `repos/${repo}/issues/${pr}/labels`, "-f", `labels[]=${label}`]);
}

/** Posts `body` unless a comment on the PR already carries `marker`, so a retried run posts nothing twice. */
export function commentOnce(gh, repo, pr, marker, body) {
  const existing = gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", ".[].body"]);
  if (existing.includes(marker)) return false;
  gh(["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${marker}\n${body}`]);
  return true;
}

/** One PR is charged by name; several share the charge, none of them singled out. */
export function labelFor(prs) {
  return prs.length === 1 ? LABEL : UNATTRIBUTED_LABEL;
}

/**
 * The part of an untrusted report the alarm may act on, and what it dropped.
 * `allowed` is the set of PR numbers merged on trusted history; `trustedWatch`
 * maps a file to its origin as the baseline run itself recorded it. Pure.
 */
export function sanitizeReport(report, currentPrs, allowed, trustedWatch) {
  const dropped = [];
  const keepPrs = (prs, what) =>
    (Array.isArray(prs) ? prs : []).filter((n) => {
      const ok = Number.isInteger(n) && allowed.has(n);
      if (!ok) dropped.push(`${what}: PR ${JSON.stringify(n)} is not a merge on trusted history`);
      return ok;
    });
  const rowOk = (r, what) => {
    const ok = typeof r?.file === "string" && FILE_SHAPE.test(r.file) && STATUSES.has(r.now);
    if (!ok) dropped.push(`${what}: ${JSON.stringify(r).slice(0, 200)}`);
    return ok;
  };
  const regressions = (report.diff?.regressions ?? []).filter((r) => rowOk(r, "regression row"));
  const confirmedRepeats = [];
  for (const r of report.diff?.confirmedRepeats ?? []) {
    if (!rowOk(r, "repeat row")) continue;
    const origin = trustedWatch.get(r.file);
    if (!origin || !SHA_SHAPE.test(origin.firstSeenSha)) {
      dropped.push(`repeat row ${r.file}: no origin in the baseline run's own timeout-watch.json`);
      continue;
    }
    const prs = keepPrs(origin.prs, `origin of ${r.file}`);
    confirmedRepeats.push({
      file: r.file,
      now: r.now,
      origin: { file: r.file, firstSeenSha: origin.firstSeenSha, prs },
    });
  }
  const sha = report.sourceSha;
  const clean = {
    sourceSha: SHA_SHAPE.test(sha) ? sha : "(unrecognised sha)",
    baseline: { sha: report.baseline?.sha === COMPLETED_RULE_SHA ? COMPLETED_RULE_SHA : report.baseline?.sha },
    diff: { regressions, confirmedRepeats },
  };
  return { report: clean, currentPrs: keepPrs(currentPrs, "current PR set"), dropped };
}

/**
 * The incidents a report raises, each with the PRs it charges and the rows.
 * Pure, so the attribution rules are tested without GitHub.
 */
export function incidents(report, lane, currentPrs, { repeatsOnly = false } = {}) {
  const out = [];
  const regressions = report.diff?.regressions ?? [];
  // A full (daily) run's new failures span a day of merges: its summary names
  // that commit range instead. Only its confirmed repeats have a known origin.
  // With no earlier measurement (the first push, an expired artifact, an engine
  // switch) the failures may predate every PR in range: noted, never charged.
  if (lane === "legacy" && !repeatsOnly && regressions.length > 0)
    out.push(
      report.baseline?.sha === COMPLETED_RULE_SHA
        ? { kind: "noBaseline", prs: [], suspects: [], rows: regressions }
        : { kind: "regression", prs: currentPrs, suspects: [], rows: regressions },
    );
  const byOrigin = new Map();
  for (const repeat of report.diff?.confirmedRepeats ?? []) {
    const key = repeat.origin.prs.join(",");
    if (!byOrigin.has(key))
      byOrigin.set(key, { kind: "repeat", prs: repeat.origin.prs, suspects: currentPrs, rows: [] });
    byOrigin.get(key).rows.push({ file: repeat.file, now: repeat.now, firstSeenSha: repeat.origin.firstSeenSha });
  }
  return [...out, ...byOrigin.values()];
}

/** Stable per incident, so a retried run or a rebuilt merge group finds its own comment. */
export function markerFor(lane, incident) {
  const rows = incident.rows.map((r) => `${r.file}:${r.now}`).sort();
  const hash = createHash("sha256")
    .update(JSON.stringify([lane, incident.kind, incident.prs, rows]))
    .digest("hex");
  return `<!-- test262-post-merge-alarm:${lane}:${hash.slice(0, 16)} -->`;
}

const pr = (n) => `#${n}`;

function listRows(rows) {
  const out = rows
    .slice(0, LIST_LIMIT)
    .map((r) => `- \`${r.file}\` → ${r.now}${r.firstSeenSha ? ` (first timed out at \`${r.firstSeenSha}\`)` : ""}`);
  if (rows.length > LIST_LIMIT) out.push(`- … and ${rows.length - LIST_LIMIT} more (see the run)`);
  return out;
}

/** Where the measurement ran: what landed on main, or a merge group that has not landed yet. */
const MEASURED_ON = {
  main: (sha) =>
    `This run measured main at \`${sha}\`, and it is the newest measurement of main when this alarm is posted.`,
  "merge-group": (sha) =>
    `This run measured a merge group at \`${sha}\`, which is not main yet; the next push run measures main.`,
};

export function renderIncident({ incident, lane, sha, runUrl, now, measuredOn }) {
  if (incident.kind === "noBaseline")
    return [
      `**test262: no earlier measurement: ${incident.rows.length} completed-edition rows fail; not attributed** (legacy lane, main at \`${sha}\`).`,
      "They were compared with the completed rule only, so they may predate every PR of this push; no PR is labelled.",
      "",
      ...listRows(incident.rows),
      "",
      `The run: ${runUrl}`,
    ].join("\n");
  const deadline = new Date(now.getTime() + REVERT_WINDOW_HOURS * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const what =
    incident.kind === "regression"
      ? `**test262: ${incident.rows.length} completed-edition test(s) stopped passing after this merge** (legacy lane, push to main at \`${sha}\`).`
      : `**test262: ${incident.rows.length} test(s) timed out again** (${lane} lane, measured at \`${sha}\`). Their compile first timed out where these PR(s) merged.`;
  const charged =
    incident.prs.length === 1
      ? `Charged to ${pr(incident.prs[0])}.`
      : `Not attributable to one PR: charged to all of ${incident.prs.map(pr).join(", ") || "(no PR found)"}.`;
  const suspects =
    incident.suspects.length > 0
      ? `\nSecond suspect, not labelled: the change measured now (${incident.suspects.map(pr).join(", ")}).`
      : "";
  return [
    what,
    charged + suspects,
    "",
    ...listRows(incident.rows),
    "",
    `${MEASURED_ON[measuredOn](sha)} It fails these rows: ${runUrl}`,
    "",
    `**Revert window:** a fix-forward PR is expected by **${deadline}** (24 h from this alarm). After that, if the`,
    "latest push run on main still fails these rows, the lead reverts by hand (#7537 phase 1: nothing reverts",
    "automatically).",
  ].join("\n");
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function arg(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error(`missing ${name}`);
  return args[i + 1];
}

function cmdPrSet(args) {
  const subjects = execFileSync(
    "git",
    ["log", "--first-parent", "--format=%s", `${arg(args, "--from")}..${arg(args, "--to")}`],
    {
      encoding: "utf8",
    },
  ).split("\n");
  const prs = prNumbersFromCommitSubjects(subjects);
  writeFileSync(arg(args, "--out"), JSON.stringify(prs) + "\n");
  console.log(`PR set: ${prs.map(pr).join(", ") || "(none)"}`);
}

function gitLog(dir, range, format) {
  return execFileSync("git", ["-C", dir, "log", "--first-parent", `--format=${format}`, ...range], {
    encoding: "utf8",
  }).split("\n");
}

/** PR numbers merged on trusted history: the checked-out main, plus a merge group's own commits. */
function trustedPrs(args) {
  const subjects = gitLog(".", ["-n", String(MAIN_LOG_DEPTH)], "%s");
  const history = args.includes("--group-history") ? arg(args, "--group-history") : undefined;
  if (history) subjects.push(...gitLog(history, [`${arg(args, "--group-base")}..HEAD`], "%s"));
  return new Set(prNumbersFromCommitSubjects(subjects));
}

/**
 * The watch list the baseline run uploaded, read from that run rather than from
 * the report. Empty, with a warning, unless the run is this workflow's and
 * measured a commit of the checked-out main.
 */
function trustedWatch(runId) {
  const refuse = (why) => {
    console.log(`::warning::post-merge alarm: no trusted origin for repeats (${why})`);
    return new Map();
  };
  if (!Number.isInteger(runId)) return refuse("the report names no baseline run");
  const run = JSON.parse(gh(["api", `repos/${REPO}/actions/runs/${runId}`]));
  if (!String(run.path).startsWith(WORKFLOW_PATH)) return refuse(`run ${runId} is not ${WORKFLOW_PATH}`);
  if (!gitLog(".", ["-n", String(MAIN_LOG_DEPTH)], "%H").includes(run.head_sha))
    return refuse(`run ${runId} measured ${run.head_sha}, not a commit of main`);
  const names = gh(["api", `repos/${REPO}/actions/runs/${runId}/artifacts`, "--jq", ".artifacts[].name"]).split("\n");
  const name = BASELINE_ARTIFACTS.find((n) => names.includes(n));
  if (!name) return refuse(`run ${runId} has no baseline artifact`);
  const dir = mkdtempSync(join(tmpdir(), "alarm-baseline-"));
  gh(["run", "download", String(runId), "--repo", REPO, "--name", name, "--dir", dir]);
  const file = join(dir, "timeout-watch.json");
  return existsSync(file) ? readWatch(JSON.parse(readFileSync(file, "utf8"))) : refuse(`${name} has no watch list`);
}

function cmdAlarm(args) {
  const raw = JSON.parse(readFileSync(arg(args, "--report"), "utf8"));
  const lane = arg(args, "--lane");
  const runUrl = arg(args, "--run-url");
  const measuredOn = arg(args, "--measured-on");
  if (!(measuredOn in MEASURED_ON)) throw new Error(`--measured-on must be main or merge-group, not ${measuredOn}`);
  const watch = (raw.diff?.confirmedRepeats ?? []).length > 0 ? trustedWatch(raw.baseline?.runId) : new Map();
  const { report, currentPrs, dropped } = sanitizeReport(
    raw,
    JSON.parse(readFileSync(arg(args, "--prs"), "utf8")),
    trustedPrs(args),
    watch,
  );
  for (const why of dropped) console.log(`::warning::post-merge alarm dropped ${why}`);
  const found = incidents(report, lane, currentPrs, { repeatsOnly: args.includes("--repeats-only") });
  if (found.length === 0) {
    console.log("post-merge alarm: nothing to raise");
    return;
  }
  for (const incident of found) {
    const marker = markerFor(lane, incident);
    const body = renderIncident({ incident, lane, sha: report.sourceSha, runUrl, now: new Date(), measuredOn });
    for (const n of incident.prs) {
      addLabel(gh, REPO, n, labelFor(incident.prs));
      commentOnce(gh, REPO, n, marker, body);
    }
    commentOnce(gh, REPO, COORDINATION_PR, marker, body);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${body}\n`);
    console.log(
      `post-merge alarm (${incident.kind}): ${incident.prs.map(pr).join(", ") || "no PR"} — ${incident.rows.length} row(s)`,
    );
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "pr-set") cmdPrSet(args);
  else if (command === "alarm") cmdAlarm(args);
  else {
    console.error("usage: test262-post-merge-alarm.mjs pr-set|alarm …");
    process.exit(2);
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
