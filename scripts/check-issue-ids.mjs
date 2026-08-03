#!/usr/bin/env node
/**
 * Check for duplicate `id:` fields across plan/issues/*.md files.
 * Exits 1 if duplicates are found (for use as a pre-push or pre-commit hook).
 *
 * Usage:
 *   node scripts/check-issue-ids.mjs               # check workspace files
 *   node scripts/check-issue-ids.mjs --staged      # check git-staged files only (pre-commit)
 *   node scripts/check-issue-ids.mjs --committed   # check committed tree (HEAD)
 *   node scripts/check-issue-ids.mjs --against-main # PR-time fresh-claim gate (#2531)
 *   node scripts/check-issue-ids.mjs --against-open-prs # PR-vs-PR collision gate (#3598)
 *
 * --against-main is the REQUIRED-CI half of the atomic-allocation defense
 * (#2531). A PR that *introduces* a plan/issues/<id>-*.md whose id already
 * exists on origin/main (under any filename) is a collision the merge_group
 * would reject — but it can pass the PR's own self-consistency checks because
 * the colliding file isn't on the PR branch yet at branch time. This mode
 * diffs the branch's introduced ids (present at HEAD, absent at the
 * merge-base with main) against the ids on origin/main and FAILS the PR before
 * it reaches the queue. The base ref is GATE_BASE (default origin/main); CI
 * fetches it shallowly. Complements the sibling merged-state dup gate (#2530):
 * that one re-checks the simulated merge tree; this one rejects at PR time with
 * a precise "use claim-issue.mjs --allocate" message so the dev never wedges
 * the queue in the first place.
 *
 * --against-open-prs (#3598) is the PR-vs-PR half --against-main cannot see:
 * two OPEN PRs each adding plan/issues/<id>-*.md are BOTH green against main
 * (neither file is on main yet), and the collision surfaces only when the
 * first merges — at best a late red re-check, at worst a merge_group
 * auto-park (#2547) that strands the loser behind a `hold` label. This mode
 * compares the branch's introduced issue files against every OTHER open PR's
 * added issue files, via the SAME batched scan `claim-issue.mjs --allocate`
 * uses (scripts/lib/open-pr-issue-files.mjs — one code path, no drift).
 * FAIL-OPEN on scan failure: this check needs network on every PR, and
 * failing closed would convert a GitHub blip into a total merge freeze; it
 * degrades loudly and the merge_group duplicate-id gate remains the hard
 * backstop. Set GATE_PR_NUMBER (or PR_NUMBER) to the PR under validation so
 * it never collides with itself.
 */

import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { openPrIssueFiles, findOpenPrCollisions } from "./lib/open-pr-issue-files.mjs";
import { resolveMainRef } from "./lib/change-scope.mjs";

const args = process.argv.slice(2);
const mode = args.includes("--against-main")
  ? "against-main"
  : args.includes("--against-open-prs")
    ? "against-open-prs"
    : args.includes("--staged")
      ? "staged"
      : args.includes("--committed")
        ? "committed"
        : "workspace";

/**
 * Extract the issue ID from a filename: "1799-foo.md" → "1799", "779a-bar.md" → "779a".
 * Sub-issues (779a, 779b, ...) share a parent numeric ID but have distinct filename IDs.
 * We key deduplication on the filename ID so sub-issues are never flagged as duplicates.
 */
function filenameId(fname) {
  return fname.match(/^(\d+[a-z]?)/i)?.[1]?.toLowerCase() ?? null;
}

const NON_ISSUE = new Set(["backlog.md", "index.md", "log.md", "SCHEMA.md"]);

/** @returns {Map<string, string[]>} filename-id → [filePath, ...] */
function collectFromWorkspace() {
  const dir = new URL("../plan/issues", import.meta.url).pathname;
  const map = new Map();
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith(".md") || NON_ISSUE.has(fname)) continue;
    const fpath = join(dir, fname);
    if (!statSync(fpath).isFile()) continue;
    const id = filenameId(fname);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(fname);
  }
  return map;
}

function collectFromStaged() {
  // Get staged plan/issues/*.md files
  const staged = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.startsWith("plan/issues/") && f.endsWith(".md"));

  // Start with committed tree, then overlay staged changes
  const map = collectFromCommitted();

  for (const fpath of staged) {
    try {
      const fname = fpath.replace("plan/issues/", "");
      if (NON_ISSUE.has(fname)) continue;
      const id = filenameId(fname);
      if (!id) continue;
      // Remove any prior entry for this file (covers renames)
      for (const [k, v] of map) {
        const idx = v.indexOf(fname);
        if (idx !== -1) v.splice(idx, 1);
        if (v.length === 0) map.delete(k);
      }
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(fname);
    } catch {}
  }
  return map;
}

function collectFromCommitted() {
  let listing;
  try {
    listing = execSync("git ls-tree --name-only HEAD plan/issues/", { encoding: "utf8" });
  } catch {
    return new Map(); // no commits yet
  }
  const map = new Map();
  for (const line of listing.split("\n")) {
    const fname = line.trim();
    if (!fname.endsWith(".md") || NON_ISSUE.has(fname)) continue;
    const id = filenameId(fname);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(fname);
  }
  return map;
}

