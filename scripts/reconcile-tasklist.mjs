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
// SECOND DRIFT SOURCE (#2147 + #2048): the task<->frontmatter reconciler above
// never checks issue frontmatter against MERGED PRs. The sprint-62 triage found
// 11 sprint-61 issues still `ready` whose fixes had already merged — a dev WILL
// claim already-fixed work. So we additionally fetch merged PR titles
// (`gh pr list --state merged`), extract their `#NNNN` references, and report
// every OPEN issue (`ready`/`in-progress`/`in-review`) whose number is cited by
// a merged CODE PR. The `in-review` half is #2048 layer 3: the "merged PR ⇒
// done" flip is enforced by nobody, so `in-review` issues whose fix merged rot
// and get re-validated by redispatch agents (sprint 61: 17 of 24 merged PRs
// were zero-code metadata commits on such issues). Plan/docs PRs
// (`plan:`/`docs:`/`chore(plan)` titles) are excluded so a planning commit that
// merely *mentions* an issue can't false-flag it. Report-only — the PO/lead owns
// the actual frontmatter flips. The check is skipped silently when `gh` is
// unavailable/unauthenticated (CI) or `--no-merged-prs`.

// ── #3969: the two ways this tool lied ────────────────────────────────────────
// A full audit of one 26-row run found **0 true positives** — 13 phantom rows
// and 13 real-but-misattributed. A tool with that rate trains everyone to ignore
// it, which is worse than not having it. Two independent causes:
//
// A. IT READ THE LOCAL CHECKOUT. Agents work in worktrees, so the shared
//    checkout's `origin/main` rots (measured: local 5824539805 vs remote
//    b0a4047c) and 13 issues already `done` on main read as still open. Issue
//    status is now read from the VERIFIED-CURRENT `origin/main` tree; when
//    currency cannot be established the tool says so loudly instead of
//    reporting from a stale tree. A stale read must never look like a finding.
//
// B. IT TREATED ANY `#N` IN A MERGED PR TITLE AS PROOF `#N` IS DONE. Four
//    distinct bugs rode on that one assumption:
//      1. slice-of-epic read as closure (#2949 has 17 merged PRs and is open BY
//         DESIGN);
//      2. incidental mention (#3715 and #3746 both attributed to PR #3729,
//         which is the subject of neither);
//      3. filed-by counted as fixed-by (#3775 was cited only by the PR that
//         DISCOVERED it);
//      4. a docs/diagnosis PR counted as a fix (three PRs CORRECTING #3756's
//         root-cause claim read as three fixes).
//    Now: only an id in a PR's conventional-commit SCOPE (or a trailing
//    `(#N)` whose parens hold nothing else) counts as a claim; a mention
//    elsewhere in the title does not. An issue claimed by MORE THAN ONE merged
//    PR is the epic/slice shape and is reported UNKNOWN. And the issue's own
//    acceptance checkboxes must be all-checked before it is called done.
//
// THE DESIGN RULE, which is the whole point: when this tool cannot tell
// slice-of-epic from closure, it reports **unknown**, never **done**. Merely
// suppressing noisy rows would be the same bug with a smaller symptom — a
// quieter tool that still guesses. Measured effect on the 24-row live run:
// 1 confident done, 11 unknown, 12 dropped, every one of them with a reason.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync, execFileSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const QUIET = args.has("--quiet");
const JSON_OUT = args.has("--json");
const APPLY = args.has("--apply");
const NO_MERGED_PRS = args.has("--no-merged-prs");
// Escape hatch for offline use. Like --no-claim-check in budget-status, it makes
// "I chose not to verify" an explicit, recorded act rather than a silent one.
const ALLOW_STALE = args.has("--allow-stale-tree");

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

// ── #3969 Defect A: read issue state from a VERIFIED-CURRENT tree ─────────────
//
// The old code read `plan/issues/` out of the working checkout. Agents work in
// worktrees, so the shared checkout never advances on its own and silently rots
// behind main — measured at local `5824539805` vs remote `b0a4047c`, which made
// 13 already-`done` issues read as open. The failure is invisible: a stale tree
// produces a confident, well-formatted, wrong report.
//
// So: establish currency FIRST (`ls-remote` is sub-second even where a fetch is
// not), then read the issue files out of that exact commit. If currency cannot
// be established, the tool refuses to report done-ness rather than guessing.
function git(gitArgs, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync("git", gitArgs, {
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
        timeout: opts.timeout || 30000,
        ...opts,
      }).trim(),
    };
  } catch (e) {
    return { ok: false, err: String((e && (e.stderr || e.message)) || e).slice(0, 300) };
  }
}

