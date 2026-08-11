#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2178 — Baseline-floor staleness check.
//
// The standalone regression guard (#1897) and the host regression gate diff
// every PR against a *floor* stored in `loopdive/js2wasm-baselines`
// (`test262-standalone-current.json` / `test262-current.json`, each carrying a
// `baseline_sha` = the main commit it was promoted for). The floor is supposed
// to advance on every push to main via `promote-baseline`. When the push:main
// promote run is dropped (the merge-queue thrash of #2178), the floor stops
// advancing and every PR on current main is blocked against a stale floor.
//
// This script measures how far each floor lags `main` HEAD — counting ONLY
// test262-RELEVANT commits (so the [skip ci] baseline-refresh commits and
// docs-only churn that don't change conformance never register as drift). It
// is the surface-the-deadlock self-check from #2178 acceptance criterion 3.
//
// It does NOT promote anything; it only reports. A wrapping workflow decides
// whether to alert / auto-heal based on the threshold breach (exit code 2).
//
// Inputs (env or flags):
//   --max-behind N        commit threshold before staleness is a breach (default 25)
//   --repo loopdive/js2wasm-baselines   baselines repo (default)
//   --ref main            git ref of `main` to measure against (default origin/main)
//   --json                emit a machine-readable JSON line on stdout (for the workflow)
//
// Network: fetches the two floor report JSONs from the baselines repo raw URL.
// Git: expects to run inside a checkout of the MAIN repo with enough history
//   fetched that the floor SHA is reachable (the workflow does a deep-enough
//   fetch). When the floor SHA is unreachable it reports `reachable:false` and
//   exits 0 (undetermined, never a false breach).
//
// Exit codes:
//   0 — floor is fresh (within threshold) OR staleness undetermined (floor SHA
//       unreachable / fetch failed) — never blocks on uncertainty
//   2 — a floor lags main by MORE than --max-behind test262-relevant commits
//       (the deadlock signature — caller should alert / auto-heal)
//   3 — internal/usage error

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const RAW_BASE = (repo) => `https://raw.githubusercontent.com/${repo}/main`;

function parseArgs(argv) {
  const args = {
    maxBehind: Number(process.env.MAX_FLOOR_COMMITS_BEHIND ?? 25),
    repo: process.env.BASELINES_REPO ?? "loopdive/js2wasm-baselines",
    ref: process.env.MAIN_REF ?? "origin/main",
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-behind") args.maxBehind = Number(argv[++i]);
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--ref") args.ref = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: check-baseline-floor-staleness.mjs [--max-behind N] [--repo owner/name] [--ref main] [--json]",
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(3);
    }
  }
  if (!Number.isFinite(args.maxBehind) || args.maxBehind < 0) {
    console.error(`--max-behind must be a non-negative number`);
    process.exit(3);
  }
  return args;
}

