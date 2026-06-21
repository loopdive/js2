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
//   node scripts/claim-issue.mjs --allocate [<assignee>] [--branch <b>] [--json]
//   node scripts/claim-issue.mjs --check <id>
//   node scripts/claim-issue.mjs --release <id> [<assignee>]
//   node scripts/claim-issue.mjs --complete <id>
//   node scripts/claim-issue.mjs --list
//
// ATOMIC ID ALLOCATION (#2531): `--allocate` is the canonical, collision-proof
// way to reserve a FRESH issue id. Picking an id by hand ("next free off main")
// races: two devs on separate branches each pick the same number because none
// of their new `plan/issues/<id>-*.md` files are on `main` yet, the duplicate
// is green at PR-time, and it only fails in the `merge_group` — wedging the
// queue. `--allocate` closes that window by treating the orphan
// `issue-assignments` ref as a RESERVATION REGISTRY: the next id is
// max(ids on origin/main ∪ ids added by every currently-open PR ∪ ids already
// reserved on the ref) + 1, and the reservation is written with the same
// first-push-wins atomicity as a claim. Two concurrent allocators cannot both
// win the same id — the loser's push is rejected non-fast-forward, it re-fetches
// (now seeing the winner's reservation) and recomputes a fresh id. With an
// `<assignee>` the reservation doubles as the claim lock; without one it writes
// a bare `reserved` placeholder the eventual claim transitions in place.
//
// SLICE-LEVEL LOCKING (#41): for an issue the architect decomposed into
// FILE-DISJOINT parallel slices, pass a slice-qualified id `<issue>:<slice>`
// (e.g. `2158:glue1`). Each distinct `<issue>:<slice>` takes its OWN lock
// (`<issue>-<slice>.json` on the ref), so the slices can be held concurrently
// instead of serializing on one issue-level lock — while two agents still can't
// grab the SAME slice. A plain `<issue>` (no `:`) keeps the issue-level lock
// (`<issue>.json`), which stays the default for single-slice issues. The
// done/wont-fix-on-main pre-flight resolves the BASE issue number from the
// qualified id, so a slice claim is still refused once the parent issue closes.
//
// Assignee convention: humans use their name/handle; dev AGENTS use their
// github-account-prefixed name, e.g. `ttraenkler/senior-dev-1`. The default
// account prefix for an unqualified agent name can be supplied via
// CLAIM_GITHUB_ACCOUNT; a name already containing `/` is used verbatim.
//
// Exit codes: 0 ok / free · 2 usage error · 3 already claimed by someone else
//             4 issue already done/wont-fix on main · 5 push gave up after retries
// (--allocate prints the reserved id to stdout on success and exits 0.)

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
  : flags.has("--allocate")
    ? "allocate"
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

// Parse a (possibly slice-qualified) target id (#41).
//   "2158"        -> { base: "2158", slice: "",       key: "2158",       label: "#2158" }
//   "2158:glue1"  -> { base: "2158", slice: "glue1",  key: "2158-glue1", label: "#2158:glue1" }
// `base` is the numeric issue id used for the main done/wont-fix pre-flight and
// dependency-graph lookups; `key` is the per-lock filename stem on the ref so
// distinct slices of one issue hold independent locks. The slice tag is
// sanitized to keep the lock filename git/path-safe.
function parseTarget(raw) {
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep < 0) {
    return { base: raw, slice: "", key: raw, label: `#${raw}` };
  }
  const base = raw.slice(0, sep);
  const sliceRaw = raw.slice(sep + 1);
  const slice = sliceRaw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!base || !slice) {
    die(2, `invalid slice-qualified id "${raw}" — expected "<issue>:<slice>" with a non-empty slice tag`);
  }
  return { base, slice, key: `${base}-${slice}`, label: `#${base}:${slice}` };
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

