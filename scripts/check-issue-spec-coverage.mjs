#!/usr/bin/env node
// check-issue-spec-coverage.mjs — force a bugfix issue's repro into the
// permanent test suite (#2093).
//
// PROBLEM: nothing made a bugfix issue carry its repro into a permanent test.
// The June 2026 fix wave added `tests/issue-NNNN.test.ts` files by CONVENTION
// only, so the next sweep's bugs would again ship with no armor.
//
// THIS GATE (wired into the required `quality` job): for issue files CHANGED in
// the current PR/commit whose `created` date is on/after the cutoff:
//   • flipping to `status: done` with NO probe/test reference → HARD FAIL
//   • sitting at `status: ready` with NO probe/test reference → WARNING only
// A "probe/test reference" is satisfied if EITHER:
//   (a) a `tests/issue-<id>.test.ts` (or `-<id>-…`) file exists in the tree, OR
//   (b) the issue body cites a `tests/…test…(.ts|.mjs|.js)` path or a
//       `test262/…` path (a conformance repro is a permanent reference too).
//
// Cutoff (`created >= 2026-06-15`) keeps the gate off the pre-existing backlog —
// no retroactive noise. Infra/tooling/docs issues are exempt (they have no
// runtime repro); only behavioural task_types are gated.
//
// Usage:
//   node scripts/check-issue-spec-coverage.mjs            # gate (CI)
//   node scripts/check-issue-spec-coverage.mjs --all      # scan every issue, ignore diff
//   node scripts/check-issue-spec-coverage.mjs --base REF # diff against REF (default: origin/main)
//   node scripts/check-issue-spec-coverage.mjs --json
//
// Safe by construction: if the diff base can't be resolved it falls back to
// scanning only files that differ from HEAD^ (push) or, failing that, exits 0
// with a note — it never blocks a build it can't reason about.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SCAN_ALL = has("--all");
const JSON_OUT = has("--json");
const BASE_REF = opt("--base", process.env.ISSUE_COVERAGE_BASE || "origin/main");

const REPO = process.env.REPO_ROOT || process.cwd();
const ISSUES_DIR = join(REPO, "plan", "issues");
const TESTS_DIR = join(REPO, "tests");

// Issues created on/after this date are gated; older ones are grandfathered.
const CUTOFF = process.env.ISSUE_COVERAGE_CUTOFF || "2026-06-15";

// task_types that describe a behavioural change with a runnable repro. Infra/
// tooling/docs/process issues have no compiler repro, so they're exempt.
const GATED_TASK_TYPES = new Set(["bug", "bugfix", "fix", "feature", "conformance", "codegen", "runtime"]);

// A body reference that counts as a permanent test/probe anchor.
const TEST_REF_RE = /tests\/[\w./-]*test[\w./-]*\.(?:ts|mjs|js)|test262\/[\w./-]+\.js/i;

function log(s) {
  if (!JSON_OUT) console.log(s);
}

function frontmatter(text) {
  const out = {};
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function issueIdFromFile(f) {
  const m = f.match(/^(\d+[a-z]?)-.+\.md$/i);
  return m ? m[1].toLowerCase() : null;
}

// Does a permanent test/probe reference exist for this issue id?
function hasProbe(id, body) {
  // (a) a tests/issue-<id>*.test.ts file on disk
  if (existsSync(TESTS_DIR)) {
    const re = new RegExp(`^issue-${id}(?:[^0-9].*)?\\.test\\.(?:ts|mjs|js)$`, "i");
    for (const f of readdirSync(TESTS_DIR)) {
      if (re.test(f)) return true;
    }
  }
  // (b) the issue body cites a test/probe path (any tests/*test* or test262/*).
  return TEST_REF_RE.test(body || "");
}

// Which issue files changed vs the base? Returns null when we can't resolve a
// diff (caller falls back to scanning HEAD^, then to a clean exit).
function changedIssueFiles() {
  if (SCAN_ALL) return null;
  for (const ref of [BASE_REF, "HEAD^"]) {
    try {
      const out = execSync(`git diff --name-only --diff-filter=ACM ${ref}...HEAD -- plan/issues`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        cwd: REPO,
      });
      const files = out
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => /^plan\/issues\/\d+[a-z]?-.+\.md$/i.test(s));
      return files.map((f) => f.replace(/^plan\/issues\//, ""));
    } catch {
      // try next ref
    }
  }
  return null;
}

function allIssueFiles() {
  if (!existsSync(ISSUES_DIR)) return [];
  return readdirSync(ISSUES_DIR).filter((f) => /^\d+[a-z]?-.+\.md$/i.test(f));
}

function main() {
  if (!existsSync(ISSUES_DIR)) {
    log("check-issue-spec-coverage: no plan/issues dir — nothing to check.");
    if (JSON_OUT) console.log(JSON.stringify({ failures: [], warnings: [], skipped: "no issues dir" }));
    process.exit(0);
  }

  let files = changedIssueFiles();
  let scope;
  if (files === null) {
    if (SCAN_ALL) {
      files = allIssueFiles();
      scope = "all issues (--all)";
    } else {
      log("check-issue-spec-coverage: could not resolve a diff base — skipping (no build block).");
      if (JSON_OUT) console.log(JSON.stringify({ failures: [], warnings: [], skipped: "no diff base" }));
      process.exit(0);
    }
  } else {
    scope = `${files.length} changed issue file(s) vs ${BASE_REF}`;
  }

  const failures = [];
  const warnings = [];

  for (const f of files) {
    const id = issueIdFromFile(f);
    if (!id) continue;
    const path = join(ISSUES_DIR, f);
    if (!existsSync(path)) continue; // deleted in the diff
    const text = readFileSync(path, "utf8");
    const fm = frontmatter(text);
    const status = (fm.status || "").toLowerCase();
    const created = fm.created || "";
    const taskType = (fm.task_type || "").toLowerCase();

    // Cutoff: only gate issues created on/after the cutoff date.
    if (!created || created < CUTOFF) continue;
    // Exempt non-behavioural task types (infra/tooling/docs/process).
    if (taskType && !GATED_TASK_TYPES.has(taskType)) continue;

    if (status !== "done" && status !== "ready") continue;
    if (hasProbe(id, text)) continue;

    const entry = { id, file: f, status, created, taskType: taskType || "(unset)" };
    if (status === "done") failures.push(entry);
    else warnings.push(entry);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ scope, failures, warnings }, null, 2));
  } else {
    log(`check-issue-spec-coverage (#2093): ${scope}; cutoff created>=${CUTOFF}.`);
    for (const w of warnings) {
      log(`  ⚠ WARNING  #${w.id} [${w.status}] has no probe/test reference (created ${w.created}).`);
    }
    for (const e of failures) {
      log(`  ✖ FAIL     #${e.id} flipped to done with NO probe/test reference (created ${e.created}).`);
    }
    if (failures.length) {
      log(
        `\nAdd a permanent repro before flipping to done: a tests/issue-${failures[0].id}.test.ts ` +
          `(or cite a tests/…test… / test262/… path in the issue body). See #2093.`,
      );
    } else {
      log(`  ✓ all gated done-flips carry a probe/test reference.`);
    }
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main();
