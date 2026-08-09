#!/usr/bin/env node
// main-push-queue-gate.mjs — decide whether a bot may push to `main` RIGHT NOW.
//
// WHY THIS EXISTS (#3915). Any push to `main` — including one marked
// `[skip ci]` — makes GitHub REBUILD every in-flight merge group on the new
// base, which DISCARDS the `merge_group` validation already running for the
// PR at the head of the queue. `[skip ci]` suppresses *workflows on that
// commit*; it does NOT make the push inert to the merge queue. That marker
// reads as "this push is harmless" and the reading is wrong.
//
// The tax is a FEEDBACK LOOP, not an occasional collision: `benchmark-refresh`
// is triggered BY each merge and lands its artifact commit 7–12 min later,
// while the next PR's group is built within seconds of that merge and takes
// ~11–13 min to validate. So every merge schedules a bot push timed to land
// inside the next merge's validation window, and the tax SCALES WITH MERGE
// THROUGHPUT — backwards for a pipeline whose job is to land work.
//
// THE EVIDENCE IS A NATURAL EXPERIMENT ALREADY RUNNING IN THIS REPO. #1951
// added an inline queue-empty deferral to two of the four bots that push
// `main` (`test262-sharded.yml` promote-baseline, `baseline-summary-sync.yml`).
// Measured 2026-07-31 17:55–23:11Z over 20 distinct PRs: 6 needed more than one
// merge group; **5 of those 6 rebuilds were rooted at an un-gated
// `benchmark-refresh` commit and 0 at either gated pusher** (the 6th was a
// legitimate PR landing ahead). Over the same 2 days: 48 benchmark-refresh
// pushes vs 7 from the gated summary sync. The gate works; this script is that
// gate, extracted so the next bot that pushes `main` cannot forget it.
//
// -------------------------------------------------------------------------
// THE DECISION
//
//   defer ⟸ queue is POSITIVELY busy  AND  the artifact is POSITIVELY fresh
//   proceed otherwise
//
// Both conjuncts must be *known*. Every unknown proceeds.
//
// ON FAIL-OPEN, AND WHY IT DOES NOT CONTRADICT THE "A DETECTOR MUST BE ABLE TO
// SAY I DON'T KNOW" RULE. The standing rule is that a check which cannot see
// must not fall onto the reassuring side — because for a VERIFIER, the
// reassuring side hides defects. This is not a verifier, it is a DEFERRAL, and
// the cost asymmetry is REVERSED:
//
//   * fail-open  (unknown ⇒ push)  costs AT MOST one discarded validation, once.
//   * fail-closed (unknown ⇒ defer) can FREEZE the artifact INDEFINITELY on a
//     flaky API — silently, because a skipped push looks identical to a
//     no-op one.
//
// So here the unknown-resolving-to-"act" direction is the conservative one: an
// unknown can only ever cost what the bug costs today, and can never introduce
// a new, worse, silent failure. The rule's intent is preserved in the part that
// matters — the gate still REPORTS that it could not see, via a
// `::warning::` annotation and an explicit `queue=UNKNOWN` / `age=UNKNOWN` in
// the verdict line, so a silently-degraded gate is visible in the run log
// instead of looking like an empty queue.
//
// -------------------------------------------------------------------------
// THE STALENESS FLOOR
//
// A pure queue-empty gate can starve: on a queue that never drains, the
// artifact never refreshes. `--stale-after-hours` bounds that — once the
// committed artifact is older than the floor, the push proceeds even into a
// busy queue. That trades AT MOST one rebuild per floor-period (≤4/day at 6h)
// against an unbounded freeze. #1951 made the same trade for the test262
// summary.
//
// READ THE FRESHNESS FROM THE ARTIFACT, NOT FROM `git log`. The obvious
// implementation — `git log -1 --format=%ct -- <path>` — returns EMPTY, not an
// error, in a `fetch-depth: 1` checkout, and every promote job in this repo is
// shallow. Empty parses as "no timestamp" ⇒ UNKNOWN ⇒ proceed, which would
// silently disable the floor forever while the gate reported success. Pass
// `--last-refresh` from a value carried IN the artifact
// (`benchmark-manifest.json` → `generatedAt`) so a shallow checkout cannot
// launder itself into "fresh".
//
// -------------------------------------------------------------------------
// USAGE
//
//   node scripts/main-push-queue-gate.mjs \
//     --repo "$GITHUB_REPOSITORY" \
//     --last-refresh "$(jq -r .generatedAt benchmarks/results/benchmark-manifest.json)" \
//     --stale-after-hours 6 \
//     --reason "landing benchmark artifacts"
//
// Exit code 0 = PROCEED with the push. Exit code 10 = DEFER (a normal,
// expected outcome — callers should treat it as "skip the push and exit 0",
// never as a failure). Any other non-zero exit is a real error; callers should
// treat it as PROCEED (fail-open) after logging.
//
// THE EXIT CODE IS THE ONLY CONTRACT. This script deliberately does NOT write
// $GITHUB_OUTPUT: the caller maps the exit code to an output, so exactly one
// actor writes the decision. Two writers is how a gate ends up reporting a
// value nothing set.
//
// `--force` (or MAIN_PUSH_GATE_FORCE=true) always proceeds — for the manual
// `workflow_dispatch` escape hatch, which knowingly accepts one churn event.
//
// `--fallback <text>` declares that ANOTHER already-gated path re-lands this
// same artifact (e.g. `refresh-baseline`'s main-repo audit copy is re-landed by
// the hourly, gated `baseline-summary-sync.yml`). When a fallback is declared,
// the artifact cannot freeze even if this push never happens, so an UNKNOWN
// freshness reading DEFERS instead of failing open. Only pass it when the
// fallback is real and itself gated — it is an assertion, not a preference.

