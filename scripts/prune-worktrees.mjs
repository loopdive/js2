#!/usr/bin/env node
// Prune fully-merged agent worktrees (end-of-sprint housekeeping).
//
// Agent worktrees under .claude/worktrees/ pile up after a sprint — each dev/
// arch/PO worktree outlives its merged PR. This removes ONLY worktrees that
// are provably safe to delete, and SKIPS (never force-removes) anything that
// might hold unmerged work.
//
// A worktree is removed only when ALL of these hold:
//   - it is NOT the main checkout (/workspace) and NOT the current cwd
//   - it is NOT locked (locked = an agent is actively using it)
//   - its working tree is clean (no uncommitted/untracked changes)
//   - its HEAD is an ANCESTOR of origin/main (every commit is already merged)
//
// Anything failing a check is KEPT and the reason is printed — this mirrors the
// "NEVER delete a worktree without checking diffs first" rule, automated.
//
// DRY-RUN BY DEFAULT. Pass --force to actually remove. Exit code always 0.
//
// Usage: node scripts/prune-worktrees.mjs [--force] [--quiet]
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const force = args.includes("--force");
const quiet = args.includes("--quiet");
const log = (...m) => {
  if (!quiet) console.log("[prune-worktrees]", ...m);
};

const root = "/workspace";
const sh = (cmd, cwd = root) => {
  try {
    return execSync(cmd, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

// Make sure origin/main is current so the ancestor check is accurate.
sh("git fetch origin main --quiet");

// Parse `git worktree list --porcelain` into {path, locked} records.
const porcelain = sh("git worktree list --porcelain");
const worktrees = [];
let cur = null;
for (const line of porcelain.split("\n")) {
  if (line.startsWith("worktree ")) {
    if (cur) worktrees.push(cur);
    cur = { path: line.slice("worktree ".length).trim(), locked: false };
  } else if (line.startsWith("locked")) {
    if (cur) cur.locked = true;
  }
}
if (cur) worktrees.push(cur);

const self = process.cwd();
let removed = 0,
  kept = 0;

for (const wt of worktrees) {
  const { path, locked } = wt;
  // Never touch the main checkout or the worktree we're standing in.
  if (path === root || path === self) {
    kept++;
    continue;
  }
  // Only manage worktrees under the canonical .claude/worktrees/ root.
  if (!path.includes("/.claude/worktrees/")) {
    kept++;
    continue;
  }

  let skip = null;
  if (locked) {
    skip = "locked (active agent)";
  } else if (sh("git status --porcelain", path) !== "") {
    skip = "dirty (uncommitted/untracked changes)";
  } else {
    // HEAD must be fully contained in origin/main (every commit merged).
    const head = sh("git rev-parse HEAD", path);
    const merged =
      head &&
      (() => {
        try {
          execSync(`git merge-base --is-ancestor ${head} origin/main`, {
            cwd: path,
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      })();
    if (!merged) skip = "has unmerged commits vs origin/main";
  }

  if (skip) {
    log(`KEEP  ${path} — ${skip}`);
    kept++;
    continue;
  }

  log(`${force ? "REMOVE" : "would remove"}  ${path} — fully merged + clean`);
  if (force) {
    sh(`git worktree remove "${path}"`);
    removed++;
  } else {
    removed++; // counts as "would remove" in dry-run
  }
}

if (force) sh("git worktree prune"); // drop stale administrative entries
log(
  `${force ? "removed" : "would remove"} ${removed}, kept ${kept}. ` + (force ? "" : "Re-run with --force to apply."),
);
process.exit(0);
