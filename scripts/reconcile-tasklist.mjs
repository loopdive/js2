#!/usr/bin/env node
// reconcile-tasklist.mjs — close the gap that makes TaskList entries go stale.
//
// ROOT CAUSE (2026-05-29): a task's flip to `completed` is a manual TaskUpdate
// someone must remember to make, but nothing structurally triggers it:
//   1. Async merge — devs enqueue then move on; the PR merges minutes later in
//      the merge queue, after the authoring agent is gone, so the post-merge
//      flip never happens.
//   2. Tracking-tasks have no owner — PO/lead-created tasks are completed via
//      the *issue file* (`status: done`, set in the impl PR — the real source
//      of truth), and no agent treats the TaskList twin as its job.
//   3. Split store — tasks live in TWO stores (per-session UUID dir + the
//      `js2wasm` team dir); a task created in one isn't reconciled by an agent
//      reading the other.
// Net: issue-frontmatter `status:` (accurate) and TaskList `status` (stale)
// drift, with no link and nobody noticing.
//
// This tool derives "done" from the AUTHORITATIVE sources (issue frontmatter +
// closed/merged PRs) and reports every non-completed task whose target issue is
// already done/wont-fix — i.e. stale entries that should be flipped to
// `completed`. Wired as a SessionStart hook (see .claude/settings.json) so the
// staleness is surfaced into the tech-lead's context every session instead of
// silently accumulating. The lead applies the flips via TaskUpdate (the
// authoritative write path); `--apply` can rewrite the task JSON directly as a
// best-effort fallback when no agent session is live to run TaskUpdate.
//
// Usage:
//   node scripts/reconcile-tasklist.mjs            # full human report
//   node scripts/reconcile-tasklist.mjs --quiet    # one line: "N stale: id,id" (for hooks)
//   node scripts/reconcile-tasklist.mjs --json      # machine-readable
//   node scripts/reconcile-tasklist.mjs --apply     # best-effort: rewrite stale task JSON status=completed
//   node scripts/reconcile-tasklist.mjs --no-merged-prs  # skip the merged-PR cross-check (offline)
//
// Safe everywhere: if no task store is present (e.g. CI runners), it exits 0
// with "no task store" and never fails a build.
//
// SECOND DRIFT SOURCE (#2147): the task<->frontmatter reconciler above never
// checks issue frontmatter against MERGED PRs. The sprint-62 triage found 11
// sprint-61 issues still `ready` whose fixes had already merged — a dev WILL
// claim already-fixed work. So we additionally fetch merged PR titles
// (`gh pr list --state merged`), extract their `#NNNN` references, and report
// every issue still at `ready`/`in-progress` whose number is cited by a merged
// CODE PR. Plan/docs PRs (`plan:`/`docs:`/`chore(plan)` titles) are excluded so
// a planning commit that merely *mentions* an issue can't false-flag it.
// Report-only — the PO owns the actual frontmatter flips. The check is skipped
// silently when `gh` is unavailable/unauthenticated (CI) or `--no-merged-prs`.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const QUIET = args.has("--quiet");
const JSON_OUT = args.has("--json");
const APPLY = args.has("--apply");
const NO_MERGED_PRS = args.has("--no-merged-prs");

const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), ".claude");
const TASKS_ROOT = join(CLAUDE_HOME, "tasks");
const TEAM = process.env.JS2WASM_TEAM || "js2wasm";
const REPO = process.env.REPO_ROOT || process.cwd();
const ISSUES_DIR = join(REPO, "plan", "issues");

const DONE_STATUSES = new Set(["done", "wont-fix", "closed"]);

function out(s) {
  if (!QUIET && !JSON_OUT) console.log(s);
}

// --- locate task stores: the team dir + any recent session (UUID) dirs -------
function taskStoreDirs() {
  if (!existsSync(TASKS_ROOT)) return [];
  const dirs = [];
  for (const name of readdirSync(TASKS_ROOT)) {
    const p = join(TASKS_ROOT, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    // Always include the team dir. Include UUID session dirs touched in the
    // last 7 days (skip stale historical sprint-* dirs).
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name);
    const fresh = Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000;
    if (name === TEAM || (isUuid && fresh)) dirs.push(p);
  }
  return dirs;
}

// --- read every task across stores (dedupe by id; last-writer wins) ----------
function loadTasks() {
  const byId = new Map();
  for (const dir of taskStoreDirs()) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => /^\d+[a-z]?\.json$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      let t;
      try {
        t = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      if (!t || !t.id) continue;
      byId.set(String(t.id), { ...t, _path: path });
    }
  }
  return [...byId.values()];
}

