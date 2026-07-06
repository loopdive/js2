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
// --dry-run works for --allocate AND for the claim/release/complete write modes:
// it previews the action and returns BEFORE any commit/push, so the
// issue-assignments ref is never touched. It is position-independent (the flag
// may appear anywhere in argv).
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
// The issue-assignments orphan ref lives on the FORK (origin) — keep REMOTE =
// origin for ALL reservation-ref operations (ls-remote / fetch / push of claims).
const REMOTE = process.env.CLAIM_ASSIGN_REMOTE || "origin";
// The MAIN id scan, however, must use UPSTREAM (loopdive/js2). The fork's
// `origin/main` lags upstream by thousands of commits, so "next free off
// origin/main" returns ids already taken on upstream/main — every such
// allocation then collides at the required `check:issue-ids:against-main` gate
// (which checks upstream/main), ejecting PRs from the merge queue (this is what
// mis-numbered two issues into the 6000s, since renumbered to #2177/#2194).
// Prefer the `upstream` remote when it exists; `CLAIM_REMOTE` overrides.
function pickMainRemote() {
  if (process.env.CLAIM_REMOTE) return process.env.CLAIM_REMOTE;
  const r = gitTry(["remote"]);
  const remotes = r.ok ? r.out.split(/\s+/).filter(Boolean) : [];
  return remotes.includes("upstream") ? "upstream" : "origin";
}
const MAIN_REMOTE = pickMainRemote();
const MAIN_REF = `${MAIN_REMOTE}/main`;

// --- bounded network timeouts (#3079) --------------------------------------
// `--allocate` must NEVER hang indefinitely. `execFileSync` has no default
// timeout, so a single stuck `gh`/`git` call under API contention (many
// concurrent agents) previously blocked the WHOLE team's issue filing. Every
// network call in the allocate path is now capped; the open-PR scan
// additionally carries an overall wall-clock budget, after which it degrades to
// the pre-existing fail-open fallback (allocate against main ∪ reservations
// only — the PR-time `check:issue-ids:against-main` gate is the hard backstop).
// All three are env-overridable for tuning under different load.
const MAIN_FETCH_TIMEOUT_MS = Number(process.env.CLAIM_MAIN_FETCH_TIMEOUT_MS) || 15000;
const PR_SCAN_CALL_TIMEOUT_MS = Number(process.env.CLAIM_PR_SCAN_CALL_TIMEOUT_MS) || 12000;
const PR_SCAN_TOTAL_TIMEOUT_MS = Number(process.env.CLAIM_PR_SCAN_TOTAL_TIMEOUT_MS) || 25000;