function resolveIssueSource() {
  const local = git(["rev-parse", "origin/main"]);
  const remote = git(["ls-remote", "origin", "refs/heads/main"], { timeout: 60000 });
  const remoteSha = remote.ok ? (remote.out.split("\t")[0] || "").trim() : "";
  const localSha = local.ok ? local.out : "";

  if (!remoteSha) {
    // Could not ASK. That is not the same as "up to date" — say which it is.
    return {
      mode: "worktree",
      verified: false,
      localSha,
      remoteSha: "",
      note: `could not reach origin to verify currency (${remote.err || "no output"})`,
    };
  }
  if (localSha && localSha === remoteSha) {
    return { mode: "tree", verified: true, sha: localSha, localSha, remoteSha, note: "origin/main is current" };
  }
  // Stale. Try to become current; a targeted single-branch fetch is cheap.
  //
  // Fetch into a PRIVATE ref rather than relying on FETCH_HEAD: many agents run
  // in worktrees over one shared object store, so a concurrent fetch can clobber
  // FETCH_HEAD between our write and our read. (An earlier draft also passed
  // `--no-write-fetch-head` and *then* read FETCH_HEAD, which cannot work at
  // all — the hermetic stale-tree test below is what caught it.)
  const privateRef = `refs/reconcile-tasklist/main-${process.pid}`;
  const fetched = git(["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/main:${privateRef}`], {
    timeout: 180000,
  });
  if (fetched.ok) {
    const after = git(["rev-parse", privateRef]);
    git(["update-ref", "-d", privateRef]);
    if (after.ok && after.out) {
      return {
        mode: "tree",
        verified: true,
        sha: after.out,
        localSha,
        remoteSha,
        note: `local origin/main was STALE (${localSha.slice(0, 12) || "unknown"}); fetched ${after.out.slice(0, 12)}`,
      };
    }
  }
  return {
    mode: "worktree",
    verified: false,
    localSha,
    remoteSha,
    note:
      `local origin/main ${localSha.slice(0, 12) || "unknown"} != remote ${remoteSha.slice(0, 12)} and the ` +
      `catch-up fetch failed (${fetched.err || "unknown"})`,
  };
}

let treeReadError = "";
const SOURCE = resolveIssueSource();
// A stale tree makes every done/not-done verdict unreliable, so it is refused
// rather than degraded — unless the caller opted in explicitly.

/**
 * Every issue file, as { id -> {status, title, body} }.
 *
 * Read from the verified commit via one `ls-tree` + one batched `cat-file`
 * (3,400 files; a subprocess per file would take minutes). Falls back to the
 * worktree only when currency could not be established, and that fallback is
 * always announced — it is never allowed to look like a clean read.
 */
function loadIssuesFromTree(sha) {
  const listed = git(["ls-tree", "-r", "-z", sha, "--", "plan/issues"]);
  if (!listed.ok) {
    treeReadError = `ls-tree failed: ${listed.err}`;
    return null;
  }
  const entries = [];
  for (const rec of listed.out.split("\0")) {
    if (!rec) continue;
    // "<mode> <type> <sha>\t<path>"
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    const path = rec.slice(tab + 1);
    const base = path.slice(path.lastIndexOf("/") + 1);
    const m = base.match(/^(\d+[a-z]?)-.+\.md$/i);
    if (!m || meta[1] !== "blob") continue;
    entries.push({ id: m[1].toLowerCase(), blob: meta[2], file: base });
  }
  if (!entries.length) {
    treeReadError = "ls-tree matched no issue blobs";
    return null;
  }
  let batch;
  try {
    batch = execFileSync("git", ["cat-file", "--batch"], {
      cwd: REPO,
      input: entries.map((e) => e.blob).join("\n") + "\n",
      // `null`, NOT "buffer": execFileSync rejects the string form with
      // "Unknown encoding: buffer". It threw on every call, the catch turned it
      // into a silent worktree fallback, and the report still said
      // `verified: true` — Defect A restored, invisibly. Only making the
      // fallback LOUD surfaced the cause.
      encoding: null,
      maxBuffer: 512 * 1024 * 1024,
      timeout: 120000,
    });
  } catch (e) {
    treeReadError = `cat-file --batch failed: ${String(e && e.message).slice(0, 200)}`;
    return null;
  }
  // Response per blob: "<sha> blob <size>\n<size bytes>\n"
  const byId = new Map();
  let off = 0;
  for (const e of entries) {
    const nl = batch.indexOf(0x0a, off);
    if (nl < 0) break;
    const header = batch.toString("utf8", off, nl);
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) break;
    const body = batch.toString("utf8", nl + 1, nl + 1 + size);
    off = nl + 1 + size + 1;
    byId.set(e.id, { id: e.id, file: e.file, body, ...parseIssue(body) });
  }
  return byId;
}