async function fetchFloorSha(repo, file) {
  const url = `${RAW_BASE(repo)}/${file}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    const sha = json?.baseline_sha;
    if (!sha || typeof sha !== "string") {
      return { ok: false, reason: "no baseline_sha field" };
    }
    return {
      ok: true,
      sha,
      pass: json?.summary?.pass ?? null,
      total: json?.summary?.total ?? null,
      generatedAt: json?.baseline_generated_at ?? null,
    };
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitSafe(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// True when the git command exits 0, regardless of (possibly empty) stdout.
// `git cat-file -e` succeeds with NO output, so a truthiness test on gitSafe
// would wrongly read success-with-empty-stdout as failure.
function gitOk(args) {
  try {
    execFileSync("git", args, { encoding: "utf8", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Count commits in `ref` not reachable from `floorSha` whose changed file set
// touches a test262-relevant path FOR `target` ("any" | "host" | "standalone").
// Returns { total, relevant, exact } or null when the floor SHA is unreachable
// from the checkout. Passing the lane matters: a standalone shard-weight
// refresh is drift for the standalone floor only, and counting it against the
// host floor overstates that lane's lag.
//
// A single `git log --name-only` pass streams every commit + its changed files
// (one subprocess, not one-per-commit). We early-exit the moment `relevant`
// exceeds `maxBehind` — the breach decision is already settled, so we don't
// walk thousands of commits when the floor is far behind. `exact` is false in
// that early-exit case (the reported counts are a lower bound ≥ the threshold,
// which is all the breach decision needs).
export function countRelevantDrift(floorSha, ref, maxBehind, target = "any") {
  // Floor SHA must be a commit we can name; if not, staleness is undetermined.
  if (!gitOk(["cat-file", "-e", `${floorSha}^{commit}`])) {
    return null;
  }
  let out;
  try {
    out = execFileSync("git", ["log", "--no-renames", "--name-only", "--pretty=format:%x00%H", `${floorSha}..${ref}`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  let total = 0;
  let relevant = 0;
  let curFiles = [];
  let sawCommit = false;
  const flush = () => {
    if (!sawCommit) return;
    total++;
    if (pathsTouchTest262(curFiles.join("\n"), target)) relevant++;
    curFiles = [];
  };
  for (const rawLine of out.split("\n")) {
    if (rawLine.startsWith("\x00")) {
      // New commit boundary — flush the previous commit's accumulated files.
      flush();
      sawCommit = true;
      // Early-exit: the breach is already decided.
      if (relevant > maxBehind) {
        return { total, relevant, exact: false };
      }
      continue;
    }
    if (rawLine.length > 0) curFiles.push(rawLine);
  }
  flush();
  return { total, relevant, exact: true };
}

// Mirror of scripts/test262-paths-match.sh — kept in lockstep with the
// &test262-paths allowlist in test262-sharded.yml (pinned by the
// "stays in lockstep with scripts/test262-paths-match.sh" case in
// tests/issue-2178-baseline-floor-staleness.test.ts, which runs a shared path
// set through BOTH implementations for every target).
const EXACT_TEST262_PATHS = new Set([
  ".github/actions/setup-node-pnpm/action.yml",
  ".github/workflows/test262-sharded.yml",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "scripts/tsconfig.json",
  "vitest.config.ts",
  "scripts/build-test262-report.mjs",
  "scripts/compiler-fork-worker.mjs",
  "scripts/compiler-pool.ts",
  "scripts/diff-test262.ts",
  "scripts/build-quickjs-eval-provider.mjs",
  "scripts/quickjs-eval-provider.mjs",
  "scripts/runtime-eval-provider.mjs",
  "scripts/generate-editions.ts",
  "scripts/test262-worker.mjs",
  "tests/test262-runner.ts",
  "tests/test262-scope-classification.test.ts",
  "tests/test262-shared.ts",
  "scripts/test262-paths-match.sh",
]);

// Which lane(s) a changed path can move: "both" | "host" | "standalone" | "".
// Mirrors classify_test262_path in scripts/test262-paths-match.sh — see that
// file for why the default is "both" and which explicitly audited paths are
// lane-exclusive.
export function classifyTest262Path(p) {
  if (!p) return "";
  if (p === "tests/test262-slow-tests-standalone.json") return "standalone";
  if (p === "tests/test262-slow-tests.json") return "host";
  if (p === "scripts/build-quickjs-eval-provider.mjs") return "standalone";
  if (p === "scripts/quickjs-eval-provider.mjs") return "standalone";
  if (p === "scripts/runtime-eval-provider.mjs") return "standalone";
  if (p.startsWith("scripts/quickjs-artifact/")) return "standalone";
  if (EXACT_TEST262_PATHS.has(p)) return "both";
  if (p.startsWith("src/")) return "both";
  if (/^tests\/test262-chunk.*\.test\.ts$/.test(p)) return "both";
  if (/^tests\/test262-slow-tests.*\.json$/.test(p)) return "both";
  return "";
}

/**
 * A changed-file blob (one path per line) touches test262 conformance iff any
 * line matches. `target` narrows the question to a single lane:
 *   "any" (default) — either lane, i.e. the historical behaviour
 *   "host"          — the JS-host (gc) lane
 *   "standalone"    — the standalone lane
 */
export function pathsTouchTest262(changedBlob, target = "any") {
  for (const line of changedBlob.split("\n")) {
    const scope = classifyTest262Path(line.trim());
    if (!scope) continue;
    if (target === "any" || scope === "both" || scope === target) return true;
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv);

  // Resolve main HEAD sha for reporting.
  const headSha = gitSafe(["rev-parse", args.ref]) ?? args.ref;

  const lanes = [
    { lane: "standalone", file: "test262-standalone-current.json" },
    { lane: "host", file: "test262-current.json" },
  ];

  const results = [];
  let breach = false;
  for (const { lane, file } of lanes) {
    const floor = await fetchFloorSha(args.repo, file);
    if (!floor.ok) {
      results.push({ lane, error: floor.reason, reachable: false });
      console.error(
        `::warning::[${lane}] could not read floor ${file} from ${args.repo}: ${floor.reason} — staleness undetermined for this lane.`,
      );
      continue;
    }
    // Count drift for THIS lane only: a change that provably cannot move this
    // lane's results is not lag for this lane's floor (see classifyTest262Path).
    const drift = countRelevantDrift(floor.sha, args.ref, args.maxBehind, lane);
    if (drift === null) {
      results.push({
        lane,
        floorSha: floor.sha,
        reachable: false,
      });
      console.error(
        `::warning::[${lane}] floor SHA ${floor.sha.slice(0, 8)} is not reachable from the checkout — staleness undetermined (deepen the fetch). Not treated as a breach.`,
      );
      continue;
    }
    const isBreach = drift.relevant > args.maxBehind;
    if (isBreach) breach = true;
    results.push({
      lane,
      floorSha: floor.sha,
      headSha,
      reachable: true,
      commitsBehindTotal: drift.total,
      commitsBehindRelevant: drift.relevant,
      exactCount: drift.exact,
      maxBehind: args.maxBehind,
      breach: isBreach,
      pass: floor.pass,
      total: floor.total,
      generatedAt: floor.generatedAt,
    });
    const level = isBreach ? "error" : "notice";
    const atLeast = drift.exact ? "" : "≥";
    console.error(
      `::${level}::[${lane}] floor ${floor.sha.slice(0, 8)} is ${atLeast}${drift.relevant} test262-relevant commit(s) behind ${args.ref} (${atLeast}${drift.total} total, max ${args.maxBehind})${isBreach ? " — STALE FLOOR, promote-baseline likely dropped (#2178)" : ""}.`,
    );
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ breach, maxBehind: args.maxBehind, lanes: results }) + "\n");
  }

  process.exit(breach ? 2 : 0);
}

// Only run the CLI when invoked directly (not when imported by a test).
const invokedDirectly = (() => {
  try {
    return realpathSync(argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`internal error: ${e?.stack ?? e}`);
    process.exit(3);
  });
}
