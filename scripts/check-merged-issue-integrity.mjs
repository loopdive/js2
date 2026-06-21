#!/usr/bin/env node
// PR-time issue-integrity gate against a SIMULATED MERGE with main (#2530).
//
// WHY THIS EXISTS
// ---------------
// `scripts/check-committed-issue-integrity.mjs` runs the duplicate-ID /
// filename-mismatch / dangling-depends_on gate against a single committed tree
// (default HEAD). On a `pull_request` event the `quality` job runs it on the
// PR's own branch tip — but that branch was cut from an OLDER `main`. If a
// sibling PR has since merged a `plan/issues/<id>-<slug>.md` with the SAME id,
// the collision is invisible on the stale branch and the check passes. The
// collision only surfaces later in the `merge_group` run (which validates
// `main + PR`), where it fails the `quality` job repeatedly and WEDGES the
// merge queue with "N duplicate IDs" (see
// .claude/memory/project_merge_queue_dup_issue_id_churn.md).
//
// This wrapper closes that gap: it computes the tree that WOULD result from
// merging current `origin/main` into the PR head (via `git merge-tree
// --write-tree`, which touches neither the index nor the working tree), then
// runs the committed-integrity check against that merged tree. A stale-base
// id collision therefore fails the PR's OWN `quality` check, before it can
// reach — and wedge — the merge queue.
//
// USAGE
//   node scripts/check-merged-issue-integrity.mjs [<base-ref>] [<head-ref>]
//     base-ref  default: origin/main  (the branch the PR will merge INTO)
//     head-ref  default: HEAD         (the PR head)
//
// BEHAVIOUR
//   - If the base ref cannot be resolved (e.g. `origin/main` not fetched in a
//     shallow checkout, or a non-PR context), the check SKIPS cleanly (exit 0)
//     with a diagnostic — it never blocks a build it cannot reason about.
//   - If `git merge-tree` reports merge conflicts, the merged tree OID is still
//     printed on its first line; we proceed to run the integrity check against
//     it (a content conflict inside an issue file does not change its id, so the
//     dup-id signal is still valid). We surface the conflict as a note.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const baseRef = argv[0] || process.env.MERGED_INTEGRITY_BASE || "origin/main";
const headRef = argv[1] || "HEAD";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const INTEGRITY_SCRIPT = join(SELF_DIR, "check-committed-issue-integrity.mjs");

function tryRevParse(ref) {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Resolve the base. A shallow `git fetch --depth=1 origin main` updates
// FETCH_HEAD but does NOT always create the `refs/remotes/origin/main`
// tracking ref (depends on the remote's fetch refspec — GitHub's
// actions/checkout configures it, a bare `git clone --branch X` does not). So
// fall back to FETCH_HEAD when the named base ref is missing. This keeps the
// gate effective under a shallow CI checkout instead of silently skipping.
let baseSha = tryRevParse(baseRef);
let resolvedBaseDesc = baseRef;
if (!baseSha) {
  const viaFetchHead = tryRevParse("FETCH_HEAD");
  if (viaFetchHead) {
    baseSha = viaFetchHead;
    resolvedBaseDesc = `${baseRef} (via FETCH_HEAD)`;
  }
}
const headSha = tryRevParse(headRef);

if (!baseSha) {
  console.log(
    `[merged-issue-integrity] base ref '${baseRef}' (and FETCH_HEAD) is unresolvable here — ` +
      `skipping the merged-tree check (the per-branch committed check still runs).`,
  );
  process.exit(0);
}
if (!headSha) {
  console.error(`[merged-issue-integrity] head ref '${headRef}' is unresolvable — cannot continue.`);
  process.exit(1);
}

// If the PR head already contains base (fast-forward / already up to date),
// the merged tree IS the head tree; merge-tree still returns it. We run it
// unconditionally for a single, uniform code path.
function mergeTreeWriteTree(extraArgs = []) {
  return spawnSync("git", ["merge-tree", "--write-tree", ...extraArgs, baseSha, headSha], {
    encoding: "utf8",
  });
}

let mergeTree = mergeTreeWriteTree();

// Under a shallow CI checkout (`actions/checkout` defaults to fetch-depth: 1
// and the gate's `git fetch --depth=1 origin main` only deepens by one), the
// real merge base can lie outside the fetched history. git then errors with
// "refusing to merge unrelated histories" and produces NO tree — which would
// hard-fail every PR, not just colliding ones. Retry with
// `--allow-unrelated-histories`: with an empty merge base merge-tree does a
// pure UNION of both trees, so any file present on either side appears — which
// is exactly (and conservatively) what dup-id detection needs. It can never
// hide a collision and never invents one. The CI step also deepens the fetch
// so the common case still gets a true 3-way merge.
if (!mergeTree.error && mergeTree.status !== 0 && /unrelated histories/i.test(mergeTree.stderr || "")) {
  console.log(
    `[merged-issue-integrity] note: merge base for '${baseRef}' is outside the ` +
      `shallow history — retrying with --allow-unrelated-histories (tree-union; ` +
      `dup-id detection is unaffected).`,
  );
  mergeTree = mergeTreeWriteTree(["--allow-unrelated-histories"]);
}

if (mergeTree.error) {
  console.error(
    `[merged-issue-integrity] 'git merge-tree --write-tree' is unavailable ` +
      `(${mergeTree.error.message}). Needs git >= 2.38. Skipping merged-tree check.`,
  );
  // Don't hard-fail on toolchain gaps — the per-branch committed check still gates.
  process.exit(0);
}

const stdoutLines = (mergeTree.stdout || "").split("\n");
const mergedTreeOid = stdoutLines[0]?.trim();

if (!mergedTreeOid || !/^[0-9a-f]{40,64}$/.test(mergedTreeOid)) {
  console.error(
    `[merged-issue-integrity] could not parse merged tree OID from 'git merge-tree' output:\n` +
      (mergeTree.stdout || "(empty)") +
      (mergeTree.stderr ? `\nstderr: ${mergeTree.stderr}` : ""),
  );
  process.exit(1);
}

// Exit status 1 from merge-tree = the merge has conflicts; the tree OID is
// still printed first. A conflict inside an issue file does not alter its id,
// so the dup-id / mismatch / dangling signals computed below stay valid.
if (mergeTree.status !== 0) {
  console.log(
    `[merged-issue-integrity] note: merging '${baseRef}' into the PR head reports ` +
      `conflicts. The dup-id check still runs against the merged tree; resolve the ` +
      `conflict before merging regardless.`,
  );
}

console.log(
  `[merged-issue-integrity] checking issue integrity on the merge of ` +
    `${resolvedBaseDesc} (${baseSha.slice(0, 9)}) into ${headRef} (${headSha.slice(0, 9)}) → tree ${mergedTreeOid.slice(0, 9)}`,
);

// Delegate to the existing committed-integrity checker, pointed at the merged
// tree OID. It accepts any tree-ish as its first arg and uses `git ls-tree` /
// `git show <ref>:<file>` internally — both consume a bare tree OID fine.
const result = spawnSync("node", [INTEGRITY_SCRIPT, mergedTreeOid], {
  encoding: "utf8",
  stdio: "inherit",
});

if (result.status !== 0) {
  console.error(
    `\n[merged-issue-integrity] FAILED against the merge with ${baseRef}. ` +
      `This is the collision that would otherwise wedge the merge queue. ` +
      `Rename the colliding issue file to a fresh id (see ` +
      `\`node scripts/next-issue-id.mjs\`) and re-push.`,
  );
}
process.exit(result.status ?? 1);
