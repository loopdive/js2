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
// ============================================================================
// #3880 — RELIABILITY AT EVERY ENTRY POINT
// ============================================================================
// This tool was unreliable in BOTH directions, which is worse than being slow:
// a failed operation could report success, and a successful one could report
// failure. All four mechanisms below were reproduced on 2026-07-31.
//
// (1) FAILED READ LOOKED LIKE "UNCLAIMED". `remoteAssignSha()` returned "" both
//     when the ref did not exist AND when `git ls-remote` failed, and every
//     reader treated "" as "no claims". So `--release <held>` printed
//     "not currently claimed — nothing to release" and exited 0 while the lock
//     stayed (this is how #3661/#3685 were left falsely claimed), and `--check`
//     printed "is UNASSIGNED" and exited 0 — the stale read that lets TWO
//     agents start the same issue, i.e. exactly the duplicate dispatch the lock
//     exists to prevent. Reads are now TRI-STATE (present / absent / failed);
//     a failed read is a hard, non-zero, legible error. An unreadable ref is
//     NOT an empty one.
//
// (2) THE SHARED-REF LOCK RACE, AND WHY IT IS NOT A RETRY PROBLEM. Fetching
//     `+issue-assignments:refs/claim-issue/base` in the MAIN repo also fires an
//     OPPORTUNISTIC update of `refs/remotes/<remote>/issue-assignments` (via the
//     configured `remote.<r>.fetch` refmap). Concurrent agents collide on it:
//       error: cannot lock ref 'refs/remotes/origin/issue-assignments':
//              is at 6696004… but expected 63b1549…
//     git then exits 1 — even though the REQUESTED refspec landed correctly
//     (verified: the destination ref was created at the new tip). The old code
//     called this through a throwing helper, so a fetch that actually WORKED
//     crashed the whole script.
//     All assignment-ref plumbing now runs in a dedicated bare CACHE REPO
//     (`<git-common-dir>/claim-issue-cache.git`) addressed BY URL. A URL has no
//     configured refmap, so the opportunistic update cannot happen and the race
//     is structurally impossible; each invocation additionally fetches into its
//     OWN ref, so two processes never contend on one mirror.
//
// (3) THE 10-MINUTE WEDGE WAS THE FETCH, AMPLIFIED BY THE RETRY LOOP — NOT a
//     missing retry. GIT_TRACE2 decomposition of ONE fetch in the main repo:
//     remote refs 0.6s, then `git rev-list --objects --stdin --not --all` 47.8s
//     (a connectivity check that walks all 6,680 local refs), 120s total at
//     6-7% CPU — waiting, not computing. Repeat measurements: 210s / 127s /
//     120s / 65s. With MAX_RETRIES=6 and a fresh fetch per attempt that is
//     390-1260s, which is precisely the reported ">560s", "600s timeout" and
//     "10 minutes at 0:00 CPU". The dedicated cache repo has almost no refs and
//     a tiny history, so the SAME fetch costs 1.18s cold / 0.50s warm (1.2 MB
//     on disk). Making the call fast is the fix; adding retries around a
//     two-minute call is what produced the symptom.
//
// (4) THE PUSH'S EXIT STATUS IS NOT EVIDENCE. A push can land server-side and
//     still report failure (or time out) — two ids were permanently burned on
//     2026-07-31 by re-allocating after an "apparent" failure whose reservation
//     had in fact been written. Every write is therefore VERIFIED BY EFFECT:
//     after the push, regardless of its exit code, the ref is re-read and the
//     entry compared byte-for-byte against what we intended to write. If the
//     effect cannot be established, the tool says UNKNOWN (exit 7) rather than
//     guessing in either direction.
//
// Two supporting changes fall out of the same principle:
//   - git's stderr is CAPTURED and surfaced instead of being routed to
//     /dev/null (the old `quietErr` path), which is why failing runs were
//     reported as producing "no output at all".
//   - the LAST line of output on any non-success is an unmistakable
//     `claim-issue: FAILED — …` / `claim-issue: REFUSED — …` marker, so the
//     failure survives a caller's `2>&1 | tail -4` (a pipe reports `tail`'s
//     status, not the script's — that trap made two failed operations look
//     clean in one session). stdout stays clean so `NEW=$(… --allocate)` keeps
//     working.
//
// Exit codes: 0 ok / free
//             2 usage error
//             3 already claimed by someone else (a legitimate refusal)
//             4 issue already done/wont-fix on main (a legitimate refusal)
//             5 gave up after retries under contention (nothing was written)
//             6 infrastructure failure — the ref could not be read or written
//               (NOTHING was written; safe to re-run)
//             7 UNKNOWN — the write may or may not have landed and could not be
//               verified. Do NOT retry blindly: re-read the record first
//               (`--check <id>` / `--list`).
// (--allocate prints the reserved id to stdout on success and exits 0.)

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve, dirname } from "node:path";
import { openPrIssueIds, ISSUE_ID_RE } from "./lib/open-pr-issue-files.mjs";
import { isHeldRecord, TERMINAL_CLAIM_STATUSES } from "./lib/claim-record.mjs";

const ASSIGN_REF = "issue-assignments";
// (#4045/#4117) ONE BOOK, AND IT IS UPSTREAM'S.
//
// This used to be `process.env.CLAIM_ASSIGN_REMOTE || "origin"`, under a comment
// asserting the ref "lives on the FORK (origin)". In agent worktrees `origin` IS
// the fork, while CI's collision gate, the Codex lane and every upstream-rooted
// checkout read UPSTREAM's ref. So the repo kept TWO disjoint reservation books
// and the "atomic reservation" of #2531 was atomic against whichever one the
// caller happened to be standing in.
//
// Measured cost of that (both incidents in the issue files):
//   * 2026-07-28  #3715 reserved 3750/3751/3752 on the fork book; #3723 took
//     3750/3751 via upstream and MERGED. #3715 renumbered twice.
//   * 2026-08-02  the codex lane claimed 4113 on upstream's book at 21:10:58Z;
//     `--allocate` handed 4113 to a second lane at 21:35:13Z and wrote it to the
//     fork's book, exit 0, `pr_scan: "ok"`. Caught only by the #3598 CI gate.
//
// The picker mirrors `pickMainRemote()` below, which has resolved `main` to
// upstream since #2177 for the *identical* reason — the assignments ref simply
// never got the same treatment. `CLAIM_ASSIGN_REMOTE` still overrides (that is
// what lets the tests point at a local bare repo, and it is the documented
// workaround people already have in their shell history).
//
// Defined here for narrative, RESOLVED further down next to `resolveRemoteUrl`
// — it calls `git()`, so it must not run before this module's consts exist.

// --- bounded network timeouts (#3079, tightened #3880) ----------------------
// `execFileSync` has no default timeout, so a single stuck `git` call under
// contention previously blocked the caller indefinitely (600 s timeouts were
// observed). EVERY network call is now capped and SIGKILLed. Because the cache
// repo makes each call ~1 s, a generous cap costs nothing in the happy path.
const NET_TIMEOUT_MS = Number(process.env.CLAIM_NET_TIMEOUT_MS) || 60000;
const NET_RETRIES = Number(process.env.CLAIM_NET_RETRIES) || 3;
const MAIN_FETCH_TIMEOUT_MS = Number(process.env.CLAIM_MAIN_FETCH_TIMEOUT_MS) || 90000;
// Contention budget for the first-push-wins loop. This is NOT a network-retry
// budget (that is NET_RETRIES) — it is how many times we are willing to lose a
// race and re-scan.
//
// (#3880) Raised from 6 now that an attempt costs ~1 s instead of 65-210 s. The
// failure was STARVATION, not a hang: with ~8 agents writing one orphan ref,
// a slow writer loses every round because another writer advances the ref
// between its fetch and its push, and its whole budget is consumed by other
// agents' successes. Shrinking the fetch→push window by two orders of magnitude
// is the main cure — it is what makes the optimistic loop converge at all — but
// it does not make the loop FAIR, so the budget is widened too. Worst case is
// now ~12 × (1 s + ≤4 s jittered backoff) ≈ 30-60 s, against 390-1260 s before.
const MAX_RETRIES = Number(process.env.CLAIM_MAX_RETRIES) || 12;

