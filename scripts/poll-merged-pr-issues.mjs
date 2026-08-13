#!/usr/bin/env node
// Poll GitHub for merged PRs and close matching markdown issues.
//
// This is intentionally a narrow reader/updater:
// - reads only issues currently marked `status: in-review`
// - requires an explicit PR reference (`pr: 123`, `pr_url: ...`, or a body line
//   such as `PR: https://github.com/loopdive/js2wasm/pull/123`)
// - marks the issue `done` only after every linked PR has merged
// - never merges PRs, comments on GitHub, or pushes by itself

import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPO = "loopdive/js2wasm";
const DEFAULT_INTERVAL_MS = 60_000;
const ISSUE_FILE_RE = /^\d+[a-z]?(?:[-_].+)?\.md$/i;
const EXPLICIT_PR_KEYS = ["pr", "merged_pr", "resolved_by_pr", "pull_request", "pr_url", "github_pr"];
const BODY_PR_LINE_RE =
  /^\s*(?:[-*]\s*)?(?:(?:implementation\s+)?pr|pull\s+request|github\s+pr|pr\s+url|merged\s+pr)\s*:?\s+/i;
const BODY_MERGED_PR_LINE_RE = /^\s*(?:[-*]\s*)?(?:merged|landed|shipped)\s+(?:via\s+)?pr\s+#?\d+/i;

function parseArgs(argv) {
  const args = {
    once: false,
    dryRun: false,
    json: false,
    syncArtifacts: false,
    repo: process.env.GH_REPO || process.env.REPO || DEFAULT_REPO,
    intervalMs: intervalFromEnv(),
    issuesDir: path.join(ROOT, "plan", "issues"),
    issue: null,
    lockFile: process.env.PR_ISSUE_STATUS_LOCK || path.join(os.tmpdir(), "js2wasm-pr-issue-status.lock"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") args.once = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--json") args.json = true;
    else if (a === "--sync-artifacts") args.syncArtifacts = true;
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--interval-ms") args.intervalMs = Number(argv[++i]);
    else if (a === "--interval-secs") args.intervalMs = Number(argv[++i]) * 1000;
    else if (a === "--issues-dir") args.issuesDir = path.resolve(ROOT, argv[++i]);
    else if (a === "--issue") args.issue = String(argv[++i]);
    else if (a === "--lock-file") args.lockFile = path.resolve(ROOT, argv[++i]);
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!Number.isFinite(args.intervalMs) || args.intervalMs <= 0) args.intervalMs = DEFAULT_INTERVAL_MS;
  return args;
}

function intervalFromEnv() {
  if (process.env.INTERVAL_MS) return Number(process.env.INTERVAL_MS);
  if (process.env.INTERVAL_SECS) return Number(process.env.INTERVAL_SECS) * 1000;
  return DEFAULT_INTERVAL_MS;
}

function printHelp() {
  console.log(`Usage: node scripts/poll-merged-pr-issues.mjs [options]

Options:
  --once              Run one scan and exit
  --dry-run           Report updates without writing files
  --json              Emit JSON scan summaries
  --sync-artifacts    After updates, rebuild sprint/goal/dashboard/graph artifacts
  --repo OWNER/NAME   GitHub repo (default: ${DEFAULT_REPO}, or GH_REPO)
  --issue ID          Restrict to one issue id
  --interval-ms N     Watch interval in milliseconds (default: ${DEFAULT_INTERVAL_MS})
  --interval-secs N   Watch interval in seconds
  --issues-dir PATH   Markdown issue directory (default: plan/issues)
  --lock-file PATH    Single-instance lock file

Examples:
  node scripts/poll-merged-pr-issues.mjs --once --dry-run
  node scripts/poll-merged-pr-issues.mjs --once --sync-artifacts
  INTERVAL_SECS=30 node scripts/poll-merged-pr-issues.mjs --sync-artifacts
`);
}

function log(args, message) {
  if (!args.json) console.error(message);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function trackedMarkdownFiles(issuesDir) {
  const relRoot = path.relative(ROOT, issuesDir) || ".";
  try {
    return new Set(
      git(["ls-files", relRoot])
        .split("\n")
        .filter(Boolean)
        .filter((file) => file.endsWith(".md"))
        .map((file) => path.resolve(ROOT, file)),
    );
  } catch {
    return null;
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const st = statSync(file);
    if (st.isDirectory()) walk(file, out);
    else if (st.isFile() && name.endsWith(".md")) out.push(file);
  }
  return out.sort();
}

function isIssueFile(file, issuesDir) {
  const name = path.basename(file);
  if (!ISSUE_FILE_RE.test(name)) return false;
  const directSprintDoc = path.dirname(file) === path.join(issuesDir, "sprints") && /^\d+\.md$/.test(name);
  return !directSprintDoc;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: "", body: text, bodyStart: 0 };
  return { frontmatter: match[1], body: text.slice(match[0].length), bodyStart: match[0].length };
}

function readScalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`, "m"));
  if (!match) return "";
  return stripQuotes(match[1].trim());
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  if (s === "review" || s === "in_review") return "in-review";
  if (s === "in_progress") return "in-progress";
  return s;
}

function issueIdFromFile(file) {
  return (
    path
      .basename(file)
      .match(/^(\d+[a-z]?)/i)?.[1]
      .toLowerCase() || ""
  );
}

function numbersFromText(text) {
  const nums = new Set();
  const s = String(text || "");
  for (const match of s.matchAll(/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/(\d+)/gi)) nums.add(Number(match[1]));
  for (const match of s.matchAll(/\bPR\s*#?\s*(\d+)\b/gi)) nums.add(Number(match[1]));
  for (const match of s.matchAll(/^#?(\d+)$/gm)) nums.add(Number(match[1]));
  for (const match of s.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of match[1].split(",")) nums.add(Number(part.trim()));
  }
  return [...nums].filter((n) => Number.isInteger(n) && n > 0);
}

function extractPrNumbers(frontmatter, body) {
  const frontmatterNums = new Set();
  for (const key of EXPLICIT_PR_KEYS) {
    for (const n of numbersFromText(readScalar(frontmatter, key))) frontmatterNums.add(n);
  }
  if (frontmatterNums.size > 0) return [...frontmatterNums].sort((a, b) => a - b);

  const nums = new Set();
  for (const line of body.split("\n")) {
    if (!BODY_PR_LINE_RE.test(line) && !BODY_MERGED_PR_LINE_RE.test(line)) continue;
    for (const n of numbersFromText(line)) nums.add(n);
  }
  return [...nums].sort((a, b) => a - b);
}

function dependencyIds(frontmatter) {
  const raw = readScalar(frontmatter, "depends_on");
  return [...raw.matchAll(/#?(\d+[a-z]?)/gi)].map((match) => match[1].toLowerCase());
}

function loadInReviewIssues(args) {
  const tracked = trackedMarkdownFiles(args.issuesDir);
  const issues = [];
  for (const file of walk(args.issuesDir)) {
    if (!isIssueFile(file, args.issuesDir)) continue;
    if (tracked && !tracked.has(path.resolve(file))) continue;
    const id = issueIdFromFile(file);
    if (args.issue && String(args.issue).toLowerCase() !== id) continue;
    const text = readFileSync(file, "utf8");
    const parsed = parseFrontmatter(text);
    const status = normalizeStatus(readScalar(parsed.frontmatter, "status"));
    if (status !== "in-review") continue;
    const prs = extractPrNumbers(parsed.frontmatter, parsed.body);
    issues.push({
      id,
      file,
      relFile: path.relative(ROOT, file),
      text,
      parsed,
      prs,
      title: readScalar(parsed.frontmatter, "title") || "",
    });
  }
  return issues;
}

function ghPr(repo, number) {
  const raw = execFileSync(
    "gh",
    [
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,state,mergedAt,url,title,headRefName,baseRefName,isDraft",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(raw);
}

function updateFrontmatterScalars(text, fields) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error("missing_frontmatter");
  const pending = new Map(Object.entries(fields).map(([key, value]) => [key, String(value)]));
  const lines = match[1].split("\n").map((line) => {
    const idx = line.indexOf(":");
    if (idx < 0) return line;
    const key = line.slice(0, idx).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}: ${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}

function updateBodyStatus(text, status) {
  return text.replace(/^##\s+Status:\s+.+$/im, `## Status: ${status}`);
}