// --- resolve a target issue id's authoritative status from its file ----------
const issueStatusCache = new Map();
function issueStatus(id) {
  if (issueStatusCache.has(id)) return issueStatusCache.get(id);
  let status = null;
  if (existsSync(ISSUES_DIR)) {
    // match <id>.md or <id>-slug.md (id may carry a letter suffix, e.g. 1690b)
    const re = new RegExp(`^${id}(?:-.+)?\\.md$`, "i");
    let file = null;
    for (const f of readdirSync(ISSUES_DIR)) {
      if (re.test(f)) {
        file = join(ISSUES_DIR, f);
        break;
      }
    }
    if (file) {
      const text = readFileSync(file, "utf8");
      status = (text.match(/^status:\s*(\S+)/m)?.[1] || "").toLowerCase() || null;
    }
  }
  issueStatusCache.set(id, status);
  return status;
}

// Extract the task's TARGET issue id: the first #NNNN in the subject. The
// subject convention is `verb(#NNNN): …` / `fix(#NNNN) …`, so the first ref is
// the target (later refs are blockers/related and must NOT drive completion).
function targetIssueId(task) {
  const m = (task.subject || "").match(/#(\d+[a-z]?)/i);
  return m ? m[1].toLowerCase() : null;
}

// A task subject that itself announces completion (CLOSED/DONE/SUPERSEDED/STALE)
// but is still not status=completed is also stale.
function subjectSaysDone(task) {
  return /\b(CLOSED|SUPERSEDED|STALE|\[DONE\])\b/.test(task.subject || "");
}

// ── #2147: cross-check ready/in-progress issues against merged PR titles ──────

// PR titles that are planning/docs-only — a `#NNNN` in one of these is a
// mention, not a fix, so it must NOT flag the issue. Matches the repo's
// conventional-commit prefixes (`plan:`, `docs:`, `chore(plan): …`, etc.).
const PLAN_DOCS_TITLE_RE = /^\s*(?:plan|docs|chore\(plan\)|chore\(docs\)|plan\([^)]*\)|docs\([^)]*\))\b/i;

// Issues actively claimable by a dev — these are the ones a stale merged-PR
// reference actually poisons (a dev would pick them up). `done`/`wont-fix`/
// `in-review`/`blocked`/`backlog` are not at risk of a wrong claim.
const AT_RISK_ISSUE_STATUSES = new Set(["ready", "in-progress"]);

// List every issue file with its id, status, and title.
function listIssues() {
  const issues = [];
  if (!existsSync(ISSUES_DIR)) return issues;
  for (const f of readdirSync(ISSUES_DIR)) {
    const m = f.match(/^(\d+[a-z]?)-.+\.md$/i);
    if (!m) continue;
    let text;
    try {
      text = readFileSync(join(ISSUES_DIR, f), "utf8");
    } catch {
      continue;
    }
    const status = (text.match(/^status:\s*(\S+)/m)?.[1] || "").toLowerCase() || null;
    const title = text.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] || "";
    issues.push({ id: m[1].toLowerCase(), file: f, status, title });
  }
  return issues;
}

// Fetch merged PR titles via `gh` and return the set of issue ids cited by a
// non-plan/docs (i.e. code) PR. Returns null if `gh` is unavailable so the
// caller can skip the check cleanly (CI, offline). The `#NNNN` reference is
// taken from the whole title — for code PRs every cited issue is a candidate
// (a fix PR commonly cites the primary issue plus the ones it also closes).
function mergedPrIssueRefs() {
  let raw;
  try {
    // -L caps the lookback; merged PRs older than the current sprint window are
    // irrelevant (their issues were reconciled long ago). JSON keeps parsing robust.
    raw = execSync("gh pr list --state merged -L 200 --json title", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
    });
  } catch {
    return null; // gh missing / unauthenticated / network — skip silently
  }
  let prs;
  try {
    prs = JSON.parse(raw);
  } catch {
    return null;
  }
  const refs = new Map(); // issueId -> sample PR title that cited it
  for (const pr of prs) {
    const title = pr.title || "";
    if (PLAN_DOCS_TITLE_RE.test(title)) continue; // mention-only, not a fix
    const seen = new Set();
    for (const m of title.matchAll(/#(\d+[a-z]?)/gi)) {
      const id = m[1].toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      if (!refs.has(id)) refs.set(id, title);
    }
  }
  return refs;
}