function parseIssue(text) {
  return {
    status: (text.match(/^status:\s*(\S+)/m)?.[1] || "").toLowerCase() || null,
    title: text.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] || "",
  };
}

function loadIssuesFromWorktree() {
  const byId = new Map();
  if (!existsSync(ISSUES_DIR)) return byId;
  for (const f of readdirSync(ISSUES_DIR)) {
    const m = f.match(/^(\d+[a-z]?)-.+\.md$/i);
    if (!m) continue;
    let body;
    try {
      body = readFileSync(join(ISSUES_DIR, f), "utf8");
    } catch {
      continue;
    }
    byId.set(m[1].toLowerCase(), { id: m[1].toLowerCase(), file: f, body, ...parseIssue(body) });
  }
  return byId;
}

// A tree read that fails must NOT quietly become a worktree read: the worktree
// is the stale source this whole mechanism exists to stop trusting, so a silent
// downgrade would restore Defect A while still reporting `verified: true`.
let ISSUES;
if (SOURCE.mode === "tree") {
  const fromTree = loadIssuesFromTree(SOURCE.sha);
  if (fromTree && fromTree.size) {
    ISSUES = fromTree;
  } else {
    ISSUES = loadIssuesFromWorktree();
    SOURCE.mode = "worktree";
    SOURCE.verified = false;
    SOURCE.note += ` — but the TREE READ FAILED (${treeReadError || "no entries"}), so this fell back to the worktree`;
  }
} else {
  ISSUES = loadIssuesFromWorktree();
}
const SOURCE_UNRELIABLE = !SOURCE.verified && !ALLOW_STALE;

