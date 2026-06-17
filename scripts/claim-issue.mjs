#!/usr/bin/env node
// scripts/claim-issue.mjs (#2168)
//
// Cross-developer atomic issue-claim lock for multi-dev work (humans + agents,
// possibly across forks). The live lock lives on a dedicated orphan ref —
// `refs/heads/issue-assignments` on `origin` — that holds ONLY assignment
// state (one `<id>.json` per claimed issue). Pushing the claim there:
//   - does NOT move `main`, so it never rebuilds queued merge groups (#1951);
//   - matches no workflow trigger (`push: main` / `pull_request: main` /
//     `merge_group`), so it never runs CI;
//   - is git-atomic: the first `git push` to the ref wins; a concurrent
//     claimant gets a non-fast-forward rejection, re-fetches, and re-evaluates.
//
// The issue file's `assignee` frontmatter on `main` is updated lazily inside
// the issue's own PR (eventual consistency). This ref is the source of truth
// for "who is working on what RIGHT NOW".
//
// Usage:
//   node scripts/claim-issue.mjs <id> <assignee> [--branch <b>] [--force]
//   node scripts/claim-issue.mjs --check <id>
//   node scripts/claim-issue.mjs --release <id> [<assignee>]
//   node scripts/claim-issue.mjs --complete <id>
//   node scripts/claim-issue.mjs --list
//
// Assignee convention: humans use their name/handle; dev AGENTS use their
// github-account-prefixed name, e.g. `ttraenkler/senior-dev-1`. The default
// account prefix for an unqualified agent name can be supplied via
// CLAIM_GITHUB_ACCOUNT; a name already containing `/` is used verbatim.
//
// Exit codes: 0 ok / free · 2 usage error · 3 already claimed by someone else
//             4 issue already done/wont-fix on main · 5 push gave up after retries

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASSIGN_REF = "issue-assignments";
const REMOTE = process.env.CLAIM_REMOTE || "origin";
const MAIN_REF = `${REMOTE}/main`;
const MAX_RETRIES = 6;

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", opts.quietErr ? "ignore" : "inherit"],
    ...opts,
  }).trim();
}

function gitTry(args, opts = {}) {
  try {
    return { ok: true, out: git(args, { quietErr: true, ...opts }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || "").toString().trim(), err: e };
  }
}

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

// --- argument parsing -------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const branchIdx = argv.indexOf("--branch");
const branch = branchIdx >= 0 ? argv[branchIdx + 1] : "";
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--branch");

const mode = flags.has("--list")
  ? "list"
  : flags.has("--check")
    ? "check"
    : flags.has("--release")
      ? "release"
      : flags.has("--complete")
        ? "complete"
        : "claim";

function normalizeAssignee(raw) {
  if (!raw) return "";
  if (raw.includes("/")) return raw;
  const acct = process.env.CLAIM_GITHUB_ACCOUNT;
  return acct ? `${acct}/${raw}` : raw;
}

// --- remote ref plumbing ----------------------------------------------------
function remoteAssignSha() {
  const r = gitTry(["ls-remote", REMOTE, ASSIGN_REF]);
  if (!r.ok || !r.out) return "";
  return r.out.split("\t")[0];
}

function fetchAssign(sha) {
  if (!sha) return; // ref doesn't exist yet
  git(["fetch", "--quiet", REMOTE, `${ASSIGN_REF}:refs/claim-issue/base`]);
}

function readEntry(baseSha, id) {
  if (!baseSha) return null;
  const r = gitTry(["cat-file", "-p", `${baseSha}:${id}.json`]);
  if (!r.ok || !r.out) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

function isHeld(entry) {
  return !!(entry && entry.assignee && entry.status !== "released");
}

// Find the issue file on main and read its `status:` frontmatter (best effort).
function mainIssueStatus(id) {
  const ls = gitTry(["ls-tree", "-r", "--name-only", MAIN_REF, "plan/issues/"]);
  if (!ls.ok) return null;
  const re = new RegExp(`^plan/issues/${id}-[^/]+\\.md$`);
  const file = ls.out.split("\n").find((f) => re.test(f));
  if (!file) return null;
  const cat = gitTry(["cat-file", "-p", `${MAIN_REF}:${file}`]);
  if (!cat.ok) return null;
  const m = cat.out.match(/^status:\s*([\w-]+)\s*$/m);
  return { file, status: m ? m[1] : null };
}

// Build a new tree = base tree with `<id>.json` set to `content`, then
// commit-tree on top of base and push to the ref. Returns true on success.
function commitAndPush(baseSha, id, content, message) {
  const tmp = mkdtempSync(join(process.env.CLAUDE_JOB_DIR || tmpdir(), "claim-"));
  const idxFile = join(tmp, "index");
  const env = { ...process.env, GIT_INDEX_FILE: idxFile };
  try {
    if (baseSha) {
      git(["read-tree", `${baseSha}^{tree}`], { env });
    } else {
      git(["read-tree", "--empty"], { env });
    }
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      input: content,
      encoding: "utf8",
    }).trim();
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${id}.json`], { env });
    const tree = git(["write-tree"], { env });
    const commitArgs = ["commit-tree", tree, "-m", message];
    if (baseSha) commitArgs.push("-p", baseSha);
    const commit = git(commitArgs);
    // --no-verify: the assignment ref only ever carries a single <id>.json (never
    // labs/ content), and the pre-push integrity gate (pnpm install + typecheck +
    // lint, ~120s+) makes every claim hang/exit 124. CLAUDE.md sanctions
    // --no-verify for these non-main, no-CI claim pushes.
    const push = gitTry(["push", "--no-verify", REMOTE, `${commit}:refs/heads/${ASSIGN_REF}`]);
    return push.ok;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- read-only modes --------------------------------------------------------
function doList() {
  const sha = remoteAssignSha();
  if (!sha) {
    console.log("No assignments yet (ref issue-assignments does not exist).");
    return;
  }
  fetchAssign(sha);
  const ls = gitTry(["ls-tree", "--name-only", sha]);
  const files = ls.ok ? ls.out.split("\n").filter((f) => f.endsWith(".json")) : [];
  const rows = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    const e = readEntry(sha, id);
    if (isHeld(e)) rows.push(e);
  }
  rows.sort((a, b) => Number(a.id) - Number(b.id));
  if (!rows.length) {
    console.log("No active claims.");
    return;
  }
  console.log("id\tassignee\tstatus\tbranch\tclaimed_at");
  for (const e of rows) {
    console.log(`${e.id}\t${e.assignee}\t${e.status}\t${e.branch || "-"}\t${e.claimed_at || "-"}`);
  }
}

function doCheck(id) {
  const sha = remoteAssignSha();
  fetchAssign(sha);
  const e = readEntry(sha, id);
  if (isHeld(e)) {
    console.log(`#${id} is CLAIMED by ${e.assignee} (since ${e.claimed_at || "?"}).`);
    process.exit(3);
  }
  console.log(`#${id} is UNASSIGNED.`);
  process.exit(0);
}

