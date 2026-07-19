#!/usr/bin/env node
// scripts/release.mjs — cut a release version in lockstep across the root
// package (@loopdive/js2) and the unscoped proxy (packages/js2wasm).
//
// Why this exists (loopdive/js2#389): version tags here were cut as bare
// lightweight `git tag vX.Y.Z` that never touched package.json. publish-npm.yml
// triggers on a `v*` tag push and publishes whatever version package.json
// carries at that commit — so the field stayed stuck at 0.52.0 for thousands of
// commits and anyone building from the clone read a stale version. This script
// makes the version bump an explicit, reviewable step that updates BOTH
// packages to the same concrete version, so the tag can never disagree with the
// published version (publish-npm.yml's verify-version job enforces that match).
//
// Usage:
//   node scripts/release.mjs <x.y.z | patch | minor | major>
//
// What it does (the plain `pnpm version` experience, but covering BOTH packages
// in a single commit + tag):
//   1. Resolve a concrete target version V.
//   2. Bump root + packages/js2wasm package.json to V (no per-package commit/tag).
//   3. Make ONE commit `release: vV` with both package.jsons (+ lockfile if it
//      changed) and ONE annotated tag `vV` pointing at it.
//   4. It does NOT push — pushing the tag before the PR merges would fire
//      publish-npm.yml on un-reviewed code. See docs/releasing.md.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const proxyDir = join(repoRoot, "packages", "js2wasm");

function readVersion(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return pkg.version;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...opts,
  });
}

// Resolve a bump keyword (patch|minor|major) or an explicit x.y.z to a single
// concrete version string. Computing the explicit version up front and applying
// the SAME string to both packages guarantees they can't diverge (running a
// bump keyword independently in each package would silently drift if they ever
// started at different versions).
function resolveTargetVersion(arg, currentVersion) {
  const explicit = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
  if (explicit.test(arg)) return arg;

  const m = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) fail(`current root version "${currentVersion}" is not a valid x.y.z`);
  let [major, minor, patch] = m.slice(1).map(Number);

  switch (arg) {
    case "major":
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case "minor":
      minor += 1;
      patch = 0;
      break;
    case "patch":
      patch += 1;
      break;
    default:
      fail(`invalid argument "${arg}" — expected an explicit version (x.y.z) or a bump keyword (patch|minor|major)`);
  }
  return `${major}.${minor}.${patch}`;
}

function setVersion(dir, version) {
  // pnpm version --no-git-tag-version edits package.json .version only (no
  // per-package commit or tag). We pass the explicit resolved version so both
  // packages get exactly the same string; the script makes the single
  // commit + tag itself afterward.
  execFileSync("pnpm", ["version", "--no-git-tag-version", version], {
    cwd: dir,
    stdio: "inherit",
  });
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    fail("usage: node scripts/release.mjs <x.y.z | patch | minor | major>");
  }

  // Refuse to run on a dirty tree — the release commit must contain ONLY the
  // version bump (+ lockfile), not whatever else is staged/modified.
  const dirty = git(["status", "--porcelain"]).trim();
  if (dirty) {
    fail(
      "working tree is not clean. Commit or stash your changes first so the " +
        `release commit contains only the version bump.\n${dirty}`,
    );
  }

  const currentRoot = readVersion(repoRoot);
  const target = resolveTargetVersion(arg, currentRoot);
  const tag = `v${target}`;

  // Refuse if the tag already exists locally — avoids clobbering a prior cut.
  const existingTags = git(["tag", "--list", tag]).trim();
  if (existingTags) {
    fail(`tag ${tag} already exists. Delete it first if you mean to re-cut.`);
  }

  console.log(`Current root version: ${currentRoot}`);
  console.log(`Target version (lockstep): ${target}\n`);

  setVersion(repoRoot, target);
  setVersion(proxyDir, target);

  // Bump the JSR manifest (jsr.json) in lockstep too. It carries its OWN
  // "version" field that pnpm/setVersion never touches — so without this,
  // `deno publish` reads the stale version and silently skips with
  // "already published" (exit 0), freezing JSR at an old release. (loopdive/js2#389)
  const jsrPath = join(repoRoot, "jsr.json");
  const jsr = JSON.parse(readFileSync(jsrPath, "utf8"));
  jsr.version = target;
  writeFileSync(jsrPath, `${JSON.stringify(jsr, null, 2)}\n`);

  // Assert both ended up identical — guards against pnpm version surprises.
  const newRoot = readVersion(repoRoot);
  const newProxy = readVersion(proxyDir);
  if (newRoot !== target || newProxy !== target) {
    fail(`lockstep bump failed: root=${newRoot} proxy=${newProxy} expected=${target}`);
  }

  console.log(
    `\nBumped both packages to ${target}:\n` +
      `  - package.json (@loopdive/js2)            → ${newRoot}\n` +
      `  - packages/js2wasm/package.json (proxy)   → ${newProxy}\n`,
  );

  // Stage exactly the files the bump touches: both package.jsons plus the
  // lockfile if pnpm version regenerated it. Using explicit paths (never
  // `git add -A`) keeps the release commit minimal.
  const toStage = ["package.json", "packages/js2wasm/package.json", "jsr.json"];
  if (git(["status", "--porcelain", "pnpm-lock.yaml"]).trim()) {
    toStage.push("pnpm-lock.yaml");
  }
  git(["add", ...toStage]);
  git(["commit", "-m", `release: ${tag}`]);
  git(["tag", "-a", tag, "-m", tag]);

  const commitSha = git(["rev-parse", "HEAD"]).trim();
  console.log(`Created release commit ${commitSha.slice(0, 9)} and tag ${tag}.\n`);

  console.log("NEXT STEPS:");
  console.log(`  1) Push the BRANCH normally and open a 'release: ${tag}' PR — do NOT push the tag yet.`);
  console.log(`  2) ⚠️  Do NOT 'git push --tags' / '--follow-tags' before merge — publish-npm.yml`);
  console.log(`     fires on ANY v<x.y.z> push and would publish un-reviewed code.`);
  console.log(`  3) After the PR merges (the merge commit keeps your tagged commit in main's`);
  console.log(
    `     history), push the tag to trigger publish:\n` +
      `       git push origin ${tag}\n` +
      `     publish-npm.yml's verify-version job confirms tag == both package.json`,
  );
  console.log(`     versions before publishing. See docs/releasing.md.`);
}

main();
