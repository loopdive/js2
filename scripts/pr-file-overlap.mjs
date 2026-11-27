#!/usr/bin/env node
/**
 * Which open pull requests change the files you are working on? (#7559)
 *
 *   node scripts/pr-file-overlap.mjs                     # this branch's changes (default: --branch)
 *   node scripts/pr-file-overlap.mjs --paths a.ts b.ts   # files you intend to touch
 *   node scripts/pr-file-overlap.mjs --issue 7559        # paths named in that issue's Implementation Plan
 *     [--exclude-pr N] [--json] [--timeout <seconds>] [--max-lines <n>]
 *
 * ADVISORY. An overlap is information, not an error: exit 0 whenever the check
 * ran (or could not reach GitHub), exit 2 only for a usage error. Settle an
 * overlap with the other lane on the standing coordination PR #7526. The last
 * line is always the verdict, so it survives a pipe.
 *
 * It replaces the manual lock table plan/method/file-locks.md, which rotted
 * because nothing forced an entry in or out; open PRs' file lists cannot rot.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  findPathOverlaps,
  formatOverlaps,
  isIgnoredOverlapPath,
  issuePlanPaths,
  openPrFiles,
  repoSlug,
  truncatedUnlisted,
} from "./lib/open-pr-files.mjs";

const USAGE =
  "usage: node scripts/pr-file-overlap.mjs [--branch | --paths <p…> | --issue <id>] " +
  "[--exclude-pr N] [--json] [--timeout <seconds>] [--max-lines <n>]";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lines = (text) => text.split("\n").filter(Boolean);
const firstLine = (error) =>
  String(error?.stderr || error?.message || error)
    .trim()
    .split("\n")[0];

/** Upstream's main when `origin` is a fork that has one, else origin's (as the hooks resolve it). */
function mainRef() {
  try {
    git("rev-parse", "--verify", "--quiet", "upstream/main");
    return "upstream/main";
  } catch {
    return "origin/main";
  }
}

/** Committed changes since the merge-base with main, plus uncommitted tracked edits. */
function branchPaths() {
  const base = git("merge-base", mainRef(), "HEAD");
  return [
    ...new Set([...lines(git("diff", "--name-only", `${base}...HEAD`)), ...lines(git("diff", "--name-only", "HEAD"))]),
  ];
}

/** This checkout's branch and the GitHub repos of its remotes: what identifies its own PR. */
function ownHead() {
  const branch = git("branch", "--show-current");
  const repos = lines(git("remote")).map((r) => repoSlug(git("remote", "get-url", r)));
  return branch ? { branch, repos: repos.filter(Boolean) } : undefined;
}

function issuePaths(id) {
  const root = git("rev-parse", "--show-toplevel");
  const name = fs.readdirSync(path.join(root, "plan/issues")).find((f) => f.startsWith(`${id}-`));
  if (!name) return null;
  const exists = (p) => fs.statSync(path.join(root, p), { throwIfNoEntry: false })?.isFile() ?? false;
  return issuePlanPaths(fs.readFileSync(path.join(root, "plan/issues", name), "utf8"), exists);
}

function parseArgs(argv) {
  const opts = { mode: "branch", paths: [], json: false, timeoutMs: 20_000, maxLines: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i];
    if (a === "--branch") opts.mode = "branch";
    else if (a === "--json") opts.json = true;
    else if (a === "--paths") {
      opts.mode = "paths";
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) opts.paths.push(argv[++i]);
    } else if (a === "--issue") [opts.mode, opts.issue] = ["issue", value()];
    else if (a === "--exclude-pr") opts.excludePr = Number(value());
    else if (a === "--timeout") opts.timeoutMs = Number(value()) * 1000;
    else if (a === "--max-lines") opts.maxLines = Number(value());
    else return null;
  }
  const bad =
    (opts.mode === "paths" && !opts.paths.length) ||
    (opts.mode === "issue" && !/^\d+[a-z]?$/.test(opts.issue ?? "")) ||
    [opts.timeoutMs, opts.maxLines].some((n) => !(n > 0)) ||
    (opts.excludePr !== undefined && !Number.isInteger(opts.excludePr));
  return bad ? null : opts;
}

export function verdictLine(result) {
  if (!result.checked) return `pr-file-overlap: NOT CHECKED — ${result.reason}`;
  const n = result.paths.length;
  // A PR whose file list GitHub cut at 3000 may change more files than it
  // shows, so it cannot be cleared — the verdict must not read as a plain OK.
  const cut = result.truncated ?? [];
  const partly = cut.length
    ? `; ${cut.length} PR(s) (${cut.map((pr) => `#${pr}`).join(", ")}) have a file list cut at 3000 by GitHub and could not be fully checked`
    : "";
  if (!result.overlaps.length) {
    return cut.length
      ? `pr-file-overlap: OK for the other ${result.prCount - cut.length} open PR(s) on these ${n} path(s)${partly}`
      : `pr-file-overlap: OK — no open PR touches these ${n} path(s)`;
  }
  const touched = new Set(result.overlaps.flatMap((o) => o.paths)).size;
  return `pr-file-overlap: ${result.overlaps.length} open PR(s) touch ${touched} of your ${n} path(s) — settle it with the other lane on #7526${partly}`;
}

/** Compute the overlap result. `deps` lets tests inject the fetcher and cache. */
export async function overlapResult(opts, deps = {}) {
  let all, excludeHead;
  try {
    all = opts.mode === "branch" ? branchPaths() : opts.mode === "issue" ? issuePaths(opts.issue) : opts.paths;
    excludeHead = opts.mode === "branch" ? ownHead() : undefined;
  } catch (error) {
    // No main ref, a clone too shallow for a merge-base, no plan/issues/ …
    return { checked: false, reason: `cannot read this checkout (${firstLine(error)})`, paths: [] };
  }
  if (all === null) return { checked: false, reason: `no plan/issues/${opts.issue}-*.md`, paths: [] };
  const paths = all.filter((p) => !isIgnoredOverlapPath(p));
  // Nothing that can conflict: answer without spending API calls.
  if (!paths.length) return { checked: true, paths, ignored: all.length, overlaps: [] };
  const listing = await openPrFiles({ timeoutMs: opts.timeoutMs, ...deps });
  if (!listing.checked) return { checked: false, reason: listing.reason, paths };
  const overlaps = findPathOverlaps(paths, listing.prs, { excludePr: opts.excludePr, excludeHead });
  return {
    checked: true,
    paths,
    ignored: all.length - paths.length,
    prCount: listing.prs.length,
    overlaps,
    truncated: truncatedUnlisted(listing.prs, overlaps),
  };
}

/** @returns {Promise<number>} the exit code */
export async function main(argv, { log = console.log, ...deps } = {}) {
  const opts = parseArgs(argv);
  if (!opts) {
    log(USAGE);
    return 2;
  }
  const result = await overlapResult(opts, deps);
  if (opts.json) {
    log(JSON.stringify({ ...result, verdict: verdictLine(result) }, null, 2));
    return 0;
  }
  if (!result.checked) {
    log(
      "pr-file-overlap: the open-PR file check did NOT run — you do not know whether another lane changes these files.",
    );
  }
  for (const line of formatOverlaps(result.overlaps ?? [], { maxLines: opts.maxLines })) log(`  ${line}`);
  log(verdictLine(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