import { execFileSync } from "node:child_process";

const UNKNOWN = Symbol("unknown");

function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || "",
    lastRefresh: "",
    staleAfterHours: 6,
    reason: "artifact promotion",
    fallback: "",
    force: String(process.env.MAIN_PUSH_GATE_FORCE || "").toLowerCase() === "true",
    // Test seam: inject the queue length instead of calling the API.
    queueLenOverride: process.env.MAIN_PUSH_GATE_QUEUE_LEN ?? null,
    now: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--repo") args.repo = next();
    else if (a === "--last-refresh") args.lastRefresh = next();
    else if (a === "--stale-after-hours") args.staleAfterHours = Number(next());
    else if (a === "--reason") args.reason = next();
    else if (a === "--fallback") args.fallback = next();
    else if (a === "--force") args.force = true;
    else if (a === "--queue-len") args.queueLenOverride = next();
    else if (a === "--now") args.now = next();
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * How many entries are in the repo's merge queue?
 * @returns {number | typeof UNKNOWN} UNKNOWN when the query could not be answered.
 */
export function readQueueLength({ repo, override, exec = execFileSync } = {}) {
  if (override !== null && override !== undefined && override !== "") {
    const n = Number(override);
    return Number.isInteger(n) && n >= 0 ? n : UNKNOWN;
  }
  if (!repo || !repo.includes("/")) return UNKNOWN;
  const [owner, name] = repo.split("/");
  let raw;
  try {
    raw = exec(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue{entries(first:1){totalCount}}}}",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "--jq",
        ".data.repository.mergeQueue.entries.totalCount",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return UNKNOWN;
  }
  // A blank/whitespace body is the silent-empty case: `gh` exited 0 but the
  // field was absent (no merge queue configured, a permissions gap, a partial
  // GraphQL error). It is NOT zero. Report it as unknown.
  const text = String(raw ?? "").trim();
  if (text === "" || text === "null") return UNKNOWN;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : UNKNOWN;
}

/**
 * Age, in hours, of the artifact this push would refresh.
 * @returns {number | typeof UNKNOWN}
 */