// --against-main (#2531): map id -> Set(filenames) for the issue files in a
// tree-ish ref. Returns null if the ref isn't present (shallow clone). We track
// FILENAMES, not just ids, because the wedge collision is two *different* files
// sharing one id (branch adds `2503-newslug.md`, main already has
// `2503-otherslug.md`) — the merged tree then holds a duplicate id even though
// neither id is "new".
function fileIdsInRef(ref) {
  let listing;
  try {
    listing = execSync(`git ls-tree -r --name-only ${ref} plan/issues/`, { encoding: "utf8" });
  } catch {
    return null; // ref not present (e.g. not fetched) — caller decides
  }
  const map = new Map(); // id -> Set(filename)
  for (const line of listing.split("\n")) {
    const path = line.trim();
    if (!path.startsWith("plan/issues/") || !path.endsWith(".md")) continue;
    const fname = path.slice("plan/issues/".length);
    if (fname.includes("/") || NON_ISSUE.has(fname)) continue; // skip subdirs (sprints/, backlog/) + non-issues
    const id = filenameId(fname);
    if (!id) continue;
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(fname);
  }
  return map;
}

// Files this branch INTRODUCED = (id, filename) pairs present at HEAD but
// absent at the merge-base with `base`. Using the merge-base (not base itself)
// avoids flagging files an earlier `git merge origin/main` legitimately
// carried in — only files genuinely new on this branch count. Shared by
// --against-main and --against-open-prs so both modes agree on what "this
// branch added" means (#3598). Returns null when the base ref isn't present.
function introducedIssueFiles(base) {
  const baseTree = fileIdsInRef(base);
  if (baseTree === null) return null;
  let mergeBase = "HEAD";
  try {
    mergeBase = execSync(`git merge-base ${base} HEAD`, { encoding: "utf8" }).trim() || "HEAD";
  } catch {
    /* fall back to HEAD (treats every HEAD file as introduced — safe, stricter) */
  }
  const headFiles = fileIdsInRef("HEAD") || new Map();
  const mergeBaseFiles = fileIdsInRef(mergeBase) || new Map();
  const introduced = [];
  for (const [id, fnames] of headFiles) {
    const atMergeBase = mergeBaseFiles.get(id) || new Set();
    for (const fname of fnames) {
      if (!atMergeBase.has(fname)) introduced.push({ id, fname });
    }
  }
  return { baseTree, introduced };
}

function checkAgainstMain() {
  const base = process.env.GATE_BASE || resolveMainRef(process.cwd()).ref;
  const r = introducedIssueFiles(base);
  if (r === null) {
    // Base ref unavailable (shallow clone without it). Skip cleanly rather than
    // block a build we can't reason about — the merged-state gate (#2530) is the
    // backstop. Mirrors the issue-spec-coverage gate's "skip when no base" rule.
    console.log(
      `✓ --against-main skipped: base ref '${base}' not present (shallow checkout); merged-state gate covers it`,
    );
    process.exit(0);
  }
  const { baseTree: mainFiles, introduced } = r;

  // collisions: an introduced filename whose id already exists on base under a
  // DIFFERENT filename. (Same filename on base = the branch just modified an
  // existing issue — fine. Different filename = the wedge dup.)
  const collisions = [];
  for (const { id, fname } of introduced) {
    const baseFnamesForId = mainFiles.get(id);
    if (!baseFnamesForId) continue; // id not on base at all → genuinely fresh, fine
    const conflictsOnMain = [...baseFnamesForId].filter((bf) => bf !== fname);
    if (conflictsOnMain.length) {
      collisions.push({ id, fname, conflictsOnMain });
    }
  }

  if (collisions.length === 0) {
    if (!args.includes("--quiet")) {
      console.log(`✓ --against-main OK: no branch-introduced issue file collides with an id on ${base}`);
    }
    process.exit(0);
  }

  console.error(
    `✗ --against-main FAILED: ${collisions.length} issue file${collisions.length > 1 ? "s" : ""} introduced by this branch reuse an id already on ${base}:`,
  );
  for (const { id, fname, conflictsOnMain } of collisions.sort((a, b) => +a.id - +b.id)) {
    console.error(`  #${id}: this branch adds plan/issues/${fname}`);
    for (const bf of conflictsOnMain) console.error(`         but ${base} already has plan/issues/${bf}`);
  }
  console.error("");
  console.error("This is the merge-queue-wedge collision (#2531): the id is already taken on main.");
  console.error("Fix: reserve a FRESH id atomically and rename your file —");
  console.error("  NEW=$(node scripts/claim-issue.mjs --allocate)   # prints the reserved id");
  console.error("  git mv plan/issues/<old>-<slug>.md plan/issues/$NEW-<slug>.md");
  console.error("  # then update the file's frontmatter id: to $NEW");
  process.exit(1);
}