// Best-effort refresh of the main tip — only when allocating (frequent
// --check/--list calls shouldn't pay a network round-trip). Bounded so a hung
// fetch can't wedge the allocation before the id scan even starts.
if (process.argv.includes("--allocate")) {
  gitTry(["fetch", "--quiet", MAIN_REMOTE, "main"], { timeout: MAIN_FETCH_TIMEOUT_MS, killSignal: "SIGKILL" });
}
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
  : flags.has("--debug-pr-scan")
    ? "debug-pr-scan"
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
  // (#2974/#2977) Force-update the local mirror ref (`+` refspec). Without the
  // `+`, a diverged local `refs/claim-issue/base` (the ref moved on the remote
  // while we held a stale local copy) makes the fetch fail non-fast-forward
  // ("cannot lock ref … is at <new> but expected <old>") and hard-crashes the
  // script — previously requiring a manual `git update-ref -d`. The base ref is
  // a disposable read mirror, so overwriting it unconditionally is safe.
  git(["fetch", "--quiet", REMOTE, `+${ASSIGN_REF}:refs/claim-issue/base`]);
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
// 6406 when the real range is ~2500) must not poison max+1 and hand out a 2194
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
  const files = ls.out.split("\n").filter((f) => f.endsWith(".json"));
  if (files.length === 0) return out;

  // (#3079) Read EVERY entry blob in a SINGLE `git cat-file --batch` process.
  // The prior implementation spawned one `git cat-file` PER entry — O(N)
  // subprocesses (466 and growing) that took >90s under container load and was
  // the TRUE cause of `--allocate` hanging (previously mis-attributed to the
  // open-PR gh scan). One batched process is ~constant-time and bounded.
  const request = files.map((f) => `${sha}:${f}`).join("\n") + "\n";
  let buf;
  try {
    // NOTE: omit `encoding` so execFileSync returns a Buffer — the `--batch`
    // stream is byte-framed (header declares each object's exact byte size), so
    // it must be walked as bytes. (`encoding: "buffer"` is NOT a valid option
    // value — it throws ERR_UNKNOWN_ENCODING; the default already yields a
    // Buffer.) `input` may still be a string.
    buf = execFileSync("git", ["cat-file", "--batch"], {
      input: request,
      maxBuffer: 128 * 1024 * 1024,
      timeout: MAIN_FETCH_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch {
    // Fallback: derive the id from the FILENAME. Every entry is named
    // `<id>.json` (reservation/allocation) or `<base>-<slice>.json` (slice
    // claim) — the leading digits are the id (verified stable on the ref). This
    // keeps the id universe complete even if the batch read fails.
    for (const f of files) {
      const m = f.match(/^(\d+)/);
      if (m) out.add(Number(m[1]));
    }
    return out;
  }

  // Parse the `--batch` stream: "<oid> <type> <size>\n<content>\n" per object
  // ("<request> missing\n" — no body — for an absent one). Byte-framed, so walk
  // the buffer by the declared size rather than splitting on newlines.
  const LF = 0x0a;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(LF, pos);
    if (nl === -1) break;
    const header = buf.toString("utf8", pos, nl);
    pos = nl + 1;
    const parts = header.split(" ");
    if (parts.length < 3 || parts[1] === "missing") continue; // no content body
    const size = Number(parts[2]);
    if (!Number.isFinite(size) || size < 0) break;
    const content = buf.toString("utf8", pos, pos + size);
    pos += size + 1; // content + trailing LF
    try {
      const e = JSON.parse(content);
      if (e && e.id != null && /^\d+$/.test(String(e.id))) out.add(Number(e.id));
    } catch {
      /* unparseable entry — skip (filename fallback not needed; batch succeeded) */
    }
  }
  return out;
}

// Ids added by currently-open PRs. Uses `gh` when available (the only way to
// see a fork-headed PR whose branch is NOT a refs/remotes/origin/* ref here).
//
// #2943 hardening — the original implementation fanned out 1 + N gh calls
// (`gh pr list` then `gh pr view --json files` per PR), which made EVERY open
// PR an independent, silently-swallowed failure point. Under gh rate-limit /
// API contention (many concurrent agents), a dropped call narrowed the id
// universe with NO signal: on 2026-07-02 an --allocate returned 2920 while
// open PR #2424 already added plan/issues/2920-*.md (same pattern hit 2921 /
// PR #2425; downstream, one analysis file burned the 2921→2931→2937→2940
// re-id chain on parallel-session collisions). Now:
//   - ONE batched GraphQL query (100 PRs × 100 files per page, paginated)
//     replaces the fan-out — two orders of magnitude fewer API calls, one
//     failure point instead of N;
//   - a per-PR REST `--paginate` fallback covers the rare >100-file PR
//     (`gh pr view --json files` also silently truncates at 100 — a second
//     latent miss source in the old code);
//   - the whole scan retries 3× with backoff, and on total failure returns
//     `complete: false` so the caller can WARN LOUDLY instead of proceeding
//     silently. Still fail-open by design (offline/unauthenticated use keeps
//     working; the PR-time CI gate check-issue-ids --against-main is the hard
//     backstop) — but no longer fail-SILENT.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// (#2974/#2977) Exponential backoff + full jitter for the first-push-wins
// retry loops (allocate / claim). Losers previously retried IMMEDIATELY and
// re-collided, so N concurrent allocators degenerated into a livelock (six
// observed re-scanning hundreds of ref entries in lock-step). Randomized
// backoff turns the synchronized herd into a de-facto queue: retry at a random
// point in [0, base·2^(attempt-1)], capped, so contenders spread out in time
// and one makes progress each round. Bounded by MAX_RETRIES either way.
function raceBackoffMs(attempt) {
  const BASE_MS = 150;
  const CAP_MS = 4000;
  const ceil = Math.min(CAP_MS, BASE_MS * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceil);
}

const PR_FILES_QUERY = `query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{number files(first:100){pageInfo{hasNextPage} nodes{path}}}
    }
  }
}`;

function idsFromOpenPRs() {
  const repo = process.env.CLAIM_PR_REPO || "loopdive/js2";
  const [owner, name] = repo.split("/");
  // Overall wall-clock budget for the whole scan (all attempts + pagination).
  // Past this the scan bails to the fail-open fallback rather than hanging.
  const deadline = Date.now() + PR_SCAN_TOTAL_TIMEOUT_MS;
  // A single gh invocation, capped at min(per-call limit, remaining budget).
  // On budget exhaustion it throws a tagged error so the loop bails cleanly;
  // on a per-call timeout `execFileSync` throws ETIMEDOUT (process SIGKILLed),
  // which the retry/backoff path below handles like any transient gh failure.
  const ghBounded = (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const e = new Error("open-PR scan budget exhausted");
      e.scanBudgetExhausted = true;
      throw e;
    }
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: Math.min(PR_SCAN_CALL_TIMEOUT_MS, remaining),
      killSignal: "SIGKILL",
    });
  };
  let budgetExhausted = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (Date.now() >= deadline) {
      budgetExhausted = true;
      break;
    }
    try {
      const ids = new Set();
      const bigPRs = [];
      let cursor = null;
      for (;;) {
        const args = ["api", "graphql", "-f", `query=${PR_FILES_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
        if (cursor) args.push("-F", `cursor=${cursor}`);
        const raw = ghBounded(args);
        const prs = JSON.parse(raw)?.data?.repository?.pullRequests;
        if (!prs) throw new Error("unexpected GraphQL shape");
        for (const pr of prs.nodes || []) {
          for (const f of pr.files?.nodes || []) {
            const m = (f.path || "").match(ISSUE_ID_RE);
            if (m) ids.add(Number(m[1]));
          }
          if (pr.files?.pageInfo?.hasNextPage) bigPRs.push(pr.number);
        }
        if (!prs.pageInfo?.hasNextPage) break;
        cursor = prs.pageInfo.endCursor;
      }
      // >100-file PRs: fetch the full file list via REST pagination.
      for (const n of bigPRs) {
        const raw = ghBounded(["api", `repos/${repo}/pulls/${n}/files`, "--paginate", "--jq", ".[].filename"]);
        for (const p of raw.split("\n")) {
          const m = p.match(ISSUE_ID_RE);
          if (m) ids.add(Number(m[1]));
        }
      }
      return { ids, complete: true };
    } catch (e) {
      if (e && e.scanBudgetExhausted) {
        budgetExhausted = true;
        break;
      }
      // Per-call timeout (ETIMEDOUT/SIGKILL) or transient API error: back off
      // and retry, but never sleep past the overall deadline.
      const backoff = Math.min(attempt * 1000, Math.max(0, deadline - Date.now()));
      if (attempt < 3 && backoff > 0) sleepMs(backoff);
    }
  }
  console.error(
    `warning: open-PR id scan ${budgetExhausted ? `timed out (>${PR_SCAN_TOTAL_TIMEOUT_MS}ms)` : "FAILED after 3 attempts"} ` +
      "(gh offline/unauthenticated/rate-limited/slow). Allocating against main ∪ reservations ONLY — the id may " +
      "collide with an in-flight PR's issue file (#2943). The CI gate check-issue-ids --against-main remains the hard backstop.",
  );
  return { ids: new Set(), complete: false };
}

function allUsedIds(sha, { scanPRs }) {
  const all = new Set([...idsFromMain(), ...idsFromAssignRef(sha)]);
  let prScanComplete = true;
  if (scanPRs) {
    const pr = idsFromOpenPRs();
    for (const id of pr.ids) all.add(id);
    prScanComplete = pr.complete;
  }
  return { ids: all, prScanComplete };
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

    const { ids: used, prScanComplete } = allUsedIds(sha, { scanPRs });
    // contiguousMax+1 is always strictly above the contiguous body, so it can
    // never alias an in-use id (strays sit > STRAY_GAP above max, never at +1).
    const id = String(contiguousMax(used) + 1);
    // #2943: degraded-scan marker — idsFromOpenPRs already warned on stderr;
    // also carried in the --json output so tooling can react.
    const degraded = scanPRs && !prScanComplete;

    // --dry-run: preview the candidate without reserving (no push). Useful to
    // see "what id would I get" without burning a reservation. NOT collision-
    // safe on its own — only the real reserve+push is atomic.
    if (flags.has("--dry-run")) {
      if (wantJson)
        process.stdout.write(JSON.stringify({ id: Number(id), dryRun: true, prScanDegraded: degraded }) + "\n");
      else {
        console.error(
          `(dry-run) next free id would be #${id} (scanned ${used.size} used ids; PR-scan ${scanPRs ? (degraded ? "DEGRADED" : "on") : "off"})`,
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
          JSON.stringify({
            id: Number(id),
            assignee: assignee || null,
            branch: entry.branch || null,
            prScanDegraded: degraded,
          }) + "\n",
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
    // (#2974/#2977) Backoff+jitter before re-scanning so concurrent allocators
    // don't re-collide in lock-step. Skip the wait after the final attempt.
    if (attempt < MAX_RETRIES) sleepMs(raceBackoffMs(attempt));
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

  // --dry-run: preview WITHOUT mutating the ref (no commit, no push). This MUST
  // short-circuit BEFORE the retry/push loop below, regardless of where the flag
  // appears in argv — `flags` is a position-independent Set built from every
  // `--`-prefixed arg, so `claim-issue.mjs <id> <name> --dry-run` and
  // `claim-issue.mjs --dry-run <id> <name>` both land here. Previously only
  // --allocate honored --dry-run; a claim/release/complete probe with --dry-run
  // silently performed a REAL mutation (agents accidentally claimed live issues
  // twice this way).
  if (flags.has("--dry-run")) {
    const sha = remoteAssignSha();
    fetchAssign(sha);
    const existing = readEntry(sha, key);
    const held = isHeld(existing);
    console.error(
      `(dry-run) would ${kind} ${label}${assignee ? ` -> ${assignee}` : ""}${branch ? ` (branch ${branch})` : ""}. ` +
        (held
          ? `Currently held by ${existing.assignee} (since ${existing.claimed_at || "?"}).`
          : "Currently unassigned.") +
        ` No push performed; ${REMOTE}/${ASSIGN_REF} untouched.`,
    );
    return;
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
    // (#2974/#2977) Backoff+jitter before re-checking so concurrent claimants
    // don't re-collide in lock-step. Skip the wait after the final attempt.
    if (attempt < MAX_RETRIES) sleepMs(raceBackoffMs(attempt));
  }
  die(5, `Could not acquire the claim ref after ${MAX_RETRIES} attempts. Try again.`);
}

// --- dispatch ---------------------------------------------------------------
if (mode === "list") {
  doList();
} else if (mode === "debug-pr-scan") {
  // #2943: expose the open-PR id scan for tests/diagnosis. Prints
  // {ids:[...],complete:bool} as JSON. Exit 0 even on a degraded scan —
  // `complete` carries the signal.
  const r = idsFromOpenPRs();
  process.stdout.write(JSON.stringify({ ids: [...r.ids].sort((a, b) => a - b), complete: r.complete }) + "\n");
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