export function readArtifactAgeHours(lastRefresh, nowMs) {
  const text = String(lastRefresh ?? "").trim();
  // Guard the shapes a shallow `git log` / a missing jq field actually produce.
  if (text === "" || text === "null" || text === "undefined") return UNKNOWN;
  const then = Date.parse(text);
  if (!Number.isFinite(then)) return UNKNOWN;
  const hours = (nowMs - then) / 3_600_000;
  // A future timestamp means clock skew or a malformed field, not freshness.
  if (!Number.isFinite(hours) || hours < 0) return UNKNOWN;
  return hours;
}

/**
 * The whole decision, pure and unit-testable.
 * @returns {{decision: "proceed"|"defer", why: string, warnings: string[]}}
 */
export function decide({ force, queueLen, ageHours, staleAfterHours, fallback = "" }) {
  const warnings = [];
  const fmtQueue = queueLen === UNKNOWN ? "UNKNOWN" : String(queueLen);
  const fmtAge = ageHours === UNKNOWN ? "UNKNOWN" : `${ageHours.toFixed(1)}h`;
  const state = `queue=${fmtQueue} artifact-age=${fmtAge} floor=${staleAfterHours}h`;

  if (force) {
    return {
      decision: "proceed",
      why: `forced — accepting one merge-queue rebuild (${state})`,
      warnings,
    };
  }
  if (queueLen === UNKNOWN) {
    warnings.push(
      "merge-queue length could not be read; proceeding (fail-open) — this push may discard an in-flight merge_group validation",
    );
    return { decision: "proceed", why: `queue length unknown (${state})`, warnings };
  }
  if (queueLen === 0) {
    return { decision: "proceed", why: `merge queue is empty (${state})`, warnings };
  }
  if (ageHours === UNKNOWN) {
    // The caller has declared another already-gated path that re-lands this
    // same artifact, so skipping this push cannot freeze anything. With the
    // freeze risk covered, an unreadable freshness value defers.
    if (fallback) {
      return {
        decision: "defer",
        why: `queue busy; no staleness floor needed — ${fallback} re-lands this artifact (${state})`,
        warnings,
      };
    }
    warnings.push(
      "artifact freshness could not be read, so the staleness floor cannot be applied; proceeding (fail-open) rather than risk freezing the artifact",
    );
    return {
      decision: "proceed",
      why: `queue busy but artifact age unknown (${state})`,
      warnings,
    };
  }
  if (ageHours >= staleAfterHours) {
    return {
      decision: "proceed",
      why: `queue busy, but the artifact is past the ${staleAfterHours}h staleness floor — accepting one rebuild (${state})`,
      warnings,
    };
  }
  return {
    decision: "defer",
    why: `merge queue busy and the artifact is fresh — deferring to avoid discarding an in-flight merge_group validation (${state})`,
    warnings,
  };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`main-push-queue-gate: ${err.message}`);
    console.log("main-push-queue-gate: PROCEED — usage error, failing open");
    return 0;
  }
  if (args.help) {
    console.log(
      "usage: main-push-queue-gate.mjs --repo owner/name [--last-refresh <iso>] " +
        "[--stale-after-hours N] [--reason TEXT] [--fallback TEXT] [--force]",
    );
    return 0;
  }

  const nowMs = args.now ? Date.parse(args.now) : Date.now();
  const queueLen = readQueueLength({
    repo: args.repo,
    override: args.queueLenOverride,
  });
  const ageHours = readArtifactAgeHours(args.lastRefresh, nowMs);
  const { decision, why, warnings } = decide({
    force: args.force,
    queueLen,
    ageHours,
    staleAfterHours: args.staleAfterHours,
    fallback: args.fallback,
  });

  for (const w of warnings) {
    console.log(`::warning title=main-push-queue-gate::${w}`);
  }
  // Last line is always the verdict, so it survives a bad pipe.
  console.log(`main-push-queue-gate: ${decision.toUpperCase()} (${args.reason}) — ${why}`);

  return decision === "defer" ? 10 : 0;
}

export { UNKNOWN };

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("main-push-queue-gate.mjs");
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
