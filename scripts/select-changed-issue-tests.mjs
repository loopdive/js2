#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4448) Print the `tests/issue-*.test.ts` files a PR should run.
//
// WHY THIS EXISTS: none of the six required checks executes that suite —
// `equivalence-gate` runs `tests/equivalence/` only, `quality` runs
// lint/ratchets/named files, the test262 jobs run conformance, `linear-tests`
// runs the linear subset. So an issue test file can be BORN red (#4430's was)
// or go red later (`6203320a` did, silently, for two days) with every gate
// green. Running the whole suite on every PR is too slow to be worth it, so the
// cheap 90 % is: run the files the PR itself touches, plus a tiny pinned set.
//
// Deliberately NOT a required check — see docs/ci-policy.md §7. A changed issue
// test may be red for reasons the PR is not responsible for (the suite is not
// clean on main today), so this reports rather than blocks.
//
// Usage:
//   node scripts/select-changed-issue-tests.mjs --pinned  [--max <n>]
//   node scripts/select-changed-issue-tests.mjs --changed [--base <sha>] [--max <n>]
//
// The two modes exist because they carry different authority. `--pinned` lists
// files verified green on main, so a failure there is a genuine regression and
// its CI step is FATAL. `--changed` lists whatever the PR touched, whose health
// on main is unknown, so its step is ADVISORY — a red non-required check drives
// `mergeStateStatus` to UNSTABLE, which `auto-enqueue` skips outright
// (#3878/#3904), and stranding a PR behind a test that was already red is a
// worse failure than the one this job exists to catch.
//
// Prints one path per line on stdout (empty output = nothing to run).
// Diagnostics go to stderr so stdout stays pipe-safe.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// Pinned files run on EVERY code PR regardless of what changed. Keep this list
// short (it is pure wall-clock on every PR) and green on main — a red pin makes
// the job noise. Each entry names why it is worth the seconds.
const PINNED = [
  // #4448: the selector preclaim/claim-safety surface. Its 4 reds (2 of them a
  // real over-claim: local-class identity leaking through a parameter/local
  // shadow) sat invisible for two days precisely because nothing ran it.
  "tests/issue-3529-selector-preclaim.test.ts",
];

const ISSUE_TEST = /^tests\/issue-[^/]*\.test\.ts$/;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function resolveBase() {
  const explicit = arg("--base");
  if (explicit) return explicit;
  for (const candidate of [process.env.PR_BASE_SHA, process.env.MERGE_GROUP_BASE_SHA]) {
    if (candidate) return candidate;
  }
  try {
    return git(["merge-base", "origin/main", "HEAD"]).trim();
  } catch {
    return "HEAD^";
  }
}

const wantPinned = process.argv.includes("--pinned");
const wantChanged = process.argv.includes("--changed");
if (wantPinned === wantChanged) {
  process.stderr.write("select-changed-issue-tests: pass exactly one of --pinned / --changed\n");
  process.exit(2);
}

if (wantPinned) {
  const files = PINNED.filter((file) => existsSync(file));
  process.stderr.write(`select-changed-issue-tests: pinned=${files.length}\n`);
  if (files.length > 0) process.stdout.write(`${files.join("\n")}\n`);
  process.exit(0);
}

const base = resolveBase();
let changed = [];
try {
  // --diff-filter=d drops deletions: a removed test file cannot be run.
  changed = git(["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => ISSUE_TEST.test(line));
} catch (error) {
  // No usable base (shallow clone, unrelated histories) — fall back to the
  // pinned set rather than failing the job on a git detail.
  process.stderr.write(`select-changed-issue-tests: diff against ${base} failed (${error.message}); nothing changed\n`);
}

const max = Number(arg("--max") ?? 15);
// Pinned files already run in the fatal step; do not pay for them twice.
const selected = [...new Set(changed)].filter((file) => existsSync(file) && !PINNED.includes(file)).sort();
const capped = selected.slice(0, max);

process.stderr.write(
  `select-changed-issue-tests: base=${base} changed=${changed.length} running=${capped.length}` +
    (selected.length > capped.length ? ` (capped from ${selected.length}, --max ${max})` : "") +
    "\n",
);
if (capped.length > 0) process.stdout.write(`${capped.join("\n")}\n`);
