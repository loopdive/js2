#!/usr/bin/env node
// scripts/release.mjs — cut a release version in lockstep across the root
// package (@loopdive/js2) and the unscoped proxy (packages/js2wasm).
//
// Why this exists (loopdive/js2wasm#389): version tags here were cut as bare
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
//   2. Bump root + packages/js2wasm package.json to V and pin the proxy's
//      @loopdive/js2 dependency to V (no per-package commit/tag).
//   3. Make ONE commit `release: vV` with both package.jsons (+ lockfile if it
//      changed) and ONE annotated tag `vV` pointing at it.
//   4. It does NOT push — pushing the tag before the PR merges would fire
//      publish-npm.yml on un-reviewed code. See docs/releasing.md.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const releaseScriptPath = fileURLToPath(import.meta.url);
const __dirname = dirname(releaseScriptPath);
const repoRoot = resolve(__dirname, "..");
const proxyDir = join(repoRoot, "packages", "js2wasm");

function readVersion(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return pkg.version;
}

export function pinProxyDependency(pkg, version) {
  if (typeof pkg.dependencies?.["@loopdive/js2"] !== "string") {
    throw new Error('proxy package.json must depend on "@loopdive/js2"');
  }
  return {
    ...pkg,
    dependencies: {
      ...pkg.dependencies,
      "@loopdive/js2": version,
    },
  };
}

