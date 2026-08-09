// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3552 — Required per-PR guard suite runner.
//
// Runs the curated invariant-guard tests listed in tests/guard-suite.json in
// one single-fork vitest invocation. Wired into the required `quality` job
// (ci.yml) so these tests gate every pull_request AND every merge_group —
// closing the #3503/#3551 gap where a PR silently regressed an UNTOUCHED
// root test (green PR, red main; the #3008 per-PR gate only runs PR-touched
// test files, and the post-merge issue-tests.yml detector detects without
// enforcing).
//
// Local use: `pnpm run test:guard`.
//
// The manifest is the policy surface — entry criteria live in its $comment.
// A listed file that does not exist fails loudly: deleting or renaming a
// guard test must be a deliberate manifest edit, never silent shrinkage.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "tests", "guard-suite.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const entries = Array.isArray(manifest.files) ? manifest.files : [];
if (entries.length === 0) {
  console.error(`guard-suite (#3552): ${manifestPath} lists no files — refusing to vacuously pass.`);
  process.exit(1);
}

const files = entries.map((entry) => (typeof entry === "string" ? entry : entry.path));
const missing = files.filter((file) => !existsSync(join(repoRoot, file)));
if (missing.length > 0) {
  console.error(
    `guard-suite (#3552): manifest entries do not exist on disk:\n` +
      missing.map((file) => `  - ${file}`).join("\n") +
      `\nRemoving a guard test must be a deliberate edit to tests/guard-suite.json.`,
  );
  process.exit(1);
}

console.log(`guard-suite (#3552): running ${files.length} guard file(s):`);
for (const entry of entries) {
  const path = typeof entry === "string" ? entry : entry.path;
  const guards = typeof entry === "string" ? "" : ` — guards: ${entry.guards}`;
  console.log(`  - ${path}${guards}`);
}

// Single fork + no file parallelism: matches the #3008 per-PR gate's settings
// so guard files with large compiler graphs don't defeat the bounded fork.
const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", ...files, "--pool=forks", "--poolOptions.forks.singleFork=true", "--no-file-parallelism"],
  { cwd: repoRoot, stdio: "inherit" },
);

if (result.status !== 0) {
  console.error(
    `\nguard-suite (#3552): FAILED. These are invariant-guard tests for surfaces` +
      ` with prior silent main regressions — fix the regression on your branch;` +
      ` do not weaken or delist the test (see tests/guard-suite.json).`,
  );
}
process.exit(result.status ?? 1);