// --against-open-prs (#3598): the PR-vs-PR collision --against-main is blind
// to. Compares this branch's introduced issue files against every OTHER open
// PR's added issue files. Same id + same filename = both PRs touching one
// issue file (a modification) → PASS; same id + DIFFERENT filename = the
// race that ends in a merge_group auto-park → FAIL loudly at PR level, naming
// the PR raced. FAIL-OPEN when the scan can't run (network gate must not be
// able to freeze all of CI); the merge_group dup gate stays the hard backstop.
function checkAgainstOpenPrs() {
  const base = process.env.GATE_BASE || resolveMainRef(process.cwd()).ref;
  const r = introducedIssueFiles(base);
  if (r === null) {
    console.log(
      `✓ --against-open-prs skipped: base ref '${base}' not present (shallow checkout); merge_group dup gate covers it`,
    );
    process.exit(0);
  }
  const { introduced } = r;
  if (introduced.length === 0) {
    // No network call when the branch adds no issue files — the common case.
    console.log("✓ --against-open-prs OK: this branch introduces no issue files (open-PR scan skipped)");
    process.exit(0);
  }

  const selfPr = process.env.GATE_PR_NUMBER || process.env.PR_NUMBER || null;
  const scan = openPrIssueFiles();
  if (!scan.complete) {
    // FAIL-OPEN, loudly (#3598 design decision): warn, never block. A red
    // check here on a GitHub blip/rate-limit would wedge EVERY open PR at
    // once. --against-main stays hard; merge_group --check is the backstop.
    console.warn(
      "⚠ --against-open-prs DEGRADED: open-PR scan failed/timed out (gh offline, unauthenticated, or rate-limited).",
    );
    console.warn(
      "  Passing WITHOUT PR-vs-PR collision coverage — the merge_group duplicate-id gate remains the backstop.",
    );
    process.exit(0);
  }

  const collisions = findOpenPrCollisions(introduced, scan.byPr, { selfPr });
  if (collisions.length === 0) {
    if (!args.includes("--quiet")) {
      console.log(
        `✓ --against-open-prs OK: ${introduced.length} introduced issue file${introduced.length > 1 ? "s collide" : " collides"} with none of ${scan.byPr.size} open PR${scan.byPr.size === 1 ? "" : "s"} touching issue files`,
      );
    }
    process.exit(0);
  }

  console.error(
    `✗ --against-open-prs FAILED: ${collisions.length} issue-id collision${collisions.length > 1 ? "s" : ""} with other OPEN PRs (#3598):`,
  );
  for (const { id, fname, prNumber, otherPath } of collisions) {
    console.error(`  #${id}: this branch adds plan/issues/${fname}`);
    console.error(`         but open PR #${prNumber} already adds ${otherPath}`);
  }
  console.error("");
  console.error("Two open PRs claim the same issue id. If neither renumbers, the one that");
  console.error("merges second gets auto-parked in the merge queue (`hold` label) and strands.");
  console.error("Tie-break: the merged/queued PR keeps the id; otherwise the EARLIER");
  // (#4045/#4117) Named `origin/issue-assignments` until 2026-08-03. In agent
  // worktrees `origin` is the FORK, so this instruction pointed the loser of a
  // collision at the very book whose separateness caused it. There is one book
  // now and it is upstream's; `claim-issue.mjs --check` prints which ref
  // answered, so the tie-break can be settled from its output.
  console.error("reservation on the issue-assignments ref (upstream's — `claim-issue.mjs --check <id>`");
  console.error("prints which book answered) wins. The losing branch renumbers:");
  console.error("  NEW=$(node scripts/claim-issue.mjs --allocate)   # prints the reserved id");
  console.error("  git mv plan/issues/<old>-<slug>.md plan/issues/$NEW-<slug>.md");
  console.error("  # then update the file's frontmatter id: to $NEW");
  process.exit(1);
}

if (mode === "against-main") {
  checkAgainstMain();
} else if (mode === "against-open-prs") {
  checkAgainstOpenPrs();
}

const map =
  mode === "staged" ? collectFromStaged() : mode === "committed" ? collectFromCommitted() : collectFromWorkspace();

const dupes = [...map.entries()].filter(([, v]) => v.length > 1);

if (dupes.length === 0) {
  if (!args.includes("--quiet")) {
    console.log(`✓ No duplicate issue IDs found (${map.size} issues, mode=${mode})`);
  }
  process.exit(0);
} else {
  console.error(`✗ --check FAILED: ${dupes.length} duplicate ID${dupes.length > 1 ? "s" : ""}`);
  for (const [id, files] of dupes.sort((a, b) => +a[0] - +b[0])) {
    console.error(`  #${id}:`);
    for (const f of files) console.error(`    plan/issues/${f}`);
  }
  console.error("");
  console.error("Fix: reserve a FRESH id atomically and rename the newer file —");
  console.error("  NEW=$(node scripts/claim-issue.mjs --allocate)   # prints the reserved id");
  console.error("  git mv plan/issues/<old>-<slug>.md plan/issues/$NEW-<slug>.md   # then set frontmatter id: $NEW");
  process.exit(1);
}