function setProxyDependency(dir, version) {
  const path = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify(pinProxyDependency(pkg, version), null, 2)}\n`);
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

// Which remote is the PUBLISHING repo? `origin` is NOT a safe default: in this
// project's agent worktrees (and any fork-based clone) `origin` is the FORK, so
// the script's old `git push origin <tag>` instruction tagged the fork — where
// publish-npm.yml never fires against the real package. The release then looks
// done while nothing ships. Resolve by URL, and say so when it isn't `origin`.
export function pickUpstreamRemote(remotesOutput) {
  const remotes = new Map();
  for (const line of remotesOutput.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)/);
    if (m) remotes.set(m[1], m[2]);
  }
  for (const [name, url] of remotes) {
    if (/[/:]loopdive\/js2(\.git)?$/.test(url)) {
      return {
        name,
        note:
          name === "origin"
            ? null
            : `the publishing remote here is '${name}' (${url}), NOT 'origin' ` +
              `(${remotes.get("origin") ?? "unset"}). Pushing the tag to 'origin' would tag a fork ` +
              `and publish nothing.`,
      };
    }
  }
  return {
    name: "origin",
    note: "could not identify a remote pointing at loopdive/js2wasm — VERIFY which remote publishes before pushing the tag.",
  };
}

function upstreamRemote() {
  try {
    return pickUpstreamRemote(git(["remote", "-v"]));
  } catch {
    return { name: "origin", note: "could not read git remotes — verify the publishing remote by hand." };
  }
}

// Draft release notes from the commit range, so the notes exist before the
// release PR is opened rather than being reconstructed afterwards. Merge
// commits carry the PR titles, which are the useful unit here (the project
// merges, never rebases). Written to docs/release-notes/<tag>.md and included
// in the release commit; edit before merging if the generated grouping is off.
export function groupReleaseLines(subjects) {
  const groups = { Features: [], Fixes: [], Other: [] };
  for (const s of subjects) {
    const title = s.replace(/^Merge pull request #\d+ from \S+\s*/, "").trim();
    if (!title || /^release: v/.test(title)) continue;
    if (/^(feat|perf)[(:]/.test(title)) groups.Features.push(title);
    else if (/^fix[(:]/.test(title)) groups.Fixes.push(title);
    else groups.Other.push(title);
  }
  return groups;
}

// A release range here is hundreds of subjects, and roughly a quarter of them
// are machinery: scheduled baseline/artifact refreshes the bots commit with
// `[skip ci]`, and the merge commits from keeping branches current. Listed
// verbatim they bury the handful of lines a reader actually wants, so the
// summary counts them and moves on.
//
// The filter is deliberately narrow — `chore(...)` AND `[skip ci]` together,
// never `[skip ci]` alone. Measured on this repo's history every `[skip ci]`
// subject was already a `chore(`, so the conjunction costs nothing today and
// keeps a human change that happens to carry the marker from vanishing.
function isAutomatedSubject(title) {
  if (/^Merge (branch|remote-tracking branch|origin\/)/.test(title)) return true;
  return /^chore[(:]/.test(title) && /\[skip ci\]/.test(title);
}

// Conventional-commit scope, when it names a subsystem. A third of this repo's
// subjects put the issue number in the scope slot instead (`fix(#4488): …`),
// which says nothing about where the change landed — those feed the issue
// count rather than the area breakdown.
function scopeOf(title) {
  const m = /^[a-z]+\(([^)]+)\)!?:/.exec(title);
  if (!m) return null;
  const scope = m[1].trim();
  return !scope || /^#\d+$/.test(scope) ? null : scope;
}

function countedList(pairs, limit) {
  const shown = pairs.slice(0, limit).map(([name, n]) => `${name} (${n})`);
  const rest = pairs.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, and ${rest} more` : shown.join(", ");
}

/**
 * Condense a commit range into the shape of the work, so the notes open with
 * what changed rather than with the first commit that happened to land.
 *
 * Pure by design: it takes subjects and returns data, so the wording can be
 * unit-tested without a git repo or a release.
 */
export function summarizeReleaseWork(subjects) {
  const groups = { Features: [], Fixes: [], Other: [] };
  const areas = new Map();
  const issues = new Set();
  let automated = 0;

  for (const s of subjects) {
    const title = s.replace(/^Merge pull request #\d+ from \S+\s*/, "").trim();
    if (!title || /^release: v/.test(title)) continue;
    if (isAutomatedSubject(title)) {
      automated++;
      continue;
    }

    if (/^(feat|perf)[(:]/.test(title)) groups.Features.push(title);
    else if (/^fix[(:]/.test(title)) groups.Fixes.push(title);
    else groups.Other.push(title);

    const scope = scopeOf(title);
    if (scope) areas.set(scope, (areas.get(scope) || 0) + 1);
    for (const ref of title.match(/#\d+/g) || []) issues.add(ref);
  }

  const counts = {
    features: groups.Features.length,
    fixes: groups.Fixes.length,
    other: groups.Other.length,
  };
  return {
    groups,
    counts,
    automated,
    total: counts.features + counts.fixes + counts.other,
    areas: [...areas.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    issues: [...issues].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
  };
}

/**
 * Render the summary as a short paragraph. Kept separate from the analysis so
 * the prose can change without touching what gets counted.
 */
export function renderReleaseSummary(summary) {
  if (summary.total === 0) {
    return summary.automated > 0
      ? `No human-authored changes in this range — ${summary.automated} automated baseline/artifact commits only.\n\n`
      : "No changes recorded in this range.\n\n";
  }

  const parts = [];
  if (summary.counts.features)
    parts.push(`${summary.counts.features} feature${summary.counts.features === 1 ? "" : "s"}`);
  if (summary.counts.fixes) parts.push(`${summary.counts.fixes} fix${summary.counts.fixes === 1 ? "" : "es"}`);
  if (summary.counts.other) parts.push(`${summary.counts.other} other change${summary.counts.other === 1 ? "" : "s"}`);

  let line = `**${summary.total} change${summary.total === 1 ? "" : "s"}** in this release`;
  if (parts.length > 1) line += ` — ${parts.join(", ")}`;
  line += ".";
  if (summary.areas.length) line += ` Most active areas: ${countedList(summary.areas, 5)}.`;
  if (summary.issues.length)
    line += ` ${summary.issues.length} issue${summary.issues.length === 1 ? "" : "s"} referenced.`;
  if (summary.automated) {
    line += ` ${summary.automated} automated baseline/artifact commit${summary.automated === 1 ? "" : "s"} omitted below.`;
  }
  return `## Summary\n\n${line}\n\n`;
}

// test262 conformance is this project's headline number, so a release note
// without it is missing the one figure readers look for. Best-effort by the
// same rule as the rest of the notes: a release must never fail over prose.
//
// The delta is only printed when BOTH endpoints were actually read. A shallow
// clone or a missing previous tag makes the baseline unreachable, and the
// honest output there is the current number plus a line saying the comparison
// could not be made — not a delta computed against a guess. An unattributable
// number in a release note outlives the release.
function readConformance(rev) {
  try {
    const raw = rev
      ? git(["show", `${rev}:benchmarks/results/test262-current.json`])
      : readFileSync(join(repoRoot, "benchmarks", "results", "test262-current.json"), "utf8");
    const { pass, total } = JSON.parse(raw).summary ?? {};
    return Number.isFinite(pass) && Number.isFinite(total) && total > 0 ? { pass, total } : null;
  } catch {
    return null;
  }
}

function conformanceSection(prevTag) {
  const now = readConformance(null);
  if (!now) return "";

  const pct = ((100 * now.pass) / now.total).toFixed(1);
  let line = `test262: **${now.pass.toLocaleString("en-US")} / ${now.total.toLocaleString("en-US")} (${pct}%)** passing.`;

  const before = readConformance(prevTag);
  if (before) {
    const delta = now.pass - before.pass;
    const sign = delta > 0 ? "+" : "";
    line +=
      delta === 0
        ? ` Unchanged since ${prevTag}.`
        : ` ${sign}${delta.toLocaleString("en-US")} since ${prevTag} (${before.pass.toLocaleString("en-US")}).`;
  } else {
    line += ` No comparison against ${prevTag} — its baseline was not readable from this clone.`;
  }
  return `## Conformance\n\n${line}\n\n`;
}

function writeReleaseNotes(target, tag, previousVersion) {
  const prevTag = `v${previousVersion}`;
  let subjects = [];
  try {
    const hasPrev = git(["tag", "--list", prevTag]).trim();
    const range = hasPrev ? `${prevTag}..HEAD` : "HEAD";
    subjects = git(["log", range, "--format=%s"]).split("\n").filter(Boolean);
  } catch {
    return null; // notes are a convenience; never fail a release over them
  }

  const summary = summarizeReleaseWork(subjects);
  const g = summary.groups;
  const section = (name, lines) => (lines.length ? `## ${name}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n\n` : "");
  const body =
    `# ${tag}\n\n` +
    `Lockstep release of \`@loopdive/js2\` and the \`js2wasm\` proxy: ` +
    `${previousVersion} → ${target}.\n\n` +
    renderReleaseSummary(summary) +
    conformanceSection(prevTag) +
    section("Features", g.Features) +
    section("Fixes", g.Fixes) +
    section("Other", g.Other) +
    `<!-- Drafted by scripts/release.mjs from ${prevTag}..HEAD. The summary counts ` +
    `commits; it does not read the diff, so it describes VOLUME, not significance. ` +
    `Lead with what actually matters and cut the rest — the grouped lists below are ` +
    `raw material, not the announcement. -->\n`;

  const notesDir = join(repoRoot, "docs", "release-notes");
  const notesPath = join(notesDir, `${tag}.md`);
  try {
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(notesPath, body);
    git(["add", notesPath]);
    git(["commit", "--amend", "--no-edit", "--no-verify"]);
    git(["tag", "-f", "-a", tag, "-m", tag]); // re-point the tag at the amended commit
    return `docs/release-notes/${tag}.md`;
  } catch {
    return null;
  }
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
  setProxyDependency(proxyDir, target);

  // Bump the JSR manifest (jsr.json) in lockstep too. It carries its OWN
  // "version" field that pnpm/setVersion never touches — so without this,
  // `deno publish` reads the stale version and silently skips with
  // "already published" (exit 0), freezing JSR at an old release. (loopdive/js2wasm#389)
  const jsrPath = join(repoRoot, "jsr.json");
  const jsr = JSON.parse(readFileSync(jsrPath, "utf8"));
  jsr.version = target;
  writeFileSync(jsrPath, `${JSON.stringify(jsr, null, 2)}\n`);

  // Assert both ended up identical — guards against pnpm version surprises.
  const newRoot = readVersion(repoRoot);
  const newProxy = readVersion(proxyDir);
  const proxyPkg = JSON.parse(readFileSync(join(proxyDir, "package.json"), "utf8"));
  const newProxyDependency = proxyPkg.dependencies?.["@loopdive/js2"];
  if (newRoot !== target || newProxy !== target || newProxyDependency !== target) {
    fail(
      `lockstep bump failed: root=${newRoot} proxy=${newProxy} ` +
        `proxy dependency=${newProxyDependency} expected=${target}`,
    );
  }

  console.log(
    `\nBumped both packages to ${target}:\n` +
      `  - package.json (@loopdive/js2)            → ${newRoot}\n` +
      `  - packages/js2wasm/package.json (proxy)   → ${newProxy}\n` +
      `  - proxy dependency on @loopdive/js2       → ${newProxyDependency}\n`,
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

  const notesPath = writeReleaseNotes(target, tag, currentRoot);
  if (notesPath) console.log(`Release notes drafted: ${notesPath}\n`);

  const upstream = upstreamRemote();
  console.log("NEXT STEPS:");
  console.log(`  1) Push the BRANCH normally and open a 'release: ${tag}' PR — do NOT push the tag yet.`);
  console.log(`  2) ⚠️  Do NOT 'git push --tags' / '--follow-tags' before merge — publish-npm.yml`);
  console.log(`     fires on ANY v<x.y.z> push and would publish un-reviewed code.`);
  console.log(`  3) After the PR merges, VERIFY before tagging — a squash/rebase would leave the`);
  console.log(`     tagged commit off main and the tag would point at an orphan:`);
  console.log(`       git fetch ${upstream.name} main`);
  console.log(`       git merge-base --is-ancestor ${tag}^{commit} FETCH_HEAD && echo IN-MAIN`);
  console.log(`  4) Then push the tag to trigger publish:`);
  console.log(`       git push --no-verify ${upstream.name} refs/tags/${tag}:refs/tags/${tag}`);
  console.log(`       git ls-remote --tags ${upstream.name} refs/tags/${tag}   # verify it LANDED`);
  console.log(`     publish-npm.yml's verify-version job confirms the tag, manifests,`);
  console.log(`     and proxy dependency all match before publishing. See docs/releasing.md.`);
  if (notesPath) {
    console.log(`  5) Publish the notes onto the GitHub Release (publish-npm.yml creates it with`);
    console.log(`     --generate-notes, i.e. a raw commit list — replace that with the real notes):`);
    console.log(`       gh release edit ${tag} -R loopdive/js2wasm --notes-file ${notesPath}`);
    console.log(`       gh release view ${tag} -R loopdive/js2wasm --json body   # verify it landed`);
    console.log(`     ('edit', not 'create' — the release already exists by then.)`);
  }
  if (upstream.note) console.log(`\n  ⚠️  ${upstream.note}`);
}

if (resolve(process.argv[1] || "") === releaseScriptPath) {
  main();
}