// Build the list of at-risk issues cited by a merged code PR.
function mergedPrStaleIssues() {
  if (NO_MERGED_PRS) return { skipped: true, reason: "--no-merged-prs", flagged: [] };
  const refs = mergedPrIssueRefs();
  if (refs === null) return { skipped: true, reason: "gh unavailable", flagged: [] };
  const flagged = [];
  for (const issue of listIssues()) {
    if (!issue.status || !AT_RISK_ISSUE_STATUSES.has(issue.status)) continue;
    const prTitle = refs.get(issue.id);
    if (prTitle) {
      flagged.push({
        id: issue.id,
        issueStatus: issue.status,
        prTitle: prTitle.slice(0, 90),
        title: issue.title.slice(0, 70),
      });
    }
  }
  flagged.sort((a, b) => Number(parseInt(a.id, 10)) - Number(parseInt(b.id, 10)));
  return { skipped: false, flagged };
}

const tasks = loadTasks();
if (tasks.length === 0) {
  out("reconcile-tasklist: no task store found (ok on CI) — nothing to do.");
  if (QUIET) console.log("0 stale");
  if (JSON_OUT) console.log(JSON.stringify({ stale: [], total: 0 }));
  process.exit(0);
}

const open = tasks.filter((t) => t.status !== "completed" && t.status !== "deleted");
const stale = [];
for (const t of open) {
  const iid = targetIssueId(t);
  const st = iid ? issueStatus(iid) : null;
  const reasonDone = st && DONE_STATUSES.has(st);
  const saysDone = subjectSaysDone(t);
  if (reasonDone || saysDone) {
    stale.push({
      id: t.id,
      issue: iid,
      issueStatus: st,
      reason: reasonDone ? `issue #${iid} is ${st}` : "subject marks CLOSED/DONE/SUPERSEDED",
      subject: (t.subject || "").slice(0, 80),
      path: t._path,
    });
  }
}

// #2147: ready/in-progress issues already fixed by a merged PR.
const mergedPr = mergedPrStaleIssues();

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        total: tasks.length,
        open: open.length,
        stale,
        mergedPrFixed: mergedPr.flagged,
        mergedPrCheckSkipped: mergedPr.skipped ? mergedPr.reason : false,
      },
      null,
      2,
    ),
  );
} else if (QUIET) {
  const staleLine = stale.length === 0 ? "0 stale" : `${stale.length} stale: ${stale.map((s) => s.id).join(",")}`;
  const prLine =
    mergedPr.flagged.length === 0
      ? ""
      : ` | ${mergedPr.flagged.length} merged-but-ready: ${mergedPr.flagged.map((s) => "#" + s.id).join(",")}`;
  console.log(staleLine + prLine);
} else {
  out(
    `\nreconcile-tasklist: ${tasks.length} tasks, ${open.length} open, ${stale.length} STALE (done-but-not-completed)\n`,
  );
  for (const s of stale) {
    out(`  #${s.id}  [${s.reason}]  ${s.subject}`);
  }
  if (stale.length) {
    out(`\nApply (authoritative — run as the team lead):`);
    for (const s of stale) out(`  TaskUpdate taskId=${s.id} status=completed`);
    out(`\nOr best-effort direct rewrite: node scripts/reconcile-tasklist.mjs --apply`);
  }

  // #2147 merged-PR cross-check report.
  if (mergedPr.skipped) {
    out(`\nmerged-PR cross-check (#2147): skipped (${mergedPr.reason}).`);
  } else {
    out(
      `\nmerged-PR cross-check (#2147): ${mergedPr.flagged.length} ready/in-progress issue(s) cited by a merged code PR:`,
    );
    for (const s of mergedPr.flagged) {
      out(`  #${s.id}  [${s.issueStatus}]  fixed by merged PR "${s.prTitle}"`);
    }
    if (mergedPr.flagged.length) {
      out(`\n  → these fixes have merged but the issue frontmatter still reads ready/in-progress.`);
      out(`    The PO should flip status: done (report-only — this script does not write frontmatter).`);
    }
  }
}

if (APPLY && stale.length) {
  let n = 0;
  for (const s of stale) {
    try {
      const t = JSON.parse(readFileSync(s.path, "utf8"));
      t.status = "completed";
      writeFileSync(s.path, JSON.stringify(t, null, 2));
      n++;
    } catch {
      /* skip */
    }
  }
  out(`\n--apply: rewrote ${n} task file(s) to status=completed (best-effort; TaskUpdate is authoritative).`);
}

// Never fail a build/hook on staleness — this is advisory.
process.exit(0);