// --- claim / release / complete (write modes, with retry) -------------------
function nowIso() {
  // Date.* is fine in a plain node script (this is not a workflow sandbox).
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function writeMode(id, assignee, kind) {
  // Pre-flight: refuse claiming an issue already closed on main.
  if (kind === "claim") {
    const main = mainIssueStatus(id);
    if (main && (main.status === "done" || main.status === "wont-fix")) {
      die(4, `#${id} is already ${main.status} on ${MAIN_REF} (${main.file}). Nothing to claim.`);
    }
    if (!main) {
      console.error(`warning: no issue file for #${id} found on ${MAIN_REF}; claiming anyway.`);
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const sha = remoteAssignSha();
    fetchAssign(sha);
    const existing = readEntry(sha, id);

    if (kind === "claim") {
      if (isHeld(existing) && existing.assignee !== assignee && !flags.has("--force")) {
        die(
          3,
          `#${id} is already claimed by ${existing.assignee} (since ${existing.claimed_at || "?"}). Pick another issue, or pass --force to steal.`,
        );
      }
    }
    if (kind === "release" || kind === "complete") {
      if (!isHeld(existing)) {
        console.log(`#${id} is not currently claimed — nothing to ${kind}.`);
        return;
      }
      if (assignee && existing.assignee !== assignee && !flags.has("--force")) {
        die(3, `#${id} is held by ${existing.assignee}, not ${assignee}. Pass --force to override.`);
      }
    }

    const entry = {
      id: String(id),
      assignee: kind === "claim" ? assignee : existing ? existing.assignee : assignee,
      status: kind === "claim" ? "in-progress" : kind === "complete" ? "done" : "released",
      branch: kind === "claim" ? branch || (existing && existing.branch) || "" : (existing && existing.branch) || "",
      claimed_at: kind === "claim" ? nowIso() : existing ? existing.claimed_at : nowIso(),
      updated_at: nowIso(),
    };
    if (kind !== "claim") entry.released_at = nowIso();

    const verb = kind === "claim" ? "claim" : kind;
    const msg = `chore(assign): ${verb} #${id} -> ${entry.assignee} [skip ci]`;
    const content = JSON.stringify(entry, null, 2) + "\n";

    if (commitAndPush(sha, id, content, msg)) {
      const human =
        kind === "claim"
          ? `Claimed #${id} for ${entry.assignee}${entry.branch ? ` (branch ${entry.branch})` : ""}.`
          : kind === "complete"
            ? `Marked #${id} complete (was ${entry.assignee}).`
            : `Released #${id} (was ${entry.assignee}).`;
      console.log(human);
      console.log(`(pushed to ${REMOTE}/${ASSIGN_REF}; main untouched, no CI triggered)`);
      return;
    }
    console.error(`push rejected (attempt ${attempt}/${MAX_RETRIES}) — someone else moved the ref, re-checking…`);
  }
  die(5, `Could not acquire the claim ref after ${MAX_RETRIES} attempts. Try again.`);
}

// --- dispatch ---------------------------------------------------------------
if (mode === "list") {
  doList();
} else if (mode === "check") {
  const id = positional[0];
  if (!id) die(2, "usage: claim-issue.mjs --check <id>");
  doCheck(id);
} else if (mode === "release" || mode === "complete") {
  const id = positional[0];
  if (!id) die(2, `usage: claim-issue.mjs --${mode} <id> [<assignee>]`);
  writeMode(id, normalizeAssignee(positional[1] || process.env.CLAIM_ASSIGNEE || ""), mode);
} else {
  const id = positional[0];
  const assignee = normalizeAssignee(positional[1] || process.env.CLAIM_ASSIGNEE || "");
  if (!id || !assignee) {
    die(
      2,
      "usage: claim-issue.mjs <id> <assignee> [--branch <b>] [--force]\n  (assignee may also come from $CLAIM_ASSIGNEE; agents use ttraenkler/<agent-name>)",
    );
  }
  writeMode(id, assignee, "claim");
}
