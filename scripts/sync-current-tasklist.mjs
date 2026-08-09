#!/usr/bin/env node
// sync-current-tasklist.mjs — FORWARD sync: issue frontmatter -> team TaskList.
//
// The counterpart to reconcile-tasklist.mjs (which is the REVERSE sync: it marks
// a task `completed` once its target issue is done). This script keeps the team
// `js2wasm` TaskList populated from the rolling sprint queue:
//
//   Every issue tagged `sprint: current` with an actionable status
//   (ready | in-progress) gets a task in the team store; assigning or updating
//   such an issue keeps its task in lockstep.
//
// Part of the budget-windowed rolling sprint model (#2751): the TaskList is a
// long, priority-ordered, over-provisioned queue; `sprint: current` is the live
// window. A numbered sprint (e.g. `sprint: 68`) is a *frozen* retrospective record
// written at budget rollover by freeze-sprint.mjs — those issues are NOT synced
// here (only `current` is the live queue).
//
// Task identity: the task file is keyed by the ISSUE id (`<issueId>.json`, with
// `id: "<issueId>"`), so the sync is idempotent (re-running updates in place
// rather than duplicating) and collision-free with the small sequential ids the
// native TaskCreate tool assigns. The subject keeps a `#<issueId>` reference so
// reconcile-tasklist.mjs's target-issue resolver still works.
//
// Priority: the schema has no priority field, so priority is encoded as a leading
// `[P1]`/`[P2]`/`[P3]` subject tag (high/medium/low) — visible to agents and
// updatable in place on every sync.
//
// Writes ONLY to the team store. Reads across team + fresh session stores to
// dedupe, so it never creates a duplicate of a task a live session already owns.
// Direct task-JSON writes mirror reconcile-tasklist.mjs's `--apply` path — the
// native TaskCreate/TaskUpdate tools remain authoritative; this is the structural
// backstop that keeps the queue full without an agent remembering to do it.
//
// Usage:
//   node scripts/sync-current-tasklist.mjs            # full scan, upsert all `current` issues
//   node scripts/sync-current-tasklist.mjs --issue X  # sync only issue X (id or path) — hook fast path
//   node scripts/sync-current-tasklist.mjs --dry-run  # report what would change, write nothing
//   node scripts/sync-current-tasklist.mjs --quiet    # one-line summary (for hooks)
//
// Safe everywhere: never throws on a malformed issue/task; exits 0 always so it
// can't fail a hook or build.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const DRY = flag("--dry-run");
const QUIET = flag("--quiet");
const ONLY_ISSUE = (() => {
  const i = args.indexOf("--issue");
  return i >= 0 ? args[i + 1] : null;
})();

const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), ".claude");
const TASKS_ROOT = join(CLAUDE_HOME, "tasks");
const TEAM = process.env.JS2WASM_TEAM || "js2wasm";
const TEAM_DIR = join(TASKS_ROOT, TEAM);
const REPO = process.env.REPO_ROOT || process.cwd();
const ISSUES_DIR = join(REPO, "plan", "issues");

// Statuses that should appear as an actionable task in the live queue.
const ACTIONABLE = new Set(["ready", "in-progress"]);
// task verb by issue task_type
const VERB = {
  fix: "fix",
  feature: "feat",
  feat: "feat",
  refactor: "refactor",
  chore: "chore",
  docs: "docs",
  test: "test",
};
const PRIO_TAG = { critical: "[P0]", high: "[P1]", medium: "[P2]", low: "[P3]" };

function log(s) {
  if (!QUIET) console.log(s);
}

// --- minimal top-frontmatter parser (regex, like reconcile-tasklist.mjs) ------
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fm[mm[1].toLowerCase()] = v;
  }
  return fm;
}

function issueFiles() {
  if (!existsSync(ISSUES_DIR)) return [];
  return readdirSync(ISSUES_DIR).filter((f) => /^\d+[a-z]?-.+\.md$/i.test(f));
}

function readIssue(file) {
  const path = join(ISSUES_DIR, file);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  const id = (fm.id || file.match(/^(\d+[a-z]?)-/i)?.[1] || "").toLowerCase();
  if (!id) return null;
  return {
    id,
    file,
    title: fm.title || "",
    status: (fm.status || "").toLowerCase(),
    sprint: (fm.sprint || "").toLowerCase(),
    priority: (fm.priority || "medium").toLowerCase(),
    task_type: (fm.task_type || "fix").toLowerCase(),
    horizon: normHorizon(fm.horizon || fm.cost),
  };
}

// Horizon = expected token/work cost class (#2751 budget-aware scheduling). The
// puller (scripts/budget-status.mjs) uses it at claim-time to pick an
// adequately-sized task for the remaining budget + parallelism. Default M.
function normHorizon(v) {
  const s = (v || "").toString().trim().toLowerCase();
  if (["xl", "xlarge", "x-large", "epic"].includes(s)) return "xl";
  if (["l", "large", "big"].includes(s)) return "l";
  if (["s", "small", "tiny", "trivial"].includes(s)) return "s";
  return "m"; // m|medium|unset
}

