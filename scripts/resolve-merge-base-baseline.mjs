#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1081 — Resolve which test262 baseline JSONL a PR's regression-gate should
// diff against, preferring the commit-hash-indexed cache entry for the PR's
// merge-base over the moving "latest main" pointer.
//
// #3467 — for a merge_group run the "merge-base" is the queue's REAL parent
// commit (`github.event.merge_group.base_sha`), and the sequential merge queue
// writes runs/<sha> for every landed commit (see the write-run-cache-bot job in
// test262-sharded.yml). Diffing against runs/<base_sha> makes the delta purely
// the PR's own effect — zero drift from the promoted-snapshot lag that
// false-parked 6 unrelated PRs on 2026-07-19. To survive a cold cache (a base
// whose shards were skipped, or pre-rollout commits) the resolver accepts an
// ORDERED candidate list (base first, then its ancestors, nearest-first) and
// uses the nearest cached, version-compatible ancestor — logging the commit
// DISTANCE so a miss is visible, never silent.
//
// Logic:
//   1. Given an ordered candidate SHA list (base_sha, then nearest ancestors)
//      and a checkout of the baselines repo, look for the first
//      runs/<sha>.jsonl + runs/<sha>.json that exists.
//   2. Cache HIT: the entry's test262_version must match the current
//      submodule SHA (else the baseline is for a different test262 corpus and
//      would shadow real regressions — spec §Risks: cache shadowing). On a
//      match, emit the cached jsonl as the baseline and report its distance
//      (0 = exact base, N = N commits back).
//   3. Cache MISS (no candidate cached / version mismatch on all): fall back to
//      test262-current.jsonl (the promoted snapshot), print a warning so
//      cache-miss frequency is observable.
//
// Output: prints `baseline_path=<abs>`, `cache=hit|miss`, `resolved_sha=<sha>`
// and `distance=<n>` to GITHUB_OUTPUT when present, and always echoes a
// human-readable line to stdout. Never fails the build — a miss is a
// performance regression, not a correctness one.
//
// Usage:
//   node scripts/resolve-merge-base-baseline.mjs \
//     --baselines-dir /tmp/js2wasm-baselines \
//     --merge-base <sha> \                 # single candidate (back-compat)
//     [--candidates <sha0,sha1,sha2,...>] \# ordered, nearest-first (#3467)
//     [--test262-version <submodule-sha>] \
//     [--dest benchmarks/results/test262-current.jsonl]

import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = val;
    }
  }
  return args;
}

function emitOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${key}=${value}\n`);
}

/**
 * Decide whether the cached entry for `mergeBase` is usable.
 * Exported for unit testing.
 *
 * @returns {{ hit: boolean; reason: string }}
 */
export function evaluateCacheEntry(baselinesDir, mergeBase, currentTest262Version) {
  const jsonlPath = join(baselinesDir, "runs", `${mergeBase}.jsonl`);
  const jsonPath = join(baselinesDir, "runs", `${mergeBase}.json`);
  if (!mergeBase || !existsSync(jsonlPath)) {
    return { hit: false, reason: "no cache entry for merge-base" };
  }
  // Version guard: only honor the cache when the test262 corpus matches.
  if (currentTest262Version && existsSync(jsonPath)) {
    try {
      const meta = JSON.parse(readFileSync(jsonPath, "utf-8"));
      if (meta.test262_version && meta.test262_version !== currentTest262Version) {
        return {
          hit: false,
          reason: `cache test262_version ${meta.test262_version} != current ${currentTest262Version}`,
        };
      }
    } catch {
      return { hit: false, reason: "cache summary JSON unreadable" };
    }
  }
  return { hit: true, reason: "merge-base cache entry present and version-compatible" };
}

/**
 * #3467 — Walk an ORDERED candidate SHA list (base_sha first, then its
 * ancestors nearest-first) and return the first cached, version-compatible
 * entry. The index into the list IS the commit distance from the true base:
 * 0 = the exact merge base, N = the Nth ancestor (a cold-cache fallback).
 *
 * Pure + exported for unit testing — no filesystem writes, no process.exit.
 *
 * @param {string} baselinesDir           checkout of the baselines repo
 * @param {string[]} candidates           ordered SHAs, nearest-first
 * @param {string} currentTest262Version  submodule SHA to version-gate against
 * @returns {{ hit: boolean; sha: string; distance: number; reason: string }}
 */
export function resolveFromCandidates(baselinesDir, candidates, currentTest262Version) {
  const list = (candidates ?? []).filter((s) => typeof s === "string" && s.length > 0);
  for (let i = 0; i < list.length; i++) {
    const { hit, reason } = evaluateCacheEntry(baselinesDir, list[i], currentTest262Version);
    if (hit) {
      return {
        hit: true,
        sha: list[i],
        distance: i,
        reason: i === 0 ? reason : `${reason} (nearest cached ancestor, ${i} commit(s) back from base)`,
      };
    }
  }
  return {
    hit: false,
    sha: "",
    distance: -1,
    reason: list.length === 0 ? "no candidate SHAs supplied" : `no cached entry among ${list.length} candidate(s)`,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselinesDir = args["baselines-dir"];
  const mergeBase = args["merge-base"] && args["merge-base"] !== "true" ? args["merge-base"] : "";
  const test262Version = args["test262-version"] && args["test262-version"] !== "true" ? args["test262-version"] : "";
  const dest = args.dest && args.dest !== "true" ? args.dest : "benchmarks/results/test262-current.jsonl";
  // #3467 — ordered, nearest-first candidate list (base_sha, then ancestors).
  // Falls back to the single --merge-base for backward compatibility.
  const candidates =
    args.candidates && args.candidates !== "true"
      ? args.candidates
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : mergeBase
        ? [mergeBase]
        : [];

  if (!baselinesDir) {
    console.error(
      "usage: resolve-merge-base-baseline.mjs --baselines-dir <dir> (--merge-base <sha> | --candidates <sha0,sha1,...>) [--test262-version <sha>] [--dest <path>]",
    );
    process.exit(2);
  }

  const { hit, sha, distance, reason } = resolveFromCandidates(baselinesDir, candidates, test262Version);

  if (hit) {
    const cached = join(baselinesDir, "runs", `${sha}.jsonl`);
    copyFileSync(cached, dest);
    if (distance === 0) {
      console.log(`#3467 base cache HIT: diffing against runs/${sha}.jsonl (exact merge base — ${reason}).`);
    } else {
      // A non-zero distance means the exact base was NOT cached; surface it as
      // a warning so cold-base frequency is observable in the logs.
      console.log(
        `::warning::#3467 base cache HIT at DISTANCE ${distance}: exact merge base ${candidates[0]} not cached; ` +
          `diffing against nearest cached ancestor runs/${sha}.jsonl (${reason}). Delta may include ${distance} intervening commit(s).`,
      );
    }
    emitOutput("cache", "hit");
    emitOutput("resolved_sha", sha);
    emitOutput("distance", String(distance));
    emitOutput("baseline_path", dest);
    return;
  }

  // Miss: leave whatever the prior fetch step already placed at `dest`
  // (test262-current.jsonl, the promoted snapshot). Warn so cache-miss
  // frequency is trackable.
  console.log(
    `::warning::#3467 base cache MISS (${reason}); falling back to the promoted latest-main snapshot. ` +
      `Drift attribution may be imprecise for this PR (base=${candidates[0] || "<none>"}).`,
  );
  emitOutput("cache", "miss");
  emitOutput("resolved_sha", "");
  emitOutput("distance", "-1");
  emitOutput("baseline_path", dest);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