// Overall wall-clock deadline for the contention loop (#3880).
//
// An attempt-count bound alone does NOT bound wall time, and this issue's own
// acceptance criterion is "fail fast with a non-zero exit". Each attempt can
// internally spend NET_RETRIES × NET_TIMEOUT_MS on ls-remote, again on fetch,
// again on the push and again on verification — so on a degraded network 12
// attempts is minutes-per-attempt, not seconds. The deadline is what actually
// makes the promise true; MAX_RETRIES only caps how many times we lose a race.
const DEADLINE_MS = Number(process.env.CLAIM_DEADLINE_MS) || 120000;
const STARTED_AT = Date.now();
function deadlineExceeded() {
  return Date.now() - STARTED_AT > DEADLINE_MS;
}

// TEST SEAM (#3880), test-only, no production caller. The two outcomes this
// issue is about — a push that LANDS while git reports failure, and a write
// whose effect cannot be established at all — cannot be provoked honestly from
// outside the process, and a guard nobody has watched fail is not a guard.
//   push-reports-failure : perform the push for real, then report it as failed
//                          (exercises verify-by-effect recovering the truth)
//   verify-unreachable   : push for real, then make verification impossible
//                          (exercises the UNKNOWN / exit-7 path)
const TEST_FAULT = process.env.CLAIM_TEST_FAULT || "";

// --- failure legibility (#3880) ---------------------------------------------
// The LAST line of output must say, unmistakably, whether this run succeeded.
// Callers pipe us (`… 2>&1 | tail -4`), and a pipe reports the LAST STAGE's
// exit status — so the exit code alone is not enough to be legible.
let markerEmitted = false;
function emitMarker(kind, reason, code) {
  if (markerEmitted) return;
  markerEmitted = true;
  process.stderr.write(`claim-issue: ${kind} — ${reason} (exit ${code})\n`);
}
function firstLine(s) {
  return String(s).split("\n")[0].trim();
}
function ok(reason) {
  emitMarker("OK", reason, 0);
}
/**
 * Legitimate, expected refusals (exit 3/4): the tool worked, the answer is no.
 * `quiet` skips re-printing the body when the caller already reported it on
 * stdout, so the marker is the only extra line.
 */
function refuse(code, msg, quiet = false) {
  if (!quiet) console.error(msg);
  emitMarker("REFUSED", firstLine(msg), code);
  process.exit(code);
}
/** The tool could not do its job (exit 2/5/6/7). */
function die(code, msg) {
  console.error(msg);
  emitMarker("FAILED", firstLine(msg), code);
  process.exit(code);
}
process.on("uncaughtException", (e) => {
  console.error(e && e.stack ? e.stack : String(e));
  emitMarker("FAILED", `uncaught ${firstLine((e && e.message) || e)}`, 6);
  process.exit(6);
});

// --- process helpers (stderr CAPTURED, never discarded — #3880) -------------
function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    });
    return { ok: true, out: (out || "").trim(), err: "" };
  } catch (e) {
    const timedOut = e.killed === true || e.signal === "SIGKILL" || e.code === "ETIMEDOUT";
    return {
      ok: false,
      out: (e.stdout || "").toString().trim(),
      err: (e.stderr || "").toString().trim() || (e.message ? String(e.message) : ""),
      timedOut,
      status: e.status,
    };
  }
}
// (#3880) Inherited git environment variables are a live hazard for this
// script, because it shells out to git constantly AND deliberately points
// GIT_INDEX_FILE at a scratch index for its commit-tree plumbing. If
// claim-issue is ever invoked from inside a git hook (husky exports GIT_DIR and
// GIT_INDEX_FILE), an inherited GIT_DIR would send every cache-repo command at
// the WRONG repository and an inherited GIT_INDEX_FILE would make `read-tree` /
// `update-index` clobber the invoking repo's real index. This was not
// theoretical: the same leak, via `git init --bare` in this issue's own test
// suite, wrote `core.bare=true` into the shared repo config and broke every
// worktree until it was reverted. Every git call therefore runs under a
// sanitised environment; callers that genuinely want one of these variables
// name it in `keepEnv`.
const LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
];
function cleanGitEnv(base, keep = []) {
  const env = { ...(base || process.env) };
  for (const k of LEAKY_GIT_ENV) if (!keep.includes(k)) delete env[k];
  return env;
}
function git(args, opts = {}) {
  const { keepEnv, ...rest } = opts;
  return run("git", args, { ...rest, env: cleanGitEnv(opts.env, keepEnv || []) });
}
function why(r) {
  return r.timedOut ? `timed out after ${opTimeout(r)}ms` : r.err || r.out || `git exited ${r.status}`;
}
function opTimeout() {
  return NET_TIMEOUT_MS;
}

// --- the dedicated assignment CACHE REPO (#3880) ----------------------------
// A bare repo holding ONLY the orphan assignment branch. Every assignment-ref
// operation (ls-remote / fetch / read / commit / push) happens here rather than
// in the working repo. Two properties matter, and both are load-bearing:
//   * it is addressed BY URL, so there is no configured `remote.<r>.fetch`
//     refmap and therefore no opportunistic `refs/remotes/*` update to race on;
//   * it holds a handful of refs instead of thousands, so git's connectivity
//     check (`rev-list --not --all`) is trivial: 1.18 s cold / 0.50 s warm,
//     against 65-210 s for the same fetch in the working repo.
// Shared across worktrees on purpose (it lives in the common git dir) so the
// whole fleet reuses one warm cache; concurrency is handled by giving every
// invocation its own private refs rather than by locking.
function gitCommonDir() {
  const r = git(["rev-parse", "--git-common-dir"]);
  return r.ok && r.out ? resolve(r.out) : "";
}
const CACHE_DIR =
  process.env.CLAIM_CACHE_DIR ||
  (() => {
    const common = gitCommonDir();
    return common ? join(common, "claim-issue-cache.git") : join(tmpdir(), "js2-claim-issue-cache.git");
  })();

