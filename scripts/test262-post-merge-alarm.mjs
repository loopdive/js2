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
//         --measured-on main|merge-group [--repeats-only]
//       label and comment on the PRs the report charges, once, and post one
//       incident comment on the coordination PR; `--repeats-only` (the daily
//       full run) raises confirmed repeated timeouts only
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
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prNumbersFromCommitSubjects } from "./auto-park-merge-group-failure.mjs";

// Same default as auto-park; CI sets GH_REPO.
const REPO = process.env.GH_REPO || "loopdive/js2wasm";
const COORDINATION_PR = 7526;
export const LABEL = "post-merge-regression";
export const UNATTRIBUTED_LABEL = "post-merge-regression-unattributed";
const REVERT_WINDOW_HOURS = 24;
const LIST_LIMIT = 50;

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
 * The incidents a report raises, each with the PRs it charges and the rows.
 * Pure, so the attribution rules are tested without GitHub.
 */
export function incidents(report, lane, currentPrs, { repeatsOnly = false } = {}) {
  const out = [];
  const regressions = report.diff?.regressions ?? [];
  // A full (daily) run's new failures span a day of merges: its summary names
  // that commit range instead. Only its confirmed repeats have a known origin.
  if (lane === "legacy" && !repeatsOnly && regressions.length > 0)
    out.push({ kind: "regression", prs: currentPrs, suspects: [], rows: regressions });
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

/** Where the measurement ran: what landed on main, or a merge group that has not landed yet. */
const MEASURED_ON = {
  main: (sha) =>
    `This run measured main at \`${sha}\`, and it is the newest measurement of main when this alarm is posted.`,
  "merge-group": (sha) =>
    `This run measured a merge group at \`${sha}\`, which is not main yet; the next push run measures main.`,
};

export function renderIncident({ incident, lane, sha, runUrl, now, measuredOn }) {
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
  const rows = incident.rows
    .slice(0, LIST_LIMIT)
    .map((r) => `- \`${r.file}\` → ${r.now}${r.firstSeenSha ? ` (first timed out at \`${r.firstSeenSha}\`)` : ""}`);
  if (incident.rows.length > LIST_LIMIT) rows.push(`- … and ${incident.rows.length - LIST_LIMIT} more (see the run)`);
  return [
    what,
    charged + suspects,
    "",
    ...rows,
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

function cmdAlarm(args) {
  const report = JSON.parse(readFileSync(arg(args, "--report"), "utf8"));
  const lane = arg(args, "--lane");
  const currentPrs = JSON.parse(readFileSync(arg(args, "--prs"), "utf8"));
  const runUrl = arg(args, "--run-url");
  const measuredOn = arg(args, "--measured-on");
  if (!(measuredOn in MEASURED_ON)) throw new Error(`--measured-on must be main or merge-group, not ${measuredOn}`);
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