function mergedDate(prs) {
  const timestamps = prs.map((pr) => Date.parse(pr.mergedAt || "")).filter(Number.isFinite);
  if (timestamps.length === 0) return today();
  return new Date(Math.max(...timestamps)).toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function markDone(issue, prs, args) {
  const completed = mergedDate(prs);
  const next = updateBodyStatus(
    updateFrontmatterScalars(issue.text, {
      status: "done",
      completed,
      updated: today(),
    }),
    "done",
  );
  if (next === issue.text) return false;
  if (!args.dryRun) writeFileSync(issue.file, next);
  return true;
}

function loadIssueStatusEntries(args) {
  const tracked = trackedMarkdownFiles(args.issuesDir);
  const entries = [];
  for (const file of walk(args.issuesDir)) {
    if (!isIssueFile(file, args.issuesDir)) continue;
    if (tracked && !tracked.has(path.resolve(file))) continue;
    const text = readFileSync(file, "utf8");
    const parsed = parseFrontmatter(text);
    entries.push({
      id: issueIdFromFile(file),
      file,
      relFile: path.relative(ROOT, file),
      text,
      parsed,
      status: normalizeStatus(readScalar(parsed.frontmatter, "status")),
      dependsOn: dependencyIds(parsed.frontmatter),
    });
  }
  return entries;
}

function unblockDependents(completedIds, args) {
  const completed = new Set(completedIds.map((id) => String(id).toLowerCase()).filter(Boolean));
  if (completed.size === 0) return [];

  const entries = loadIssueStatusEntries(args);
  const statusById = new Map(entries.map((entry) => [entry.id, entry.status]));
  for (const id of completed) statusById.set(id, "done");

  const unblocked = [];
  for (const entry of entries) {
    if (entry.status !== "blocked" && entry.status !== "backlog") continue;
    if (!entry.dependsOn.some((id) => completed.has(id))) continue;
    if (!entry.dependsOn.every((id) => statusById.get(id) === "done")) continue;

    const next = updateBodyStatus(
      updateFrontmatterScalars(entry.text, {
        status: "ready",
        updated: today(),
      }),
      "ready",
    );
    if (next === entry.text) continue;
    if (!args.dryRun) writeFileSync(entry.file, next);
    unblocked.push({
      issue: entry.id,
      file: entry.relFile,
      action: args.dryRun ? "would_unblock" : "unblocked",
      dependsOn: entry.dependsOn,
    });
  }
  return unblocked;
}

function syncArtifacts(args) {
  if (args.dryRun || !args.syncArtifacts) return [];
  const commands = [
    [process.execPath, ["scripts/sync-sprint-issue-tables.mjs"]],
    [process.execPath, ["scripts/sync-goal-issue-tables.mjs"]],
    [process.execPath, ["website/dashboard/build-data.js"]],
    [process.execPath, ["--experimental-strip-types", "plan/generate-graph.ts"]],
  ];
  const ran = [];
  for (const [cmd, argv] of commands) {
    const res = spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
    if (res.status !== 0) throw new Error(`artifact_sync_failed: ${cmd} ${argv.join(" ")}`);
    ran.push([cmd, ...argv].join(" "));
  }
  return ran;
}

async function scan(args) {
  const issues = loadInReviewIssues(args);
  const prCache = new Map();
  const results = [];
  const completedIds = [];
  let changed = 0;
  for (const issue of issues) {
    if (issue.prs.length === 0) {
      results.push({ issue: issue.id, file: issue.relFile, action: "skip", reason: "no explicit PR reference" });
      continue;
    }

    const prs = [];
    let failed = null;
    for (const number of issue.prs) {
      try {
        if (!prCache.has(number)) prCache.set(number, ghPr(args.repo, number));
        prs.push(prCache.get(number));
      } catch (error) {
        failed = `github lookup failed for PR #${number}: ${error.message}`;
        break;
      }
    }
    if (failed) {
      results.push({ issue: issue.id, file: issue.relFile, prs: issue.prs, action: "skip", reason: failed });
      continue;
    }

    const open = prs.filter((pr) => pr.state !== "MERGED");
    if (open.length > 0) {
      results.push({
        issue: issue.id,
        file: issue.relFile,
        prs: prs.map((pr) => ({ number: pr.number, state: pr.state, url: pr.url })),
        action: "wait",
        reason: `not merged: ${open.map((pr) => `#${pr.number}=${pr.state}`).join(", ")}`,
      });
      continue;
    }

    const didChange = markDone(issue, prs, args);
    if (didChange) {
      changed++;
      completedIds.push(issue.id);
    }
    results.push({
      issue: issue.id,
      file: issue.relFile,
      prs: prs.map((pr) => ({ number: pr.number, state: pr.state, mergedAt: pr.mergedAt, url: pr.url })),
      action: didChange ? (args.dryRun ? "would_mark_done" : "marked_done") : "already_done",
      completed: mergedDate(prs),
    });
  }

  const unblocked = unblockDependents(completedIds, args);
  changed += unblocked.length;
  results.push(...unblocked);

  const artifacts = changed > 0 ? syncArtifacts(args) : [];
  const summary = {
    timestamp: new Date().toISOString(),
    repo: args.repo,
    scanned: issues.length,
    changed,
    dryRun: args.dryRun,
    syncArtifacts: args.syncArtifacts,
    artifacts,
    results,
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const row of results.filter((r) => r.action === "marked_done" || r.action === "would_mark_done")) {
      console.log(`${row.action}: #${row.issue} ${row.file} via ${row.prs.map((pr) => `PR #${pr.number}`).join(", ")}`);
    }
    if (changed === 0) log(args, `poll-merged-pr-issues: scanned ${issues.length} in-review issue(s); no updates`);
  }
  return summary;
}

function acquireLock(lockFile) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    const fd = openSync(lockFile, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
  } catch {
    let pid = "";
    try {
      pid = readFileSync(lockFile, "utf8").trim();
    } catch {
      // fall through to hard failure
    }
    if (pid && processAlive(Number(pid))) {
      throw new Error(`another poller is already running: pid=${pid} lock=${lockFile}`);
    }
    unlinkSync(lockFile);
    const fd = openSync(lockFile, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
  }
  const cleanup = () => {
    try {
      if ((readFileSync(lockFile, "utf8").trim() || "") === String(process.pid)) unlinkSync(lockFile);
    } catch {
      // ignore
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.once) {
    acquireLock(args.lockFile);
    log(args, `poll-merged-pr-issues: watching ${args.repo} every ${Math.round(args.intervalMs / 1000)}s`);
  }
  do {
    try {
      await scan(args);
    } catch (error) {
      const message = `poll-merged-pr-issues: ${error.message}`;
      if (args.once) throw error;
      log(args, message);
    }
    if (args.once) break;
    await sleep(args.intervalMs);
  } while (true);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