function issueStatus(id) {
  return ISSUES.get(String(id).toLowerCase())?.status ?? null;
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

// Open statuses a merged-PR reference makes STALE. Two distinct hazards:
//   - `ready`/`in-progress`: a dev would wrongly CLAIM already-fixed work
//     (#2147 — the original dispatch-poison concern).
//   - `in-review`: the issue's fix has MERGED but the frontmatter never got
//     flipped to `done`, so redispatch/re-validation agents churn it (#2048 —
//     17 of 24 merged PRs in sprint 61 were zero-code metadata commits on
//     never-closed `in-review` issues). CLAUDE.md's "merged PR ⇒ done" rule is
//     enforced by nobody; surfacing these here is layer 3 of #2048.
// `done`/`wont-fix`/`blocked`/`backlog` are terminal or not-yet-actionable, so
// a merged-PR reference to them is not a stale-status signal.
const AT_RISK_ISSUE_STATUSES = new Set(["ready", "in-progress", "in-review"]);

// List every issue with its id, status and title, from the resolved source.
function listIssues() {
  return [...ISSUES.values()];
}

/**
 * The ids a PR title CLAIMS to close, as opposed to the ones it merely mentions.
 *
 * This distinction is the fix for three of Defect B's four bugs. The old code
 * took every `#N` anywhere in the title, so:
 *   • #3715 and #3746 were both attributed to PR #3729, the subject of neither;
 *   • #3775 was attributed to the PR that DISCOVERED it ("filed by" read as
 *     "fixed by");
 *   • three PRs CORRECTING #3756's root-cause claim read as three fixes.
 * All three are mentions sitting in the summary, not the subject.
 *
 * A claim is an id in the conventional-commit SCOPE (`fix(#3934):`,
 * `fix(#3909, #3910):`) or a trailing `(#N)` whose parentheses contain nothing
 * else. The latter is the squash-merge convention and IS a real issue ref here —
 * verified against 200 merged PRs, where 18 of 19 trailing refs differ from the
 * PR's own number, so it is not the PR-number/issue-id sequence collision. The
 * "nothing else in the parens" requirement is what rejects `(unblocks #3916)`.
 */
export function claimedIssueIds(title) {
  const ids = new Set();
  const scope = String(title || "").match(/^\s*[a-z]+\(([^)]*)\)\s*:/i);
  if (scope) for (const m of scope[1].matchAll(/#(\d+[a-z]?)/gi)) ids.add(m[1].toLowerCase());
  const tail = String(title || "").match(/\(\s*#(\d+[a-z]?)\s*\)\s*$/i);
  if (tail) ids.add(tail[1].toLowerCase());
  return ids;
}

/** All acceptance-checkbox counts in an issue body. */
export function checkboxes(body) {
  return {
    checked: (String(body || "").match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length,
    unchecked: (String(body || "").match(/^\s*[-*]\s*\[ \]/gm) || []).length,
  };
}

// Fetch merged PRs (number + title) and map each issue id to the PRs that CLAIM
// it. Returns null when `gh` is unavailable so the caller can skip cleanly.
function mergedPrClaims() {
  let raw;
  try {
    raw = execSync("gh pr list --state merged -L 200 --json number,title", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000,
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
  const claims = new Map(); // issueId -> [{number, title}] — CLAIMED (scope/tail)
  const mentions = new Set(); // issueId — appears anywhere in a code PR title
  for (const pr of prs) {
    const title = pr.title || "";
    if (PLAN_DOCS_TITLE_RE.test(title)) continue; // mention-only, not a fix
    for (const m of title.matchAll(/#(\d+[a-z]?)/gi)) mentions.add(m[1].toLowerCase());
    for (const id of claimedIssueIds(title)) {
      if (!claims.has(id)) claims.set(id, []);
      claims.get(id).push({ number: pr.number, title });
    }
  }
  return { claims, mentions };
}

/**
 * Classify every at-risk issue claimed by a merged code PR into exactly one of
 * `done` / `unknown` / `rejected` — and never silently drop one.
 *
 * `unknown` is load-bearing, not a rounding bucket. Suppressing the rows this
 * tool cannot adjudicate would leave a quieter tool that still guesses, which is
 * the same defect with a smaller symptom. So an issue it cannot call is
 * REPORTED as uncallable, with the reason.
 */
function mergedPrStaleIssues() {
  if (NO_MERGED_PRS) return { skipped: true, reason: "--no-merged-prs", done: [], unknown: [], rejected: [] };
  const fetched = mergedPrClaims();
  if (fetched === null) return { skipped: true, reason: "gh unavailable", done: [], unknown: [], rejected: [] };
  const { claims, mentions: mentionedIds } = fetched;

  // Floor the count: the mentioned-vs-claimed gap is where the old tool
  // manufactured most of its false rows, so the report states how many it
  // DECLINED to flag rather than leaving that difference invisible.
  let mentionOnly = 0;

  const done = [];
  const unknown = [];
  const rejected = [];
  for (const issue of listIssues()) {
    if (!issue.status || !AT_RISK_ISSUE_STATUSES.has(issue.status)) continue;
    const row = { id: issue.id, issueStatus: issue.status, title: (issue.title || "").slice(0, 70) };
    const claimedBy = claims.get(issue.id);
    if (!claimedBy || !claimedBy.length) {
      // Mentioned somewhere, perhaps, but never claimed. Not evidence of a fix —
      // this is bugs 2/3/4 of Defect B, and dropping it here is the whole point.
      if (mentionedIds.has(issue.id)) {
        mentionOnly++;
      }
      continue;
    }
    row.prs = claimedBy.map((p) => p.number);
    row.prTitle = claimedBy[0].title.slice(0, 90);
    if (claimedBy.length > 1) {
      // The epic/slice shape: #2949 has 17 merged PRs and is open BY DESIGN.
      // One slice landing says nothing about the epic being closed.
      unknown.push({
        ...row,
        reason: `claimed by ${claimedBy.length} merged PRs (#${row.prs.join(", #")}) — slice-of-epic and closure are indistinguishable from titles alone`,
      });
      continue;
    }
    const { checked, unchecked } = checkboxes(issue.body);
    if (unchecked > 0) {
      rejected.push({ ...row, reason: `${unchecked} acceptance criterion/criteria still unchecked` });
      continue;
    }
    if (checked === 0) {
      // NECESSARY BUT NOT SUFFICIENT, and here it is simply absent: there are no
      // acceptance criteria to verify against, so "done" is not established.
      unknown.push({ ...row, reason: "no acceptance checkboxes — nothing to verify the claim against" });
      continue;
    }
    done.push({ ...row, reason: `claimed by PR #${row.prs[0]}, all ${checked} acceptance criteria checked` });
  }
  const byId = (a, b) => parseInt(a.id, 10) - parseInt(b.id, 10);
  return {
    skipped: false,
    done: done.sort(byId),
    unknown: unknown.sort(byId),
    rejected: rejected.sort(byId),
    mentionOnly,
  };
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

// Provenance of the issue read — which tree, and whether it was verified
// current. Travels in every output shape: a consumer reading counts without it
// cannot tell a clean run from one off a stale checkout (Defect A).
const sourceReport = {
  mode: SOURCE.mode,
  verified: SOURCE.verified,
  sha: SOURCE.sha || SOURCE.localSha || "",
  local_main: SOURCE.localSha,
  remote_main: SOURCE.remoteSha,
  note: SOURCE.note,
  issues_read: ISSUES.size,
  unreliable: SOURCE_UNRELIABLE,
};

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        total: tasks.length,
        open: open.length,
        issue_source: sourceReport,
        stale,
        mergedPrDone: mergedPr.done,
        mergedPrUnknown: mergedPr.unknown,
        mergedPrRejected: mergedPr.rejected,
        mergedPrCheckSkipped: mergedPr.skipped ? mergedPr.reason : false,
      },
      null,
      2,
    ),
  );
} else if (QUIET) {
  // The hook line. A stale tree is announced HERE, in the one line anyone reads,
  // because counts computed off a rotted checkout are worse than no counts.
  const prefix = SOURCE_UNRELIABLE ? `STALE-TREE (${SOURCE.note}) — counts unreliable | ` : "";
  const staleLine = stale.length === 0 ? "0 stale" : `${stale.length} stale: ${stale.map((s) => s.id).join(",")}`;
  const doneLine = mergedPr.done.length
    ? ` | ${mergedPr.done.length} merged-but-open: ${mergedPr.done.map((s) => "#" + s.id).join(",")}`
    : "";
  const unkLine = mergedPr.unknown.length ? ` | ${mergedPr.unknown.length} unknown` : "";
  console.log(prefix + staleLine + doneLine + unkLine);
} else {
  out(`\nissue source: ${SOURCE.verified ? "VERIFIED" : "UNVERIFIED"} ${SOURCE.mode} — ${SOURCE.note}`);
  out(
    `              ${ISSUES.size} issue file(s) read${sourceReport.sha ? ` @ ${sourceReport.sha.slice(0, 12)}` : ""}`,
  );
  if (SOURCE_UNRELIABLE) {
    out(
      `  ⚠ REFUSING to treat the merged-PR verdicts as reliable: the issue tree could not be verified current.\n` +
        `    A stale checkout reports already-done issues as open — that is how a 26-row run scored 0 true\n` +
        `    positives (#3969). Re-run with network, or pass --allow-stale-tree to accept the risk deliberately.`,
    );
  }

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

  // #2147 + #2048 merged-PR cross-check, now three-way (#3969).
  if (mergedPr.skipped) {
    out(`\nmerged-PR cross-check (#2147/#2048/#3969): skipped (${mergedPr.reason}).`);
  } else {
    const considered = mergedPr.done.length + mergedPr.unknown.length + mergedPr.rejected.length;
    out(
      `\nmerged-PR cross-check (#2147/#2048/#3969): ${considered} open issue(s) CLAIMED by a merged code PR` +
        ` → ${mergedPr.done.length} done, ${mergedPr.unknown.length} unknown, ${mergedPr.rejected.length} rejected.`,
    );
    if (!considered) out(`  (none — no open issue is claimed in a merged PR's scope.)`);
    if (mergedPr.mentionOnly) {
      out(
        `  + ${mergedPr.mentionOnly} open issue(s) were MENTIONED by a merged code PR but never claimed in one's` +
          ` scope — deliberately not flagged (that gap is where the old tool invented most of its false rows).`,
      );
    }

    if (mergedPr.done.length) {
      out(`\n  DONE — merged and every acceptance criterion checked; flip status: done:`);
      for (const s of mergedPr.done) out(`    #${s.id}  [${s.issueStatus}]  ${s.reason}`);
      out(`\n    (report-only — this script never writes frontmatter. The PO/lead owns the flip.)`);
    }
    if (mergedPr.unknown.length) {
      out(`\n  UNKNOWN — a merged PR claims it, but done-ness CANNOT be established from here.`);
      out(`    Reported rather than suppressed on purpose: a quieter tool that still guesses is the same bug.`);
      for (const s of mergedPr.unknown) out(`    #${s.id}  [${s.issueStatus}]  ${s.reason}`);
    }
    if (mergedPr.rejected.length) {
      out(`\n  REJECTED — claimed by a merged PR but demonstrably NOT done:`);
      for (const s of mergedPr.rejected) out(`    #${s.id}  [${s.issueStatus}]  ${s.reason}`);
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