let cacheReady = false;
function cacheUsable() {
  return existsSync(join(CACHE_DIR, "HEAD")) && git(["-C", CACHE_DIR, "rev-parse", "--git-dir"]).ok;
}
// Build the cache in a PRIVATE directory and move it into place with a single
// atomic rename. Creating it in situ is not safe: the whole point of this repo
// is that N agents use it at once, and an in-place `rm -rf` + `git init` lets
// one process delete the directory another is mid-initialising ("unable to
// write symref for HEAD" — caught by the six-way concurrency test). rename(2)
// onto an existing non-empty directory fails, so whoever loses the race simply
// adopts the winner's cache.
function buildCache(evictBroken) {
  const parent = dirname(CACHE_DIR);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".claim-cache-"));
  try {
    const bare = join(staging, "repo.git");
    const init = git(["init", "--bare", "--quiet", bare]);
    if (!init.ok) return;
    // Never let a background gc contend with a concurrent claim; the cache is
    // ~1 MB and is pruned by rebuild, not by maintenance.
    git(["-C", bare, "config", "gc.auto", "0"]);
    // A half-written or corrupt cache is disposable — it carries no state that
    // is not re-fetchable from the remote — but only evict one on the second
    // pass, once a plain rename has already lost.
    if (evictBroken && existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
    try {
      renameSync(bare, CACHE_DIR);
    } catch {
      /* lost the race to a concurrent claim, or a squatter is in the way */
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
function ensureCache() {
  if (cacheReady) return;
  if (!cacheUsable()) buildCache(false);
  if (!cacheUsable()) buildCache(true);
  if (!cacheUsable()) die(6, `could not initialise the claim cache repo at ${CACHE_DIR}`);
  cacheReady = true;
}
function cgit(args, opts = {}) {
  ensureCache();
  return git(["-C", CACHE_DIR, ...args], opts);
}
function cgitOrDie(args, what, opts = {}) {
  const r = cgit(args, opts);
  if (!r.ok) die(6, `${what} failed: ${why(r)}`);
  return r.out;
}

// Resolve a remote NAME to a URL (the cache repo has no remotes configured).
// A value that already looks like a URL or a filesystem path is used verbatim,
// which is what lets tests point CLAIM_ASSIGN_REMOTE at a local bare repo.
function isUrlish(remote) {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) ||
    remote.startsWith("git@") ||
    remote.startsWith("/") ||
    remote.startsWith(".")
  );
}
function resolveRemoteUrl(remote, forPush) {
  if (isUrlish(remote)) {
    return remote;
  }
  const r = git(["remote", "get-url", ...(forPush ? ["--push"] : []), remote]);
  if (r.ok && r.out) return r.out.split("\n")[0].trim();
  return remote;
}
// (#4045/#4117) Resolve the authoritative assignment remote — see the block
// next to ASSIGN_REF for why this is upstream and what it cost when it was not.
function pickAssignRemote() {
  if (process.env.CLAIM_ASSIGN_REMOTE) return process.env.CLAIM_ASSIGN_REMOTE;
  const r = git(["remote"]);
  const remotes = r.ok ? r.out.split(/\s+/).filter(Boolean) : [];
  return remotes.includes("upstream") ? "upstream" : "origin";
}
const REMOTE = pickAssignRemote();
const ASSIGN_FETCH_URL = resolveRemoteUrl(REMOTE, false);
const ASSIGN_PUSH_URL = resolveRemoteUrl(REMOTE, true);

// --- LEGACY books (migration, #4045/#4117) ----------------------------------
//
// Flipping the default to upstream does not move the records already written to
// the fork's book — on 2026-08-02 that book held live reservations (4113, 4116,
// 4117) that upstream's did not. Orphaning them would re-create the very
// collision this fixes, from the other side: `--allocate` would hand out an id
// a fork-rooted lane still believes it holds.
//
// So every read is the UNION of the authoritative book and any legacy book, and
// every write goes ONLY to the authoritative one. Records therefore migrate
// forward naturally (the next write about an id lands upstream) and the legacy
// book drains rather than being cut off. On a conflicting key the authoritative
// book WINS — the same tie-break the #3598 collision gate applies, so the two
// arbiters can never disagree.
//
// Read-only, and never a substitute: if the authoritative book is unreachable
// the tool REFUSES (see tipShaOrDie). Falling back to the legacy book on an
// upstream outage would silently restore the split brain at the worst moment.
//
// `CLAIM_ASSIGN_LEGACY_REMOTES` overrides the candidate list; set it to the
// empty string to turn the union off once the legacy book is drained.
function pickLegacyAssignBooks() {
  const raw = process.env.CLAIM_ASSIGN_LEGACY_REMOTES;
  if (raw === "") return [];
  // An explicit CLAIM_ASSIGN_REMOTE means the caller has NAMED the book — a
  // hermetic test pointing at a local bare repo, or someone deliberately
  // targeting one ledger. Do not then go hunting for implicit legacy books:
  // the override is total, and legacy books must be named explicitly too.
  if (!raw && process.env.CLAIM_ASSIGN_REMOTE) return [];
  const names = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : ["origin", "fork"];
  const seen = new Set([ASSIGN_FETCH_URL]);
  const books = [];
  for (const name of names) {
    if (name === REMOTE) continue;
    const url = resolveRemoteUrl(name, false);
    // `resolveRemoteUrl` echoes its input in TWO different cases, and they must
    // not be conflated: the input already IS a URL/path (keep it — that is how
    // the tests point at a local bare repo), or a bare remote NAME did not
    // resolve because no such remote exists (drop it). Testing `url === name`
    // alone silently dropped every explicitly-passed path, which made the
    // unreadable-book refusal untestable and, worse, unreachable in exactly the
    // configuration an operator would use to point at a specific book.
    if (!url) continue;
    if (url === name && !isUrlish(name)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    books.push({ name, url });
  }
  return books;
}
const LEGACY_BOOKS = pickLegacyAssignBooks();

// Private per-invocation refs inside the cache repo. Two concurrent processes
// therefore never update the same ref — the mirror-ref lock race of #3880
// cannot occur by construction. Cleaned up on exit.
const UNIQ = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const READ_REF = `refs/claim-work/${UNIQ}`;
const VERIFY_REF = `refs/claim-verify/${UNIQ}`;
const tempRefs = new Set();
process.on("exit", () => {
  for (const ref of tempRefs) git(["-C", CACHE_DIR, "update-ref", "-d", ref]);
});

// The MAIN id scan must use UPSTREAM (loopdive/js2wasm). The fork's `origin/main`
// lags upstream by thousands of commits, so "next free off origin/main" returns
// ids already taken on upstream/main — every such allocation then collides at
// the required `check:issue-ids:against-main` gate (which checks upstream/main),
// ejecting PRs from the merge queue (this is what mis-numbered two issues into
// the 6000s, since renumbered to #2177/#2194).
// Prefer the `upstream` remote when it exists; `CLAIM_REMOTE` overrides.
function pickMainRemote() {
  if (process.env.CLAIM_REMOTE) return process.env.CLAIM_REMOTE;
  const r = git(["remote"]);
  const remotes = r.ok ? r.out.split(/\s+/).filter(Boolean) : [];
  return remotes.includes("upstream") ? "upstream" : "origin";
}
const MAIN_REMOTE = pickMainRemote();
const MAIN_REF = `${MAIN_REMOTE}/main`;

// Best-effort refresh of the main tip before an allocation.
//
// (#3880) The old form was `git fetch --quiet <remote> main` under a 15 s
// SIGKILL. In this repo the fetch's connectivity check alone costs ~48 s, so
// that budget NEVER completed — `<remote>/main` silently stayed stale and the
// id scan ran against an out-of-date tree (a recently-merged issue file is on
// neither a stale main NOR an open PR, so its id looks free). Three changes:
// an EXPLICIT refspec so the remote-tracking ref is actually updated, an empty
// `--refmap=` so no opportunistic ref update can lose the lock race, and a
// budget that can finish. If it still cannot, we say so LOUDLY rather than
// pretending the scan was clean.
function refreshMainTip() {
  const url = resolveRemoteUrl(MAIN_REMOTE, false);
  const r = git(
    [
      "fetch",
      "--refmap=",
      "--no-tags",
      "--no-write-fetch-head",
      "--quiet",
      MAIN_REMOTE,
      `+refs/heads/main:refs/remotes/${MAIN_REMOTE}/main`,
    ],
    { timeout: MAIN_FETCH_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
  if (r.ok) return { fresh: true };
  // The refresh failed. Is the local tip actually stale? `ls-remote` is cheap
  // (sub-second) even where a fetch is not, so we can answer precisely instead
  // of guessing.
  const local = git(["rev-parse", MAIN_REF]);
  const remote = git(["ls-remote", url, "refs/heads/main"], { timeout: NET_TIMEOUT_MS, killSignal: "SIGKILL" });
  const remoteSha = remote.ok ? (remote.out.split("\t")[0] || "").trim() : "";
  if (local.ok && remoteSha && local.out === remoteSha) return { fresh: true };
  console.error(
    `warning: could not refresh ${MAIN_REF} (${why(r)}). The id scan is running against a STALE main` +
      `${local.ok && remoteSha ? ` (local ${local.out.slice(0, 12)} vs remote ${remoteSha.slice(0, 12)})` : ""}; ` +
      "an id whose issue file merged very recently may look free (#3880).",
  );
  return { fresh: false };
}

// --- argument parsing -------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const VALUE_FLAGS = new Set(["--branch", "--by"]);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || "" : "";
}
const branch = flagValue("--branch");
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1]));

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

