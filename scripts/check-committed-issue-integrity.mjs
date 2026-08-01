#!/usr/bin/env node
// Check issue metadata from a committed git tree, independent of the working tree.
//
// PERFORMANCE (#3964) — read every blob with ONE `git cat-file --batch`.
// ---------------------------------------------------------------------
// This gate used to call `git show <ref>:<file>` once per issue file. With
// ~3,500 files under plan/issues/ that is ~3,500 subprocess spawns, paid
// SERIALLY on every single `git push` (the .husky/pre-push hook runs this at
// step 5b). It was not deadlocked — it was just paying spawn + object-lookup
// cost thousands of times, at ~0% CPU, which is why "wait it out" never
// worked and why the cost grows every time we file an issue.
//
// The file LIST already came from a single `git ls-tree`. Now the file
// CONTENT does too: one `git cat-file --batch` fed every `<ref>:<path>` on
// stdin. Same reads, same verdict, one process.
//
// Reading the batch stream correctly is load-bearing, so note two details:
//   * Bodies are delimited by the BYTE COUNT in the header, never by scanning
//     for newlines — issue files contain lines that look exactly like a
//     `<oid> blob <size>` header, and line-splitting would corrupt them.
//   * A `<name> missing` response is a HARD ERROR, not a skip. The input list
//     comes from `ls-tree` on the same ref, so a missing object means the
//     reader is broken; silently skipping would let a broken reader report a
//     clean tree (see the FALSE-GREEN FLOOR note on `withFrontmatter` below).

