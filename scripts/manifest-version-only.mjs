#!/usr/bin/env node
// manifest-version-only.mjs — drop VERSION-ONLY manifest edits from a changed-
// path list before it is classified by `scripts/test262-paths-match.sh`.
//
// WHY. `package.json` is on the `&test262-paths` allowlist in
// test262-sharded.yml, and it belongs there: a dependency bump genuinely can
// move conformance. But `node scripts/release.mjs <x.y.z>` touches
// `package.json` too, and a version bump provably cannot. So every release PR
// pulls in the full ~19-minute merge_group shard matrix for a one-line diff —
// measured on PR #4317 (v0.69.0), which ran the whole matrix with no source
// change at all.
//
// SCOPE, DELIBERATELY NARROW. This does NOT mean "skip when src/ is untouched".
// The path allowlist is a curated set of things that affect test262 results and
// several are outside `src/` (`scripts/test262-worker.mjs`,
// `tests/test262-runner.ts`, the slow-test weight maps that change shard
// assignment). Broadening the rule would silently disarm a conformance gate,
// which is far worse than a wasted matrix run. The ONLY thing dropped here is a
// manifest whose diff is provably confined to the keys `release.mjs` moves.
//
// FAIL-SAFE. The matcher's contract is "if detection is in any way uncertain →
// run_shards=true". Every uncertainty here KEEPS the path, which keeps the
// matrix: unparseable JSON on either side, a missing blob, a git failure, a
// path not in the table, an unexpected exception. A path is dropped only on a
// POSITIVE proof that nothing outside the allowed keys differs.
//
// Usage (mirrors test262-paths-match.sh: paths on stdin, result on stdout):
//
//   printf '%s\n' package.json src/x.ts \
//     | node scripts/manifest-version-only.mjs --base <sha> --head <sha>
//
// Prints the FILTERED path list on stdout, one per line. Diagnostics go to
// stderr so stdout stays pipeable straight into the matcher.
//
// EXIT CODE IS LOAD-BEARING, unlike the matcher's. An empty stdout is a LEGAL
// success here ("every changed path was a version-only manifest"), so it cannot
// also mean "the script died". Exit 0 ⇒ trust stdout. Exit non-zero ⇒ the
// caller MUST fall back to its own unfiltered list; stdin is already consumed
// by then, so this script cannot echo it back itself.

import { execFileSync } from "node:child_process";

/**
 * Keys that `scripts/release.mjs` is allowed to move in each manifest, as
 * key PATHS from the document root. Anything else differing — a dependency
 * add/remove/bump, a script change, an `engines` change — keeps the file and
 * therefore keeps the matrix.
 *
 * `release.mjs <x.y.z>` writes exactly: package.json, packages/js2wasm/
 * package.json, jsr.json, docs/release-notes/vX.Y.Z.md. It does NOT touch
 * pnpm-lock.yaml. Of these only `package.json` is currently on the
 * `&test262-paths` allowlist, so only it can actually reach this filter; the
 * other two are listed so the table stays correct if the allowlist grows, and
 * because they document release.mjs's contract in one place.
 *
 * `packages/js2wasm/package.json` carries a second moved key: its pinned
 * dependency on the canonical package, which release.mjs bumps in lockstep.
 */
export const RELEASE_MOVED_KEYS = new Map([
  ["package.json", [["version"]]],
  ["packages/js2wasm/package.json", [["version"], ["dependencies", "@loopdive/js2"]]],
  ["jsr.json", [["version"]]],
]);

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Collect the key paths at which two parsed JSON documents differ, including
 * keys added on one side only. Arrays are compared as whole values: reordering
 * or editing `keywords`/`files` is a difference at the array's own path, which
 * is never in the allowlist and therefore keeps the file.
 */
export function differingKeyPaths(before, after, prefix = []) {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) => differingKeyPaths(before[k], after[k], [...prefix, k]));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

/**
 * Is this manifest change provably confined to the keys a release bump moves?
 *
 * Returns `{ versionOnly, reason }`. `versionOnly: true` is a positive proof
 * and is the ONLY value that drops a path; every other outcome keeps it.
 */
export function classifyManifestChange({ path, before, after }) {
  const allowed = RELEASE_MOVED_KEYS.get(path);
  if (!allowed) return { versionOnly: false, reason: "not-a-release-manifest" };
  if (typeof before !== "string" || typeof after !== "string") {
    return { versionOnly: false, reason: "blob-unavailable" };
  }

  let parsedBefore;
  let parsedAfter;
  try {
    parsedBefore = JSON.parse(before);
    parsedAfter = JSON.parse(after);
  } catch {
    // Includes the added/deleted-file cases, where one side is empty.
    return { versionOnly: false, reason: "unparseable-json" };
  }
  if (!isPlainObject(parsedBefore) || !isPlainObject(parsedAfter)) {
    return { versionOnly: false, reason: "not-a-json-object" };
  }

  const allowedSet = new Set(allowed.map((k) => JSON.stringify(k)));
  const differing = differingKeyPaths(parsedBefore, parsedAfter);
  const disallowed = differing.filter((k) => !allowedSet.has(JSON.stringify(k)));
  if (disallowed.length > 0) {
    return { versionOnly: false, reason: `changed:${disallowed.map((k) => k.join(".")).join(",")}` };
  }
  // Zero differences means the file is in `--name-only` for a non-content
  // reason (a mode change); identical content cannot move conformance either.
  return { versionOnly: true, reason: differing.length === 0 ? "no-key-differences" : "version-only" };
}

/** `git show <rev>:<path>`, or `null` when the blob cannot be read. */
function readBlob(rev, path) {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { base: "", head: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") args.base = argv[++i] ?? "";
    else if (argv[i] === "--head") args.head = argv[++i] ?? "";
    else if (argv[i].startsWith("--base=")) args.base = argv[i].slice("--base=".length);
    else if (argv[i].startsWith("--head=")) args.head = argv[i].slice("--head=".length);
  }
  return args;
}

async function main() {
  const { base, head } = parseArgs(process.argv.slice(2));
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const paths = chunks
    .join("")
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean);

  if (!base || !head) {
    console.error("manifest-version-only: --base/--head missing; keeping every path (fail-safe).");
    process.stdout.write(`${paths.join("\n")}\n`);
    return;
  }

  const kept = paths.filter((path) => {
    if (!RELEASE_MOVED_KEYS.has(path)) return true;
    const verdict = classifyManifestChange({
      path,
      before: readBlob(base, path),
      after: readBlob(head, path),
    });
    console.error(
      verdict.versionOnly
        ? `manifest-version-only: DROP ${path} (${verdict.reason}) — cannot move test262 results.`
        : `manifest-version-only: KEEP ${path} (${verdict.reason}).`,
    );
    return !verdict.versionOnly;
  });

  process.stdout.write(kept.length > 0 ? `${kept.join("\n")}\n` : "");
}

// Importable for tests; the CLI only runs when executed directly.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // An unexpected failure must never SHRINK the path list.
    console.error(`manifest-version-only: ${err?.message ?? err} — keeping every path (fail-safe).`);
    process.exitCode = 1;
  });
}