// --- id-universe scanning (for --allocate) ----------------------------------
//
// A fresh issue id must be unique against THREE populations, because none of
// them alone closes the collision window:
//   (1) ids already on origin/main          — the committed record;
//   (2) ids added by every currently-open PR — in-flight files not yet merged
//       (THE race the merge-queue wedge came from);
//   (3) ids already reserved on this ref     — concurrent allocators that won
//       a push microseconds ago.
// `allUsedIds()` unions all three; the next id is max(union)+1 (monotonic — we
// never reuse a gap that might be reserved on a branch this scan can't see).

const ISSUE_ID_RE = /(?:^|\/)plan\/issues\/(\d+)[a-z]?-[^/]*\.md$/;

// Stray ids separated from the contiguous body by a large gap (a mis-typed
// 6406 when the real range is ~2500) must not poison max+1 and hand out a 6408
// — the #1858 mis-allocation. Drop anything > GAP above the running max.
const STRAY_GAP = 1000;

function contiguousMax(idSet) {
  const sorted = [...idSet].sort((a, b) => a - b);
  let max = 0;
  for (const id of sorted) {
    if (max > 0 && id - max > STRAY_GAP) break;
    max = id;
  }
  return max;
}

function idsFromMain() {
  const out = new Set();
  const ls = gitTry(["ls-tree", "-r", "--name-only", MAIN_REF, "plan/issues/"]);
  if (!ls.ok) return out;
  for (const f of ls.out.split("\n")) {
    const m = f.match(ISSUE_ID_RE);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

// Ids reserved/claimed on the orphan ref. Every `<key>.json` entry's `id`
// field counts — a `reserved` placeholder reserves the number just as firmly
// as an in-progress claim, otherwise two allocators racing the same second
// would both compute the same max+1.
function idsFromAssignRef(sha) {
  const out = new Set();
  if (!sha) return out;
  const ls = gitTry(["ls-tree", "--name-only", sha]);
  if (!ls.ok) return out;
  for (const f of ls.out.split("\n")) {
    if (!f.endsWith(".json")) continue;
    const e = readEntry(sha, f.replace(/\.json$/, ""));
    if (e && e.id != null && /^\d+$/.test(String(e.id))) out.add(Number(e.id));
  }
  return out;
}

// Ids added by currently-open PRs. Uses `gh` when available (the only way to
// see a fork-headed PR whose branch is NOT a refs/remotes/origin/* ref here).
// Best-effort: on any gh failure (offline, unauthenticated, old gh) we return
// an empty set and fall back to main ∪ ref — the PR-time CI gate
// (check-issue-ids --against-main) is the hard backstop, this scan only shrinks
// the race window at allocation time.
function idsFromOpenPRs() {
  const out = new Set();
  const repo = process.env.CLAIM_PR_REPO || "loopdive/js2";
  // List open PR numbers (cap to keep the per-PR file query bounded).
  let prNumbers = [];
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    prNumbers = JSON.parse(raw).map((p) => p.number);
  } catch {
    return out; // gh unavailable / unauthenticated — fall back to main ∪ ref
  }
  for (const n of prNumbers) {
    try {
      const raw = execFileSync("gh", ["pr", "view", String(n), "-R", repo, "--json", "files"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const f of JSON.parse(raw).files || []) {
        const m = (f.path || "").match(ISSUE_ID_RE);
        if (m) out.add(Number(m[1]));
      }
    } catch {
      /* skip this PR */
    }
  }
  return out;
}

function allUsedIds(sha, { scanPRs }) {
  const all = new Set([...idsFromMain(), ...idsFromAssignRef(sha)]);
  if (scanPRs) for (const id of idsFromOpenPRs()) all.add(id);
  return all;
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
  rows.sort((a, b) => Number(a.id) - Number(b.id) || String(a.slice || "").localeCompare(String(b.slice || "")));
  if (!rows.length) {
    console.log("No active claims.");
    return;
  }
  console.log("id\tslice\tassignee\tstatus\tbranch\tclaimed_at");
  for (const e of rows) {
    console.log(`${e.id}\t${e.slice || "-"}\t${e.assignee}\t${e.status}\t${e.branch || "-"}\t${e.claimed_at || "-"}`);
  }
}

function doCheck(target) {
  const sha = remoteAssignSha();
  fetchAssign(sha);
  const e = readEntry(sha, target.key);
  if (isHeld(e)) {
    console.log(`${target.label} is CLAIMED by ${e.assignee} (since ${e.claimed_at || "?"}).`);
    process.exit(3);
  }
  console.log(`${target.label} is UNASSIGNED.`);
  process.exit(0);
}

// --- claim / release / complete (write modes, with retry) -------------------
function nowIso() {
  // Date.* is fine in a plain node script (this is not a workflow sandbox).
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// Atomically reserve the next free issue id (#2531). Computes max(used)+1 over
// origin/main ∪ open-PR-added ids ∪ ref-reserved ids, writes a reservation
// entry, and pushes first-wins. On a non-ff rejection (another allocator landed
// a reservation since we read), re-fetch and recompute a fresh id — so two
// concurrent allocators can NEVER hand out the same number. Prints the reserved
// id to stdout (machine-readable; the human/JSON detail goes to stderr or with
// --json). `assignee` is optional: with one the reservation doubles as the claim
// lock (status in-progress); without one it's a bare `reserved` placeholder the
// real claim transitions in place.
function doAllocate(assignee) {
  const wantJson = flags.has("--json");
  const scanPRs = !flags.has("--no-pr-scan");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const sha = remoteAssignSha();
    fetchAssign(sha);

    const used = allUsedIds(sha, { scanPRs });
    // contiguousMax+1 is always strictly above the contiguous body, so it can
    // never alias an in-use id (strays sit > STRAY_GAP above max, never at +1).
    const id = String(contiguousMax(used) + 1);

    // --dry-run: preview the candidate without reserving (no push). Useful to
    // see "what id would I get" without burning a reservation. NOT collision-
    // safe on its own — only the real reserve+push is atomic.
    if (flags.has("--dry-run")) {
      if (wantJson) process.stdout.write(JSON.stringify({ id: Number(id), dryRun: true }) + "\n");
      else {
        console.error(
          `(dry-run) next free id would be #${id} (scanned ${used.size} used ids; PR-scan ${scanPRs ? "on" : "off"})`,
        );
        process.stdout.write(`${id}\n`);
      }
      return;
    }

    const entry = {
      id,
      assignee: assignee || "",
      status: assignee ? "in-progress" : "reserved",
      branch: assignee ? branch || "" : "",
      reserved_at: nowIso(),
      ...(assignee ? { claimed_at: nowIso() } : {}),
      updated_at: nowIso(),
    };
    const verb = assignee ? `reserve+claim #${id} -> ${assignee}` : `reserve #${id}`;
    const msg = `chore(assign): ${verb} [skip ci]`;
    const content = JSON.stringify(entry, null, 2) + "\n";

    if (commitAndPush(sha, id, content, msg)) {
      // stdout = just the id (scriptable); details to stderr unless --json.
      if (wantJson) {
        process.stdout.write(
          JSON.stringify({ id: Number(id), assignee: assignee || null, branch: entry.branch || null }) + "\n",
        );
      } else {
        console.error(
          `Reserved issue #${id}${assignee ? ` for ${assignee}${entry.branch ? ` (branch ${entry.branch})` : ""}` : ""}.`,
        );
        console.error(`(pushed to ${REMOTE}/${ASSIGN_REF}; main untouched, no CI triggered)`);
        process.stdout.write(`${id}\n`);
      }
      return;
    }
    console.error(`allocate: ref moved (attempt ${attempt}/${MAX_RETRIES}) — re-scanning for a fresh id…`);
  }
  die(5, `Could not reserve a fresh id after ${MAX_RETRIES} attempts (heavy contention). Re-run.`);
}

function writeMode(target, assignee, kind) {
  const { base, slice, key, label } = target;
  // Pre-flight: refuse claiming an issue already closed on main. Resolve the
  // BASE issue number so a slice claim is still refused once the parent closes.
  if (kind === "claim") {
    const main = mainIssueStatus(base);
    if (main && (main.status === "done" || main.status === "wont-fix")) {
      die(4, `${label} is already ${main.status} on ${MAIN_REF} (${main.file}). Nothing to claim.`);
    }
    if (!main) {
      console.error(`warning: no issue file for #${base} found on ${MAIN_REF}; claiming anyway.`);
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const sha = remoteAssignSha();
    fetchAssign(sha);
    const existing = readEntry(sha, key);

    if (kind === "claim") {
      if (isHeld(existing) && existing.assignee !== assignee && !flags.has("--force")) {
        die(
          3,
          `${label} is already claimed by ${existing.assignee} (since ${existing.claimed_at || "?"}). Pick another issue${slice ? "/slice" : ""}, or pass --force to steal.`,
        );
      }
    }
    if (kind === "release" || kind === "complete") {
      if (!isHeld(existing)) {
        console.log(`${label} is not currently claimed — nothing to ${kind}.`);
        return;
      }
      if (assignee && existing.assignee !== assignee && !flags.has("--force")) {
        die(3, `${label} is held by ${existing.assignee}, not ${assignee}. Pass --force to override.`);
      }
    }

    const entry = {
      id: base,
      ...(slice ? { slice } : {}),
      assignee: kind === "claim" ? assignee : existing ? existing.assignee : assignee,
      status: kind === "claim" ? "in-progress" : kind === "complete" ? "done" : "released",
      branch: kind === "claim" ? branch || (existing && existing.branch) || "" : (existing && existing.branch) || "",
      claimed_at: kind === "claim" ? nowIso() : existing ? existing.claimed_at : nowIso(),
      updated_at: nowIso(),
    };
    if (kind !== "claim") entry.released_at = nowIso();

    const verb = kind === "claim" ? "claim" : kind;
    const msg = `chore(assign): ${verb} ${label} -> ${entry.assignee} [skip ci]`;
    const content = JSON.stringify(entry, null, 2) + "\n";

    if (commitAndPush(sha, key, content, msg)) {
      const human =
        kind === "claim"
          ? `Claimed ${label} for ${entry.assignee}${entry.branch ? ` (branch ${entry.branch})` : ""}.`
          : kind === "complete"
            ? `Marked ${label} complete (was ${entry.assignee}).`
            : `Released ${label} (was ${entry.assignee}).`;
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
} else if (mode === "allocate") {
  // --allocate [<assignee>] — reserve the next fresh id. Assignee optional.
  doAllocate(normalizeAssignee(positional[0] || process.env.CLAIM_ASSIGNEE || ""));
} else if (mode === "check") {
  const id = positional[0];
  if (!id) die(2, "usage: claim-issue.mjs --check <id[:slice]>");
  doCheck(parseTarget(id));
} else if (mode === "release" || mode === "complete") {
  const id = positional[0];
  if (!id) die(2, `usage: claim-issue.mjs --${mode} <id[:slice]> [<assignee>]`);
  writeMode(parseTarget(id), normalizeAssignee(positional[1] || process.env.CLAIM_ASSIGNEE || ""), mode);
} else {
  const id = positional[0];
  const assignee = normalizeAssignee(positional[1] || process.env.CLAIM_ASSIGNEE || "");
  if (!id || !assignee) {
    die(
      2,
      "usage: claim-issue.mjs <id[:slice]> <assignee> [--branch <b>] [--force]\n  (assignee may also come from $CLAIM_ASSIGNEE; agents use ttraenkler/<agent-name>)",
    );
  }
  writeMode(parseTarget(id), assignee, "claim");
}
