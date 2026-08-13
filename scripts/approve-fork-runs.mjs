#!/usr/bin/env node
// approve-fork-runs.mjs — auto-approve `action_required` workflow runs from the
// TRUSTED fork only.
//
// WHY THIS EXISTS (#1958c): workflow runs triggered by PRs from a fork need a
// maintainer to click "Approve and run" the first time (GitHub's fork-PR
// safety gate). Our dev agents all push to the `ttraenkler/js2` fork and open
// PRs against `loopdive/js2wasm`, so EVERY one of their CI runs lands in
// `action_required` until a human approves it. On 2026-06-12 ~90 runs stranded
// this way until a tech-lead session swept them by hand — and that manual sweep
// dies with the session. This script approves the backlog automatically on a
// schedule + on each workflow_run event.
//
// SECURITY — TRUSTED FORK ONLY. We approve a run ONLY when its
// head_repository.full_name is exactly `ttraenkler/js2` (the team's own fork,
// configurable via TRUSTED_FORK). Arbitrary forks are NEVER auto-approved —
// approving them would run untrusted PR code with repo secrets. A drive-by
// contributor's run stays in action_required for a human to review, exactly as
// GitHub intends.
//
// TOKEN: the approve endpoint (POST .../actions/runs/{id}/approve) requires a
// token with `actions:write` AND repo write access acting as a USER or a PAT —
// the default GITHUB_TOKEN (github-actions[bot]) is NOT permitted to approve
// fork runs (GitHub returns 403 "Resource not accessible by integration"). So
// the workflow passes secrets.AUTO_ENQUEUE_TOKEN (the same PAT the auto-enqueue
// workflow already uses). If that secret is unset the script
// still runs but every approve 403s; it prints a clear pointer to this note.
//
// Runs in GitHub Actions (.github/workflows/approve-fork-runs.yml) on a 10-min
// cron + workflow_run, and by hand: `node scripts/approve-fork-runs.mjs`.
// DRY RUN: `DRY_RUN=1 node scripts/approve-fork-runs.mjs` lists what it would
// approve without mutating anything.

import { execFileSync } from "node:child_process";

const DRY = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const REPO = process.env.GH_REPO || "loopdive/js2wasm";
const TRUSTED_FORK = process.env.TRUSTED_FORK || "ttraenkler/js2";
const MAX_APPROVE = Number(process.env.MAX_APPROVE || 100);

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
function ghMaybe(args) {
  try {
    return { ok: true, stdout: gh(args), stderr: "" };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ""), stderr: String(e.stderr || e.message || e) };
  }
}
function log(msg) {
  console.log(`[approve-fork-runs ${new Date().toISOString()}] ${msg}`);
}

// List action_required runs. Project to just the fields we need (the full
// payload is ~10 KB/run and ENOBUFS-prone at scale).
const out = gh([
  "api",
  `repos/${REPO}/actions/runs?status=action_required&per_page=100`,
  "-q",
  ".workflow_runs[] | {id, name, head_branch, fork: .head_repository.full_name}",
]).trim();
const runs = out ? out.split("\n").map((l) => JSON.parse(l)) : [];

if (runs.length === 0) {
  log("no action_required runs — nothing to do");
  process.exit(0);
}

let approved = 0;
let skipped = 0;
let failed = 0;
for (const run of runs) {
  if (run.fork !== TRUSTED_FORK) {
    log(`skip run ${run.id} (${run.name}) — head_repository=${run.fork} is not the trusted fork ${TRUSTED_FORK}`);
    skipped++;
    continue;
  }
  if (approved >= MAX_APPROVE) {
    log(`approve cap (${MAX_APPROVE}) reached — leaving the rest for the next cycle`);
    break;
  }
  if (DRY) {
    log(`would approve run ${run.id} (${run.name}) on ${run.head_branch} from ${run.fork}`);
    approved++;
    continue;
  }
  const res = ghMaybe(["api", "--method", "POST", `repos/${REPO}/actions/runs/${run.id}/approve`]);
  if (res.ok) {
    log(`approved run ${run.id} (${run.name}) on ${run.head_branch}`);
    approved++;
  } else {
    const msg = (res.stderr || "").split("\n")[0].slice(0, 160);
    failed++;
    if (/not accessible by integration|Resource not accessible/i.test(msg)) {
      log(
        `FAILED run ${run.id}: ${msg} — the GITHUB_TOKEN cannot approve fork runs. ` +
          `Set the AUTO_ENQUEUE_TOKEN PAT secret (repo write + actions:write) on this workflow.`,
      );
    } else {
      log(`FAILED run ${run.id}: ${msg}`);
    }
  }
}

log(
  `cycle done: ${runs.length} action_required, ${approved} ${DRY ? "would be " : ""}approved, ${skipped} non-trusted skipped, ${failed} failed`,
);
process.exit(0);