// --- dedupe: which issue ids already have a task ANYWHERE (team + fresh sessions)
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
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name) || /^session-/.test(name);
    const fresh = Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000;
    if (name === TEAM || (isUuid && fresh)) dirs.push(p);
  }
  return dirs;
}

function firstIssueRef(subject) {
  const m = (subject || "").match(/#(\d+[a-z]?)/i);
  return m ? m[1].toLowerCase() : null;
}

// Map issueId -> {task, path, store} for every task that targets it, across stores.
function existingTasksByIssue() {
  const byIssue = new Map();
  for (const dir of taskStoreDirs()) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => /\.json$/i.test(f));
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
      const iid = firstIssueRef(t.subject);
      if (!iid) continue;
      const isTeam = dir === TEAM_DIR;
      // Prefer the team-store record if both exist (that's the one we own/edit).
      const prev = byIssue.get(iid);
      if (!prev || isTeam) byIssue.set(iid, { task: t, path, isTeam });
    }
  }
  return byIssue;
}

function subjectFor(issue) {
  const verb = VERB[issue.task_type] || "fix";
  const tag = PRIO_TAG[issue.priority] || "[P2]";
  const hz = `[${issue.horizon.toUpperCase()}]`; // horizon/size class — read by budget-status.mjs at pull-time
  const title = issue.title || `issue ${issue.id}`;
  return `${tag} ${hz} ${verb}(#${issue.id}): ${title}`;
}

function descFor(issue) {
  return `Auto-synced from plan/issues/${issue.file} (sprint: current, priority: ${issue.priority}). Read the issue file for full context.`;
}

const result = { created: [], updated: [], skipped_done: [], unchanged: [] };

function syncIssue(issue, existing) {
  // Only `sprint: current` + actionable issues belong in the live queue.
  if (issue.sprint !== "current") return;
  if (!ACTIONABLE.has(issue.status)) {
    result.skipped_done.push(issue.id);
    return;
  }
  const want = { subject: subjectFor(issue), description: descFor(issue) };
  const cur = existing.get(issue.id);

  if (cur) {
    const t = cur.task;
    // Never disturb a completed/deleted task or one a live session owns.
    if (t.status === "completed" || t.status === "deleted") {
      result.unchanged.push(issue.id);
      return;
    }
    if (!cur.isTeam) {
      // A live session already tracks it — leave that store alone, no dup.
      result.unchanged.push(issue.id);
      return;
    }
    if (t.subject === want.subject && t.description === want.description) {
      result.unchanged.push(issue.id);
      return;
    }
    t.subject = want.subject;
    t.description = want.description;
    if (!DRY) writeFileSync(cur.path, JSON.stringify(t, null, 2));
    result.updated.push(issue.id);
    return;
  }

  // Create a new pending, unowned task in the team store (id == issue id).
  const task = {
    id: String(issue.id),
    subject: want.subject,
    description: want.description,
    status: "pending",
    blocks: [],
    blockedBy: [],
    owner: "",
  };
  if (!DRY) {
    if (!existsSync(TEAM_DIR)) mkdirSync(TEAM_DIR, { recursive: true });
    writeFileSync(join(TEAM_DIR, `${issue.id}.json`), JSON.stringify(task, null, 2));
  }
  result.created.push(issue.id);
}

// --- run ----------------------------------------------------------------------
const existing = existingTasksByIssue();

let issues;
if (ONLY_ISSUE) {
  // accept an id or a path
  const idMatch = ONLY_ISSUE.match(/(\d+[a-z]?)/i);
  const wantId = idMatch ? idMatch[1].toLowerCase() : null;
  const base = basename(ONLY_ISSUE);
  let file = issueFiles().find((f) => f === base || (wantId && new RegExp(`^${wantId}-`, "i").test(f)));
  if (!file && wantId) file = issueFiles().find((f) => f.toLowerCase().startsWith(`${wantId}-`));
  issues = file ? [readIssue(file)].filter(Boolean) : [];
} else {
  issues = issueFiles()
    .map(readIssue)
    .filter(Boolean)
    .filter((i) => i.sprint === "current");
}

for (const issue of issues) syncIssue(issue, existing);

const summary = `sync-current-tasklist: +${result.created.length} created, ~${result.updated.length} updated, =${result.unchanged.length} unchanged, ${result.skipped_done.length} non-actionable${DRY ? " (dry-run)" : ""}`;
if (QUIET) {
  console.log(summary);
} else {
  log(`\n${summary}`);
  if (result.created.length) log(`  created: ${result.created.map((i) => "#" + i).join(", ")}`);
  if (result.updated.length) log(`  updated: ${result.updated.map((i) => "#" + i).join(", ")}`);
  if (DRY) log(`  (dry-run — no files written; team store: ${TEAM_DIR})`);
}

process.exit(0);
