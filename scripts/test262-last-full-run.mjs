#!/usr/bin/env node
// (#7551) The newest GREEN FULL test262 run on main: the daily schedule run,
// or a `workflow_dispatch` with `full_run=true` (e.g. before a release). A run
// counts as full only when both of its full-run producers succeeded — the
// legacy baseline promotion and the full-corpus IR measurement — so a plain
// legacy-only or IR-only dispatch never shortens "since the last green full
// run".
//
// Prints `<sha> <url> <created_at>` of that run, or nothing when none is found
// among the newest successful runs. Used by test262-sharded.yml (the commit
// range a failed daily run names) and baseline-floor-staleness-alert.yml.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ghWithRetry } from "./lib/gh-api-retry.mjs";

export const FULL_RUN_JOBS = ["promote merged report to main baseline", "merge complete IR standalone measurement"];
const RUNS_SCANNED_PER_EVENT = 10;

/** Did this run's jobs include a successful full run? */
export function isFullRun(jobs) {
  return FULL_RUN_JOBS.every((name) => jobs.some((j) => j.name === name && j.conclusion === "success"));
}

/** Newest-first successful schedule and dispatch runs; the first full one wins. */
export function lastFullRun(repo, gh = (args) => ghWithRetry(args)) {
  const runs = [];
  for (const event of ["schedule", "workflow_dispatch"]) {
    const page = JSON.parse(
      gh([
        "api",
        `repos/${repo}/actions/workflows/test262-sharded.yml/runs?branch=main&event=${event}&status=success&per_page=${RUNS_SCANNED_PER_EVENT}`,
      ]),
    );
    runs.push(...(page.workflow_runs ?? []));
  }
  runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const run of runs) {
    const jobs = gh([
      "api",
      "--paginate",
      `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
      "--jq",
      ".jobs[] | {name, conclusion}",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (isFullRun(jobs)) return { sha: run.head_sha, url: run.html_url, createdAt: run.created_at };
  }
  return null;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("test262-last-full-run: GITHUB_REPOSITORY is not set");
    process.exit(2);
  }
  const found = lastFullRun(repo);
  if (found) console.log(`${found.sha} ${found.url} ${found.createdAt}`);
}