// (#3880) Every record must name WHO asked for it. Bare `--allocate` wrote
// `assignee: ""`, so the ref could not attribute ownership at all — "no claim
// file" then became unreliable in both directions (one issue had three merged
// PRs and no claim; another had a claim nobody held). `requested_by` is never
// empty: explicit `--by`/assignee, else $CLAIM_ASSIGNEE, else the git identity,
// else a traceable host:pid so even an anonymous run is followable.
// Deliberately NOT a hard requirement: CLAUDE.md documents bare
// `NEW=$(node scripts/claim-issue.mjs --allocate)`, which must keep working.
function requesterId(assignee) {
  const explicit = assignee || flagValue("--by") || process.env.CLAIM_ASSIGNEE || "";
  if (explicit) return normalizeAssignee(explicit);
  const email = git(["config", "--get", "user.email"]);
  if (email.ok && email.out) return email.out;
  return `unattributed:${hostname()}:${process.pid}`;
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

// --- remote ref plumbing (TRI-STATE reads — #3880) --------------------------
//
// The single most dangerous bug this script had: a FAILED read was
// indistinguishable from an EMPTY one, so a network blip read as "nobody holds
// this issue". Reads therefore return one of three states and callers must
// handle `failed` explicitly — never by falling through to "unassigned".
// `url` defaults to the AUTHORITATIVE book; the legacy-book reads below pass
// their own. Everything else about the tri-state contract is unchanged.
function remoteAssignState(url = ASSIGN_FETCH_URL) {
  let last = "";
  for (let attempt = 1; attempt <= NET_RETRIES; attempt++) {
    const r = cgit(["ls-remote", url, `refs/heads/${ASSIGN_REF}`], {
      timeout: NET_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (r.ok) {
      const line = r.out.split("\n").find((l) => l.trim());
      if (!line) return { state: "absent", sha: "" };
      return { state: "present", sha: line.split("\t")[0].trim() };
    }
    last = why(r);
    if (attempt < NET_RETRIES) sleepMs(raceBackoffMs(attempt));
  }
  return { state: "failed", err: last };
}

// Fetch the assignment branch into one of THIS invocation's private refs.
function fetchAssignInto(ref, url = ASSIGN_FETCH_URL) {
  let last = "";
  for (let attempt = 1; attempt <= NET_RETRIES; attempt++) {
    const r = cgit(
      ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, `+refs/heads/${ASSIGN_REF}:${ref}`],
      {
        timeout: NET_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    if (r.ok) {
      tempRefs.add(ref);
      return { ok: true };
    }
    last = why(r);
    if (attempt < NET_RETRIES) sleepMs(raceBackoffMs(attempt));
  }
  return { ok: false, err: last };
}

// Read the current assignment tip into READ_REF and return its sha.
// The sha comes from the FETCH, not from ls-remote, so the object is always
// present locally (ls-remote's answer can be one push out of date by the time
// we fetch, and reading a sha we never fetched would fail spuriously).
function readTip() {
  const st = remoteAssignState();
  if (st.state !== "present") return st;
  const f = fetchAssignInto(READ_REF);
  if (!f.ok) return { state: "failed", err: f.err };
  const rp = cgit(["rev-parse", READ_REF]);
  if (!rp.ok) return { state: "failed", err: why(rp) };
  return { state: "present", sha: rp.out };
}

/** Tip sha, or "" when the ref genuinely does not exist. Dies on a failed read. */
function tipShaOrDie(what) {
  const st = readTip();
  if (st.state === "failed") {
    die(
      6,
      `cannot READ the assignment ref (${REMOTE}/${ASSIGN_REF}): ${st.err}\n` +
        `Refusing to ${what} — an unreadable ref is NOT an empty one. Reporting "unassigned" here is how ` +
        `#3661/#3685 were left falsely claimed and how two agents can be dispatched onto one issue (#3880).`,
    );
  }
  return st.sha;
}

function readEntry(baseSha, id) {
  if (!baseSha) return null;
  const r = cgit(["cat-file", "-p", `${baseSha}:${id}.json`]);
  if (!r.ok || !r.out) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

// --- legacy-book reads (#4045/#4117) ----------------------------------------
//
// Resolved ONCE per invocation and memoised: every legacy book costs an
// ls-remote plus a fetch, and `--allocate` reads the union on every contention
// retry. `state` is the same tri-state as the authoritative read, and a `failed`
// one is carried forward rather than smoothed away — see legacyReadDegraded().
let _legacyTips = null;
function legacyTips() {
  if (_legacyTips) return _legacyTips;
  _legacyTips = LEGACY_BOOKS.map((book, i) => {
    const st = remoteAssignState(book.url);
    if (st.state !== "present") return { ...book, state: st.state, sha: "", err: st.err || "" };
    const ref = `refs/claim-legacy/${UNIQ}-${i}`;
    const f = fetchAssignInto(ref, book.url);
    if (!f.ok) return { ...book, state: "failed", sha: "", err: f.err };
    const rp = cgit(["rev-parse", ref]);
    if (!rp.ok) return { ...book, state: "failed", sha: "", err: why(rp) };
    return { ...book, state: "present", sha: rp.out, err: "" };
  });
  return _legacyTips;
}

/**
 * The legacy books we could NOT read. Non-empty means the id universe is
 * incomplete — an id reserved only on an unreadable legacy book would be handed
 * out again. Callers that are about to WRITE must refuse (see
 * guardScanCoverage); callers that only report must say so.
 */
function legacyReadDegraded() {
  return legacyTips().filter((t) => t.state === "failed");
}

/**
 * Read `<key>.json` from the authoritative book, falling back to the legacy
 * books IN ORDER. Returns the record plus WHICH book answered, because a claim
 * assertion that does not name its ref is exactly the unusable evidence #4045
 * measured (`--check 4076` answered UNASSIGNED and CLAIMED at the same instant,
 * both exit 0, from two books).
 *
 * The authoritative book wins on a conflicting key — same tie-break as the
 * #3598 gate — but a conflict is REPORTED (`shadowed`) rather than hidden: two
 * books disagreeing about one id is the symptom that this whole change exists
 * to remove, so it must be visible while the legacy book drains.
 */
function readEntryAnyBook(primarySha, key) {
  const primary = readEntry(primarySha, key);
  const shadowed = [];
  for (const tip of legacyTips()) {
    if (tip.state !== "present") continue;
    const e = readEntry(tip.sha, key);
    if (!e) continue;
    if (primary) {
      shadowed.push({ book: `${tip.name}/${ASSIGN_REF}`, entry: e });
    } else {
      return { entry: e, book: `${tip.name}/${ASSIGN_REF}`, legacy: true, shadowed };
    }
  }
  return { entry: primary, book: `${REMOTE}/${ASSIGN_REF}`, legacy: false, shadowed };
}

// (#3880) Heldness lives in scripts/lib/claim-record.mjs — ONE definition,
// shared with scripts/pre-dispatch-gate.mjs, which had its own (also wrong) copy.
// See that file for the measurement and for why it is a terminal-state blacklist
// rather than an `in-progress` whitelist.
const isHeld = isHeldRecord;

// Find the issue file on main and read its `status:` frontmatter (best effort).
// NOTE: main-tree queries run in the WORKING repo (they need main's trees), not
// in the assignment cache repo.
function mainIssueStatus(id) {
  const ls = git(["ls-tree", "-r", "--name-only", MAIN_REF, "plan/issues/"]);
  if (!ls.ok) return null;
  const re = new RegExp(`^plan/issues/${id}-[^/]+\\.md$`);
  const file = ls.out.split("\n").find((f) => re.test(f));
  if (!file) return null;
  const cat = git(["cat-file", "-p", `${MAIN_REF}:${file}`]);
  if (!cat.ok) return null;
  const m = cat.out.match(/^status:\s*([\w-]+)\s*$/m);
  return { file, status: m ? m[1] : null };
}

// --- id-universe scanning (for --allocate) ----------------------------------
//
// A fresh issue id must be unique against THREE populations, because none of
// them alone closes the collision window:
//   (1) ids already on main                  — the committed record;
//   (2) ids added by every currently-open PR — in-flight files not yet merged
//       (THE race the merge-queue wedge came from);
//   (3) ids already reserved on this ref     — concurrent allocators that won
//       a push microseconds ago.
// `allUsedIds()` unions all three; the next id is max(union)+1 (monotonic — we
// never reuse a gap that might be reserved on a branch this scan can't see).

// ISSUE_ID_RE is imported from scripts/lib/open-pr-issue-files.mjs (#3598) so
// the main-tree scan here and the open-PR scans (allocator + CI gate) agree on
// what an issue file IS — one regex, no drift.

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

// (#3880/#3636) A FAILED main scan must never read as an EMPTY one.
//
// This returned an empty Set when `ls-tree` failed, which is the most dangerous
// silent-empty in the whole allocator: with main contributing nothing,
// contiguousMax() is computed from open PRs ∪ reservations alone and hands out a
// drastically low, long-taken id — and nothing in the output says the scan
// failed. It is the same defect as the tri-state read fix above, on the other
// read path; fixing one and not the other is not fixing the property.
//
// Note the asymmetry that makes `die` correct rather than cautious: an
// unreadable main cannot be distinguished from a main with no issues, and
// guessing "no issues" is precisely the guess that collides.
function idsFromMain() {
  const out = new Set();
  const ls = git(["ls-tree", "-r", "--name-only", MAIN_REF, "plan/issues/"]);
  if (!ls.ok) {
    die(
      6,
      `cannot READ ${MAIN_REF} to scan existing issue ids: ${why(ls)}\n` +
        `Refusing to allocate: an unreadable main is NOT an empty one, and treating it as empty hands out an id ` +
        `that has been taken for thousands of commits. Fetch ${MAIN_REMOTE} and re-run.`,
    );
  }
  for (const f of ls.out.split("\n")) {
    const m = f.match(ISSUE_ID_RE);
    if (m) out.add(Number(m[1]));
  }
  // A successful read that finds NOTHING is also suspect — plan/issues/ has
  // thousands of files. Floor it rather than trusting `truncated`-style
  // metadata alone: an empty result from a valid-but-wrong ref looks identical
  // to a healthy read of an empty tree.
  if (out.size === 0) {
    die(
      6,
      `scanned ${MAIN_REF} for issue ids and found NONE — plan/issues/ is never empty.\n` +
        "Refusing to allocate against an id universe that is almost certainly a bad ref rather than the truth.",
    );
  }
  return out;
}

// Ids reserved/claimed on the orphan ref. Every `<key>.json` entry's `id`
// field counts — a `reserved` placeholder reserves the number just as firmly
// as an in-progress claim, otherwise two allocators racing the same second
// would both compute the same max+1.
// List the `<key>.json` entry filenames at a tip.
function entryFiles(sha) {
  if (!sha) return [];
  const ls = cgit(["ls-tree", "--name-only", sha]);
  if (!ls.ok) return [];
  return ls.out.split("\n").filter((f) => f.endsWith(".json"));
}

// (#3079) Read EVERY entry blob in a SINGLE `git cat-file --batch` process.
// Spawning one `git cat-file` PER entry is O(N) subprocesses — at 654 entries
// and growing that was the true cause of `--allocate` hanging, and it still
// made `--list` take 50 s until this was shared with it (#3880).
// Returns a Map<filename, parsedEntry|null>, or null if the batch read failed.
function readEntriesBatch(sha, files) {
  if (!sha || files.length === 0) return new Map();
  const request = files.map((f) => `${sha}:${f}`).join("\n") + "\n";
  let buf;
  try {
    // NOTE: omit `encoding` so execFileSync returns a Buffer — the `--batch`
    // stream is byte-framed (header declares each object's exact byte size), so
    // it must be walked as bytes. (`encoding: "buffer"` is NOT a valid option
    // value — it throws ERR_UNKNOWN_ENCODING; the default already yields a
    // Buffer.) `input` may still be a string.
    buf = execFileSync("git", ["-C", CACHE_DIR, "cat-file", "--batch"], {
      input: request,
      maxBuffer: 128 * 1024 * 1024,
      timeout: NET_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: cleanGitEnv(),
    });
  } catch {
    return null;
  }

  // Parse the `--batch` stream: "<oid> <type> <size>\n<content>\n" per object
  // ("<request> missing\n" — no body — for an absent one). Byte-framed, so walk
  // the buffer by the declared size rather than splitting on newlines. Records
  // come back in REQUEST order, including the missing ones, so zip by index.
  const out = new Map();
  const LF = 0x0a;
  let pos = 0;
  let i = 0;
  while (pos < buf.length && i < files.length) {
    const nl = buf.indexOf(LF, pos);
    if (nl === -1) break;
    const header = buf.toString("utf8", pos, nl);
    pos = nl + 1;
    const parts = header.split(" ");
    if (parts.length < 3 || parts[1] === "missing") {
      out.set(files[i++], null); // no content body
      continue;
    }
    const size = Number(parts[2]);
    if (!Number.isFinite(size) || size < 0) break;
    const content = buf.toString("utf8", pos, pos + size);
    pos += size + 1; // content + trailing LF
    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      /* unparseable entry — record as null */
    }
    out.set(files[i++], parsed);
  }
  return out;
}

// Ids reserved/claimed on the orphan ref. Every `<key>.json` entry's `id`
// field counts — a `reserved` placeholder reserves the number just as firmly
// as an in-progress claim, otherwise two allocators racing the same second
// would both compute the same max+1.
function idsFromAssignRef(sha) {
  const out = new Set();
  const files = entryFiles(sha);
  if (files.length === 0) return out;
  const entries = readEntriesBatch(sha, files);
  if (!entries) {
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
  for (const e of entries.values()) {
    if (e && e.id != null && /^\d+$/.test(String(e.id))) out.add(Number(e.id));
  }
  return out;
}

// (#4045/#4117) Ids reserved on a LEGACY book. Unioned into the id universe so
// the flip to upstream cannot hand out an id a fork-rooted lane still holds —
// which is the same collision, from the other direction. An unreadable legacy
// book contributes nothing here ON PURPOSE: silently guessing "empty" is the
// silent-empty this file already refuses everywhere else, so the gap is
// surfaced by legacyReadDegraded() and refused at the write, not papered over
// with a partial answer.
function idsFromLegacyBooks() {
  const out = new Set();
  for (const tip of legacyTips()) {
    if (tip.state !== "present") continue;
    for (const id of idsFromAssignRef(tip.sha)) out.add(id);
  }
  return out;
}

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
//
// (#3880) This loop is CONTENTION handling and stays. What does NOT belong here
// is retrying around a slow call: with a 65-210 s fetch per attempt, six
// attempts became the reported 10-minute wedge. The fix was to make each
// attempt ~1 s (the cache repo), not to retry harder.
function raceBackoffMs(attempt) {
  const BASE_MS = 150;
  const CAP_MS = 4000;
  const ceil = Math.min(CAP_MS, BASE_MS * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceil);
}

// Ids added by currently-open PRs. Uses `gh` when available (the only way to
// see a fork-headed PR whose branch is NOT a refs/remotes/origin/* ref here).
//
// The scan itself lives in scripts/lib/open-pr-issue-files.mjs (#3598) — ONE
// implementation shared with the CI gate `check-issue-ids.mjs
// --against-open-prs`, so the allocator and the enforcement point can never
// drift apart. The lib preserves the full #2943 hardening (one batched GraphQL
// query instead of 1+N calls, REST --paginate fallback for >100-file PRs, 3×
// retry with backoff, `complete: false` on total failure). This wrapper keeps
// the allocator's loud warning at the call site.
function idsFromOpenPRs() {
  const r = openPrIssueIds();
  if (!r.complete) {
    console.error(
      `warning: open-PR id scan ${r.budgetExhausted ? `timed out (>${r.scanTotalTimeoutMs}ms)` : "FAILED after 3 attempts"} ` +
        "(gh offline/unauthenticated/rate-limited/slow). The id universe does NOT include in-flight PRs.",
    );
  }
  return r;
}

function allUsedIds(sha, { scanPRs }) {
  const all = new Set([...idsFromMain(), ...idsFromAssignRef(sha), ...idsFromLegacyBooks()]);
  let prScanComplete = true;
  if (scanPRs) {
    const pr = idsFromOpenPRs();
    for (const id of pr.ids) all.add(id);
    prScanComplete = pr.complete;
  }
  return { ids: all, prScanComplete };
}

// --- write + VERIFY BY EFFECT (#3880) ---------------------------------------
//
// Re-read the ref and compare the entry byte-for-byte with what we intended to
// write. This is the only trustworthy answer, in BOTH directions:
//   * push reported failure but the entry is there  -> it LANDED (do not retry;
//     retrying after an "apparent" failure is what burned ids #3890/#3891);
//   * push reported success but the entry is absent -> it did NOT land.
// Ancestry ("is my commit reachable from the tip") is deliberately not used: a
// concurrent write to the SAME key can leave our commit in history while the
// effect we wanted is gone.
//
// The comparison needs the record to be UNIQUE to this invocation, which is
// what `write_id` is for. Timestamps are not enough: `nowIso()` has second
// resolution, so six allocators racing inside one second produced byte-
// identical records, every loser's verification matched the WINNER's entry, and
// all six reported success on the same id (caught by the six-way concurrency
// test — the first-push-wins rejection was working; the verification was not).
function verifyLanded(key, content) {
  if (TEST_FAULT === "verify-unreachable") {
    return { known: false, err: "simulated verification outage (CLAIM_TEST_FAULT)" };
  }
  const st = remoteAssignState();
  if (st.state === "failed") return { known: false, err: st.err };
  if (st.state === "absent") return { known: true, landed: false };
  const f = fetchAssignInto(VERIFY_REF);
  if (!f.ok) return { known: false, err: f.err };
  const r = cgit(["cat-file", "-p", `${VERIFY_REF}:${key}.json`]);
  if (!r.ok) return { known: true, landed: false };
  return { known: true, landed: r.out.trim() === content.trim() };
}

// Build a new tree = base tree with `<key>.json` set to `content`, commit-tree
// on top of base, push — then VERIFY. All plumbing runs inside the cache repo
// so the objects live where the push happens.
function commitAndPush(baseSha, key, content, message) {
  const tmp = mkdtempSync(join(process.env.CLAUDE_JOB_DIR || tmpdir(), "claim-"));
  // The ONE place a git env var is set on purpose: a scratch index so the
  // commit-tree plumbing never touches any real index. `keepEnv` marks it as
  // deliberate so the sanitiser above lets it through.
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
  const idx = { env, keepEnv: ["GIT_INDEX_FILE"] };
  try {
    cgitOrDie(baseSha ? ["read-tree", `${baseSha}^{tree}`] : ["read-tree", "--empty"], "staging the base tree", idx);
    const blob = cgitOrDie(["hash-object", "-w", "--stdin"], "writing the entry blob", { input: content });
    cgitOrDie(["update-index", "--add", "--cacheinfo", `100644,${blob},${key}.json`], "updating the index", idx);
    const tree = cgitOrDie(["write-tree"], "writing the tree", idx);
    const commit = cgitOrDie(
      ["commit-tree", tree, "-m", message, ...(baseSha ? ["-p", baseSha] : [])],
      "creating the commit",
    );
    // --no-verify: the assignment ref only ever carries a single <key>.json
    // (never labs/ content), and the pre-push integrity gate (pnpm install +
    // typecheck + lint, ~120s+) makes every claim hang/exit 124. CLAUDE.md
    // sanctions --no-verify for these non-main, no-CI claim pushes.
    let push = cgit(["push", "--no-verify", ASSIGN_PUSH_URL, `${commit}:refs/heads/${ASSIGN_REF}`], {
      timeout: NET_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (TEST_FAULT === "push-reports-failure") {
      push = { ok: false, out: "", err: "simulated transport failure (CLAIM_TEST_FAULT)", status: 128 };
    }
    // (#3880) A push TIMEOUT routes to verification, not to "failed" — the
    // write may well have landed server-side before the client gave up.
    const v = verifyLanded(key, content);
    return { verdict: v, pushOk: push.ok, pushErr: push.ok ? "" : why(push) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Interpret a commitAndPush result. Returns true when the write landed,
 * false when it demonstrably did not (caller may retry). Never returns on an
 * unverifiable outcome — that exits 7, because guessing in either direction is
 * the bug this issue is about.
 */
function settle(res, what) {
  if (!res.verdict.known) {
    die(
      7,
      `UNKNOWN OUTCOME: ${what} was pushed (git reported ${res.pushOk ? "success" : `failure: ${res.pushErr}`}) but the ` +
        `result could NOT be verified: ${res.verdict.err}\n` +
        `The write may or may not have landed. Do NOT blindly retry — re-read the record first ` +
        `(claim-issue.mjs --check / --list). Blind retries after an unverified outcome are what burned ids #3890/#3891 (#3880).`,
    );
  }
  if (res.verdict.landed && !res.pushOk) {
    // The exact "succeeds as failure" case. Say so — silently swallowing it
    // hides a real transport problem.
    console.error(
      `note: git push reported failure (${res.pushErr}) but the record verifies as written. ` +
        "Treating as SUCCESS on the evidence of the ref, not the exit code (#3880).",
    );
  }
  return res.verdict.landed;
}

// --- read-only modes --------------------------------------------------------
//
// `--list --json` (#3965) is the machine-readable form, added so other tools
// can reuse THIS read path instead of growing their own. The one that grew its
// own — pre-dispatch-gate's `git show origin/issue-assignments:<id>.json` — is
// a remote-TRACKING read: it answers from whatever the last `git fetch` left
// behind, so it is stale by construction and silently empty when the local ref
// was never fetched. Everything routed through here instead gets the tri-state
// hardening for free: an unreadable ref exits 6, it never degrades to "no
// claims", and "no claims" therefore means what it says.
function doList() {
  const wantJson = flags.has("--json");
  const emit = (payload, verdict) => {
    if (wantJson) console.log(JSON.stringify(payload, null, 2));
    ok(verdict);
  };

  const sha = tipShaOrDie("list assignments");
  if (!sha) {
    if (!wantJson) console.log(`No assignments yet (ref ${ASSIGN_REF} does not exist).`);
    emit(
      { ref_read: "absent", ref: ASSIGN_REF, tip: "", total_records: 0, held_count: 0, held: [] },
      "no assignments ref yet",
    );
    return;
  }
  const files = entryFiles(sha);
  // One batched read, not one subprocess per entry: at 654 claims the per-entry
  // form took 50 s (#3880). A failed batch is a real failure here — unlike the
  // id scan, --list has no filename-only fallback that would still be correct.
  const entries = readEntriesBatch(sha, files);
  if (!entries) die(6, `could not read assignment entries at ${sha.slice(0, 12)}`);
  // (#4045/#4117) Fold in any LEGACY book. Keyed by entry filename so the
  // authoritative record wins on a conflict (the #3598 tie-break) while a claim
  // that exists ONLY on the legacy book is still listed — otherwise --list
  // under-reports live claims for exactly as long as the migration lasts, which
  // is when accurate listing matters most.
  const merged = new Map(entries);
  for (const tip of legacyTips()) {
    if (tip.state !== "present") continue;
    const lf = entryFiles(tip.sha);
    const le = readEntriesBatch(tip.sha, lf);
    if (!le) continue;
    for (const [file, entry] of le) {
      if (!merged.has(file) && entry) merged.set(file, { ...entry, book: `${tip.name}/${ASSIGN_REF}` });
    }
  }
  for (const b of legacyReadDegraded()) {
    console.error(
      `WARNING: legacy book ${b.name}/${ASSIGN_REF} is UNREADABLE (${b.err}) — ` +
        "claims recorded only there are MISSING from this list.",
    );
  }
  const rows = [...merged.values()].filter(isHeld);
  rows.sort((a, b) => Number(a.id) - Number(b.id) || String(a.slice || "").localeCompare(String(b.slice || "")));

  if (wantJson) {
    emit(
      {
        ref_read: "ok",
        ref: ASSIGN_REF,
        tip: sha,
        total_records: entries.size,
        held_count: rows.length,
        held: rows.map((e) => ({
          id: String(e.id),
          slice: e.slice || "",
          assignee: e.assignee,
          status: e.status,
          branch: e.branch || "",
          claimed_at: e.claimed_at || "",
        })),
      },
      `${rows.length} active claim(s)`,
    );
    return;
  }

  if (!rows.length) {
    console.log("No active claims.");
    ok("0 active claims");
    return;
  }
  console.log("id\tslice\tassignee\tstatus\tbranch\tclaimed_at");
  for (const e of rows) {
    console.log(`${e.id}\t${e.slice || "-"}\t${e.assignee}\t${e.status}\t${e.branch || "-"}\t${e.claimed_at || "-"}`);
  }
  ok(`${rows.length} active claim(s)`);
}

function doCheck(target) {
  const sha = tipShaOrDie(`report the status of ${target.label}`);
  const found = readEntryAnyBook(sha, target.key);
  const e = found.entry;

  // (#4045/#4117) Report which book answered, and report the books we could
  // NOT read. `--check 4076` once answered `UNASSIGNED` (exit 0) at the same
  // instant another book said `CLAIMED by ttraenkler/H-errmodel` (exit 3) —
  // same command, same id, opposite answers, neither naming its source. A claim
  // assertion without its ref is unusable evidence, and worse, it manufactures
  // confident wrong diagnoses (#4045 records one that was about to be filed
  // against innocent code).
  const blind = legacyReadDegraded();
  const provenance = () => {
    const parts = [`read ${found.book}`];
    if (found.legacy) parts.push("LEGACY book — not yet migrated to the authoritative one");
    for (const s of found.shadowed) {
      parts.push(`also present on ${s.book} as ${s.entry.status || "?"}/${s.entry.assignee || "-"} (shadowed)`);
    }
    for (const b of blind) parts.push(`UNREADABLE: ${b.name}/${ASSIGN_REF} (${b.err})`);
    return parts.join("; ");
  };
  for (const b of blind) {
    console.error(
      `WARNING: could not read the legacy book ${b.name}/${ASSIGN_REF} (${b.err}) — ` +
        "this answer is based on the books that COULD be read, which is not the same as all of them.",
    );
  }
  for (const s of found.shadowed) {
    console.error(
      `NOTE: ${target.label} also has a record on ${s.book} ` +
        `(${s.entry.status || "?"} / ${s.entry.assignee || "-"}). The authoritative book wins; ` +
        "the legacy record is stale and drains on the next write.",
    );
  }

  if (isHeld(e)) {
    console.log(`${target.label} is CLAIMED by ${e.assignee} (since ${e.claimed_at || "?"}).`);
    refuse(3, `${target.label} is claimed by ${e.assignee} (${provenance()})`, true);
  }
  // A bare `--allocate` reservation has no assignee, so `isHeld` is false — and
  // it is right that this is not a CLAIM (nobody is working on it). But
  // printing "UNASSIGNED" for an id that IS reserved answers a question nobody
  // asked: the id is taken, and the tool that WRITES `reserved` records could
  // not see what it had just written. Distinguish the two states. Exit code is
  // unchanged (0) — `3` means claimed, and callers depend on that.
  if (e) {
    const terminal = TERMINAL_CLAIM_STATUSES.has(e.status);
    const who = e.assignee || e.requested_by || "?";
    const when = e.updated_at || e.reserved_at || e.claimed_at || "?";
    console.log(
      terminal
        ? `${target.label} has NO ACTIVE CLAIM, but the id is TAKEN (last status: ${e.status}, ${who}, ${when}).`
        : `${target.label} is RESERVED — the id is TAKEN, nobody is working on it ` +
            `(requested by ${e.requested_by || "?"}, ${when}, status=${e.status || "?"}).`,
    );
    ok(`${target.label} has no live claim; id is taken (status=${e.status || "?"}; ${provenance()})`);
    process.exit(0);
  }
  console.log(`${target.label} is UNASSIGNED.`);
  ok(`${target.label} is unassigned (${provenance()})`);
  process.exit(0);
}

// --- claim / release / complete (write modes, with retry) -------------------
function nowIso() {
  // Date.* is fine in a plain node script (this is not a workflow sandbox).
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// (#3880) The open-PR scan is the ONLY thing standing between `--allocate` and
// an id that an in-flight PR already uses. A reservation made without it must
// therefore never be handed out as if it were clean. We refuse BEFORE reserving
// (an id refused costs nothing; an id reserved and then abandoned is a
// permanent hole in the sequence — two were burned that way on 2026-07-31).
function guardScanCoverage({ scanPRs, degraded }) {
  // (#4045/#4117) FIRST, and above the --allow-unscanned early return on
  // purpose. A legacy book we could not read is the same class of defect as a
  // degraded PR scan — the id universe is incomplete, so the id we hand out may
  // already be reserved by a lane still rooted on that book — but it is a
  // DIFFERENT blind spot and gets its own consent. Sharing one escape hatch
  // would mean an operator who accepted "gh is offline" had silently also
  // accepted "an entire reservation book is invisible", which is the
  // collision this change exists to remove.
  const blind = legacyReadDegraded();
  if (blind.length && !flags.has("--allow-unmerged-books")) {
    die(
      6,
      `cannot READ the legacy assignment book(s): ${blind.map((b) => `${b.name} (${b.err})`).join("; ")}\n` +
        "Nothing was reserved. Records still live on a legacy book are part of the id universe until it drains, " +
        "and an unreadable book is NOT an empty one — allocating past it re-creates the split-brain collision.\n" +
        `Fix connectivity and re-run, set CLAIM_ASSIGN_LEGACY_REMOTES="" if the book is genuinely drained, or pass ` +
        "--allow-unmerged-books to reserve anyway and accept the risk.",
    );
  }
  if (flags.has("--allow-unscanned")) return;
  if (!scanPRs) {
    die(
      2,
      "--no-pr-scan disables the open-PR collision check, so the reserved id would NOT be verified against " +
        "in-flight PRs — the exact way duplicate issue ids reach the merge queue (#2531/#3636).\n" +
        "Run without --no-pr-scan, or pass --allow-unscanned to reserve anyway and accept the collision risk.",
    );
  }
  if (degraded) {
    die(
      6,
      "the open-PR id scan DEGRADED (gh offline/unauthenticated/rate-limited), so the id universe is incomplete " +
        "and the reserved id would not be verified against in-flight PRs.\n" +
        "Nothing was reserved. Fix gh auth and re-run, or pass --allow-unscanned to reserve anyway.",
    );
  }
}

// Atomically reserve the next free issue id (#2531). Computes max(used)+1 over
// main ∪ open-PR-added ids ∪ ref-reserved ids, writes a reservation entry, and
// pushes first-wins. On a non-ff rejection (another allocator landed a
// reservation since we read), re-fetch and recompute a fresh id — so two
// concurrent allocators can NEVER hand out the same number. Prints the reserved
// id to stdout (machine-readable; the human/JSON detail goes to stderr or with
// --json). `assignee` is optional: with one the reservation doubles as the claim
// lock (status in-progress); without one it's a bare `reserved` placeholder the
// real claim transitions in place.
function doAllocate(assignee) {
  const wantJson = flags.has("--json");
  const scanPRs = !flags.has("--no-pr-scan");
  const dryRun = flags.has("--dry-run");
  // A dry run reserves nothing, so an unscanned preview is harmless — gate only
  // real reservations.
  if (!dryRun) guardScanCoverage({ scanPRs, degraded: false });
  refreshMainTip();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1 && deadlineExceeded()) {
      die(
        5,
        `Gave up after ${Math.round((Date.now() - STARTED_AT) / 1000)}s (deadline ${DEADLINE_MS}ms, ${attempt - 1} attempts).\n` +
          "Nothing was written: every attempt was VERIFIED against the ref, so this is not a guess and re-running " +
          "cannot double-write. Raise CLAIM_DEADLINE_MS if the fleet/network is unusually slow.",
      );
    }
    const sha = tipShaOrDie("allocate an id");

    const { ids: used, prScanComplete } = allUsedIds(sha, { scanPRs });
    // contiguousMax+1 is always strictly above the contiguous body, so it can
    // never alias an in-use id (strays sit > STRAY_GAP above max, never at +1).
    const id = String(contiguousMax(used) + 1);
    const degraded = scanPRs && !prScanComplete;
    if (!dryRun) guardScanCoverage({ scanPRs, degraded });

    // --dry-run: preview the candidate without reserving (no push). Useful to
    // see "what id would I get" without burning a reservation. NOT collision-
    // safe on its own — only the real reserve+push is atomic.
    if (dryRun) {
      const scanState = scanPRs ? (degraded ? "DEGRADED" : "on") : "off";
      if (wantJson) {
        process.stdout.write(
          JSON.stringify({ id: Number(id), dryRun: true, prScan: scanState, prScanDegraded: degraded }) + "\n",
        );
      } else {
        console.error(`(dry-run) next free id would be #${id} (scanned ${used.size} used ids; PR-scan ${scanState})`);
        process.stdout.write(`${id}\n`);
      }
      ok(`dry-run preview #${id} (nothing reserved)`);
      return;
    }

    const requestedBy = requesterId(assignee);
    const entry = {
      id,
      assignee: assignee || "",
      // (#3880) Never anonymous: a bare reservation still names who asked for
      // it, so the ref can attribute ownership.
      requested_by: requestedBy,
      status: assignee ? "in-progress" : "reserved",
      branch: assignee ? branch || "" : "",
      reserved_at: nowIso(),
      ...(assignee ? { claimed_at: nowIso() } : {}),
      updated_at: nowIso(),
      // Unique per invocation — the fingerprint verifyLanded() compares against
      // (see there for why second-resolution timestamps are not enough).
      write_id: UNIQ,
      // (#3598 forensics) durable record of the open-PR scan's health AT
      // allocation time. Collision C could not be root-caused post-hoc because
      // the degraded-scan signal lived only on stderr; now the reservation
      // itself says whether the id universe included open PRs ("ok"),
      // was degraded (scan failed → fail-open), or was skipped (--no-pr-scan).
      // Since #3880, anything other than "ok" requires an explicit
      // --allow-unscanned, so the marker records a DELIBERATE choice.
      pr_scan: scanPRs ? (degraded ? "degraded" : "ok") : "off",
    };
    const verb = assignee ? `reserve+claim #${id} -> ${assignee}` : `reserve #${id}`;
    const msg = `chore(assign): ${verb} [skip ci]`;
    const content = JSON.stringify(entry, null, 2) + "\n";

    const res = commitAndPush(sha, id, content, msg);
    if (settle(res, `reservation of #${id}`)) {
      // stdout = just the id (scriptable); details to stderr unless --json.
      if (wantJson) {
        process.stdout.write(
          JSON.stringify({
            id: Number(id),
            assignee: assignee || null,
            requestedBy,
            branch: entry.branch || null,
            prScan: entry.pr_scan,
            prScanDegraded: degraded,
          }) + "\n",
        );
      } else {
        console.error(
          `Reserved issue #${id}${assignee ? ` for ${assignee}${entry.branch ? ` (branch ${entry.branch})` : ""}` : ""} (requested by ${requestedBy}).`,
        );
        console.error(`(pushed to ${REMOTE}/${ASSIGN_REF}; main untouched, no CI triggered)`);
        process.stdout.write(`${id}\n`);
      }
      if (entry.pr_scan !== "ok") {
        console.error(
          `WARNING: #${id} was reserved with pr_scan="${entry.pr_scan}" — it is NOT verified against in-flight PRs ` +
            "and may collide in the merge_group. Re-check before creating the file.",
        );
      }
      ok(`reserved #${id} (verified on ${REMOTE}/${ASSIGN_REF}, pr_scan=${entry.pr_scan})`);
      return;
    }
    console.error(`allocate: ref moved (attempt ${attempt}/${MAX_RETRIES}) — re-scanning for a fresh id…`);
    // (#2974/#2977) Backoff+jitter before re-scanning so concurrent allocators
    // don't re-collide in lock-step. Skip the wait after the final attempt.
    if (attempt < MAX_RETRIES) sleepMs(raceBackoffMs(attempt));
  }
  die(
    5,
    `Could not reserve a fresh id after ${MAX_RETRIES} attempts (heavy contention — other agents kept winning the ref).\n` +
      "Nothing was reserved: every attempt was VERIFIED against the ref, so this is not a guess and re-running " +
      "cannot double-reserve. Raise CLAIM_MAX_RETRIES if the fleet is unusually busy.",
  );
}

function writeMode(target, assignee, kind) {
  const { base, slice, key, label } = target;
  // Pre-flight: refuse claiming an issue already closed on main. Resolve the
  // BASE issue number so a slice claim is still refused once the parent closes.
  if (kind === "claim") {
    const main = mainIssueStatus(base);
    if (main && (main.status === "done" || main.status === "wont-fix")) {
      refuse(4, `${label} is already ${main.status} on ${MAIN_REF} (${main.file}). Nothing to claim.`);
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
    const sha = tipShaOrDie(`preview ${kind} of ${label}`);
    // (#4045/#4117) Union of the authoritative and legacy books — a claim held
    // only on a legacy book must still block, or the migration window becomes a
    // duplicate-dispatch window.
    const found = readEntryAnyBook(sha, key);
    const existing = found.entry;
    const held = isHeld(existing);
    console.error(
      `(dry-run) would ${kind} ${label}${assignee ? ` -> ${assignee}` : ""}${branch ? ` (branch ${branch})` : ""}. ` +
        (held
          ? `Currently held by ${existing.assignee} (since ${existing.claimed_at || "?"}).`
          : "Currently unassigned.") +
        ` No push performed; ${REMOTE}/${ASSIGN_REF} untouched.`,
    );
    ok(`dry-run preview of ${kind} ${label} (nothing written)`);
    return;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1 && deadlineExceeded()) {
      die(
        5,
        `Gave up after ${Math.round((Date.now() - STARTED_AT) / 1000)}s (deadline ${DEADLINE_MS}ms, ${attempt - 1} attempts).\n` +
          "Nothing was written: every attempt was VERIFIED against the ref, so this is not a guess and re-running " +
          "cannot double-write. Raise CLAIM_DEADLINE_MS if the fleet/network is unusually slow.",
      );
    }
    const sha = tipShaOrDie(`${kind} ${label}`);
    // (#4045/#4117) See the dry-run branch: reads are the UNION of both books,
    // writes always go to the authoritative one — which is what drains the
    // legacy book instead of orphaning it.
    const found = readEntryAnyBook(sha, key);
    const existing = found.entry;
    if (found.legacy) {
      console.error(
        `NOTE: ${label}'s existing record was read from the LEGACY book ${found.book}. ` +
          `This ${kind} writes to ${REMOTE}/${ASSIGN_REF}, migrating it forward.`,
      );
    }

    if (kind === "claim") {
      if (isHeld(existing) && existing.assignee !== assignee && !flags.has("--force")) {
        refuse(
          3,
          `${label} is already claimed by ${existing.assignee} (since ${existing.claimed_at || "?"}). Pick another issue${slice ? "/slice" : ""}, or pass --force to steal.`,
        );
      }
    }
    if (kind === "release" || kind === "complete") {
      if (!isHeld(existing)) {
        // Reaching here means the ref was READ SUCCESSFULLY and genuinely holds
        // no live claim — tipShaOrDie() has already made a failed read fatal.
        // Before #3880 this same line was printed when the read had FAILED,
        // which is how #3661/#3685 kept a stale lock while the caller saw a
        // clean exit 0.
        console.log(`${label} is not currently claimed — nothing to ${kind}.`);
        ok(`${label} holds no live claim (verified against ${REMOTE}/${ASSIGN_REF})`);
        return;
      }
      if (assignee && existing.assignee !== assignee && !flags.has("--force")) {
        refuse(3, `${label} is held by ${existing.assignee}, not ${assignee}. Pass --force to override.`);
      }
    }

    const entry = {
      id: base,
      ...(slice ? { slice } : {}),
      assignee: kind === "claim" ? assignee : existing ? existing.assignee : assignee,
      // The ACTOR, not the holder. On release/complete the positional argument
      // is the EXPECTED holder (whose claim is being cleared) — frequently a
      // departed agent — so attributing the record to it would say the dead
      // agent released itself. Only a claim is performed by its own assignee.
      // The ACTOR, not the holder. On release/complete the positional argument
      // is the EXPECTED holder (whose claim is being cleared) — frequently a
      // departed agent — so attributing the record to it would say the dead
      // agent released itself. Only a claim is performed by its own assignee.
      requested_by: requesterId(kind === "claim" ? assignee : ""),
      status: kind === "claim" ? "in-progress" : kind === "complete" ? "done" : "released",
      branch: kind === "claim" ? branch || (existing && existing.branch) || "" : (existing && existing.branch) || "",
      claimed_at: kind === "claim" ? nowIso() : existing ? existing.claimed_at : nowIso(),
      updated_at: nowIso(),
      // Unique per invocation — the fingerprint verifyLanded() compares against.
      write_id: UNIQ,
    };
    if (kind !== "claim") entry.released_at = nowIso();

    const verb = kind === "claim" ? "claim" : kind;
    const msg = `chore(assign): ${verb} ${label} -> ${entry.assignee} [skip ci]`;
    const content = JSON.stringify(entry, null, 2) + "\n";

    const res = commitAndPush(sha, key, content, msg);
    if (settle(res, `${kind} of ${label}`)) {
      const human =
        kind === "claim"
          ? `Claimed ${label} for ${entry.assignee}${entry.branch ? ` (branch ${entry.branch})` : ""}.`
          : kind === "complete"
            ? `Marked ${label} complete (was ${entry.assignee}).`
            : `Released ${label} (was ${entry.assignee}).`;
      console.log(human);
      console.log(`(pushed to ${REMOTE}/${ASSIGN_REF}; main untouched, no CI triggered)`);
      ok(`${kind} ${label} verified on ${REMOTE}/${ASSIGN_REF}`);
      return;
    }
    console.error(`push rejected (attempt ${attempt}/${MAX_RETRIES}) — someone else moved the ref, re-checking…`);
    // (#2974/#2977) Backoff+jitter before re-checking so concurrent claimants
    // don't re-collide in lock-step. Skip the wait after the final attempt.
    if (attempt < MAX_RETRIES) sleepMs(raceBackoffMs(attempt));
  }
  die(
    5,
    `Could not acquire the claim ref after ${MAX_RETRIES} attempts (heavy contention — other agents kept winning the ref).\n` +
      "Nothing was written: every attempt was VERIFIED against the ref, so this is not a guess. Safe to re-run; " +
      "raise CLAIM_MAX_RETRIES if the fleet is unusually busy.",
  );
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