import { execFileSync, spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";

const argv = process.argv.slice(2);
const emitJson = argv.includes("--json");
const ref = argv.find((a) => !a.startsWith("--")) || "HEAD";

const NON_ISSUE_BASENAMES = new Set([
  "1034-report.md",
  "82-findings.md",
  "1578-test262-analysis.md",
  "backlog.md",
  "index.md",
  "log.md",
  "analysis-2026-03-25.md",
  "sprint-1.md",
  "sprint-2.md",
  "sprint-3.md",
]);

const EXPLICIT_ISSUE_BASENAMES = new Set(["512-illegal-cast-closures.md"]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function isIssueFile(file) {
  const name = basename(file);
  if (NON_ISSUE_BASENAMES.has(name)) return false;
  if (EXPLICIT_ISSUE_BASENAMES.has(name)) return true;
  // Frozen `<N>.md` and pre-freeze `<N>-<slug>.md` (e.g. `73-plan.md`) sprint
  // docs are planning artifacts, not issues — else `73-plan.md` collides with #73.
  if (dirname(file) === "plan/issues/sprints" && /^\d+(?:-[\w-]+)?\.md$/.test(name)) return false;
  return /^\d+[a-z]?(?:[-_].+)?\.md$/i.test(name);
}

function filenameIssueId(file) {
  return (
    basename(file)
      .match(/^(\d+[a-z]?)/i)?.[1]
      .toLowerCase() || ""
  );
}

function frontmatter(text) {
  return text.match(/^---\n([\s\S]*?)\n---\n?/)?.[1] || "";
}

function readScalar(fm, key) {
  const line = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim() || "";
  return line.replace(/^["']|["']$/g, "").trim();
}

function readInlineArray(fm, key) {
  const raw = readScalar(fm, key);
  const match = raw.match(/^\[(.*)\]$/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase(),
    )
    .filter(Boolean);
}

// Read every requested path in ONE `git cat-file --batch`. Returns a
// Map<file, contents>. Throws on any unreadable object — never returns a
// partial map, because a partial map reads downstream as a clean tree.
function batchReadBlobs(treeish, paths) {
  if (paths.length === 0) return new Map();

  // `--batch` takes one object name per LINE, so a path containing a newline
  // would desynchronise the whole stream. `ls-tree -z` gives us raw
  // (unquoted) paths, so check explicitly rather than trusting the shape.
  const bad = paths.find((p) => p.includes("\n"));
  if (bad !== undefined) {
    throw new Error(`issue path contains a newline, cannot batch-read: ${JSON.stringify(bad)}`);
  }

  const input = paths.map((p) => `${treeish}:${p}\n`).join("");
  const res = spawnSync("git", ["cat-file", "--batch"], {
    input,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git cat-file --batch exited ${res.status}: ${res.stderr?.toString().trim()}`);
  }

  const buf = res.stdout;
  const out = new Map();
  let off = 0;
  for (const path of paths) {
    const nl = buf.indexOf(0x0a, off);
    if (nl === -1) {
      throw new Error(`git cat-file --batch output ended early while reading ${path}`);
    }
    const header = buf.toString("utf8", off, nl);
    off = nl + 1;
    // Found: "<oid> <type> <size>". Absent: "<name> missing" / "<name> ambiguous".
    const m = header.match(/^[0-9a-f]{40,64} (\w+) (\d+)$/);
    if (!m) {
      throw new Error(`git cat-file --batch could not read ${treeish}:${path} — got "${header}"`);
    }
    if (m[1] !== "blob") {
      throw new Error(`${treeish}:${path} is a ${m[1]}, expected a blob`);
    }
    const size = Number(m[2]);
    // Slice by BYTE COUNT — issue bodies can contain header-shaped lines.
    out.set(path, buf.toString("utf8", off, off + size));
    off += size + 1; // body + the trailing LF git appends after each object
  }
  return out;
}

let files = [];
try {
  files = git(["ls-tree", "-r", "--name-only", "-z", ref, "--", "plan/issues"])
    .split("\0")
    .filter((file) => file && isIssueFile(file));
} catch (error) {
  console.error(`Unable to inspect issue files at ${ref}: ${error.message}`);
  process.exit(1);
}

let blobs;
try {
  blobs = batchReadBlobs(ref, files);
  // batchReadBlobs either throws or returns one entry per requested path.
  // Assert that rather than trusting it: a short map would otherwise reach the
  // scan loop, where a missing entry reads as empty content, `id` falls back to
  // the filename prefix, and the file passes every check silently.
  if (blobs.size !== files.length) {
    throw new Error(`read ${blobs.size} blobs for ${files.length} issue files`);
  }
} catch (error) {
  console.error(`Unable to read issue files at ${ref}: ${error.message}`);
  process.exit(1);
}

const byId = new Map();
const duplicates = new Map();
const idMismatches = [];
const edges = [];

// FALSE-GREEN FLOOR. `id` falls back to the filename prefix when frontmatter
// is unreadable (see below), so a reader that returned empty strings for every
// file would satisfy every check and print "OK". Counting files that actually
// yielded frontmatter makes a silently-empty read impossible to mistake for a
// clean tree.
let withFrontmatter = 0;

for (const file of files) {
  // No `?? ""` fallback: an absent entry here would be a silent empty read,
  // which is indistinguishable from a clean file. The size assertion above
  // makes this unreachable, so treat it as a hard bug if it ever fires.
  const text = blobs.get(file);
  if (text === undefined) {
    console.error(`Internal error: no blob read for ${file} at ${ref}`);
    process.exit(1);
  }
  const fm = frontmatter(text);
  if (fm.trim()) withFrontmatter += 1;
  const fileId = filenameIssueId(file);
  const id = (readScalar(fm, "id") || fileId).toLowerCase();
  if (!id) continue;

  if (fileId && id !== fileId) {
    idMismatches.push({ file, filename: fileId, frontmatter: id });
  }
  if (byId.has(id)) {
    if (!duplicates.has(id)) duplicates.set(id, [byId.get(id)]);
    duplicates.get(id).push(file);
  } else {
    byId.set(id, file);
  }

  for (const dep of readInlineArray(fm, "depends_on")) {
    edges.push({ file, dep });
  }
}

const dangling = edges.filter(({ dep }) => !byId.has(dep));

if (emitJson) {
  // Derived state, for old-vs-new parity diffing. Sorted so the dump is stable.
  console.log(
    JSON.stringify(
      {
        ref,
        scanned: files.length,
        withFrontmatter,
        byId: Object.fromEntries([...byId].sort(([a], [b]) => (a < b ? -1 : 1))),
        duplicates: Object.fromEntries([...duplicates].sort(([a], [b]) => (a < b ? -1 : 1))),
        idMismatches: [...idMismatches].sort((a, b) => (a.file < b.file ? -1 : 1)),
        dangling: [...dangling].sort((a, b) => (a.file + a.dep < b.file + b.dep ? -1 : 1)),
      },
      null,
      2,
    ),
  );
  process.exit(duplicates.size || idMismatches.length || dangling.length ? 1 : 0);
}

// A checker that scanned nothing is indistinguishable from a clean tree, so
// refuse to report OK on an empty scan rather than passing by default.
if (files.length === 0) {
  console.error(
    `Committed issue integrity INCONCLUSIVE for ${ref}: scanned 0 issue files under ` +
      `plan/issues. Refusing to report OK — a zero-file scan cannot distinguish ` +
      `"clean" from "the checker never looked".`,
  );
  process.exit(1);
}
if (withFrontmatter === 0) {
  console.error(
    `Committed issue integrity INCONCLUSIVE for ${ref}: read ${files.length} issue ` +
      `files but NONE yielded frontmatter. The blob reader is broken; without ` +
      `frontmatter every id silently falls back to the filename prefix and every ` +
      `check would pass vacuously.`,
  );
  process.exit(1);
}

if (duplicates.size || idMismatches.length || dangling.length) {
  console.log(`Committed issue integrity failed for ${ref}:`);
  if (duplicates.size) {
    console.log(`\nDUPLICATE IDs (${duplicates.size}):`);
    for (const [id, entries] of duplicates) {
      console.log(`  #${id}:`);
      for (const file of entries) console.log(`    ${file}`);
    }
  }
  if (idMismatches.length) {
    console.log(`\nFILENAME/FRONTMATTER ID MISMATCH (${idMismatches.length}):`);
    for (const { file, filename, frontmatter } of idMismatches) {
      console.log(`  ${file}: filename prefix=${filename}, frontmatter id=${frontmatter}`);
    }
  }
  if (dangling.length) {
    console.log(`\nDANGLING depends_on (${dangling.length}):`);
    for (const { file, dep } of dangling) console.log(`  ${file} -> #${dep} (not found in ${ref})`);
  }
  process.exit(1);
}

// Print the scan floor, not just the verdict: "OK" is only meaningful next to
// how much was actually read.
console.log(
  `Committed issue integrity OK for ${ref} (${byId.size} issues indexed; ` +
    `${files.length} files scanned, ${withFrontmatter} with frontmatter).`,
);
