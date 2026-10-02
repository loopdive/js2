#!/usr/bin/env node
/**
 * check-claude-md-paths.mjs (#6795)
 *
 * CLAUDE.md is the first file every agent reads, and it is ~60 KB of hand-
 * written prose. It named `tests/equivalence.test.ts` as the main test file
 * (the file does not exist), cited a CI workflow that had been deleted, and
 * listed a `--nativeStrings` CLI flag that `src/cli.ts` does not parse. Each
 * of those sent an agent to a path or command that fails. This gate fails when
 * CLAUDE.md names something that is not there.
 *
 * What is checked
 *   - PATHS: every repo path CLAUDE.md names — in an inline code span, a fenced
 *     code block, or a markdown link target — whose first segment is one of
 *     PATH_ROOTS. It must be a file git knows (tracked, or untracked but not
 *     ignored) or a directory containing one; plain filesystem existence when
 *     the tree is not a git checkout. Normalisation first: a leading `./`, `:line`,
 *     `:a-b` and `::symbol` suffixes, a `#anchor`, and trailing punctuation are
 *     stripped; a token with a glob or placeholder (`src/**`, `plan/issues/<id>-*.md`,
 *     `{N}`) is checked up to its last literal directory.
 *   - FLAGS: every `--flag` in an inline code span inside the `## CLI Flags`
 *     section must be parsed by `src/cli.ts` (it must appear there as a quoted
 *     string, the way the argument parser writes it). Only that section is
 *     checked: the rest of CLAUDE.md quotes flags of git, pnpm and a dozen
 *     scripts, none of which live in cli.ts.
 *
 * Escape hatch — use sparingly
 *   A line carrying `<!-- historical -->` is skipped for both checks, for text
 *   that deliberately names something that no longer exists ("the old
 *   `scripts/foo.mjs` was deleted by #123"). Every use is printed on each run so
 *   a skipped line is visible, never silent.
 *
 * Usage
 *   node scripts/check-claude-md-paths.mjs [--file <md>] [--root <dir>] [--cli <ts>]
 *   Exit 0 clean, 1 on any dangling reference, 2 on a usage/IO error. The last
 *   output line is always a verdict.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** First path segments that mark a token as a repo path. */
export const PATH_ROOTS = [
  "src",
  "scripts",
  "tests",
  "plan",
  "docs",
  ".github",
  ".husky",
  ".claude",
  "benchmarks",
  "website",
  "packages",
  "playground",
];

export const HISTORICAL_MARKER = "<!-- historical -->";
export const FLAG_SECTION = "## CLI Flags";

const ROOT_RE = new RegExp(`^(?:${PATH_ROOTS.map((r) => r.replace(/\./g, "\\.")).join("|")})/`);
const PLACEHOLDER_RE = /[*<>{}$|]|\.\.\.|…/;

/**
 * Reduce a raw token to a repo-relative path, or null when it is not one.
 * A bare `name.yml` / `name.yaml` is read as a workflow name (CLAUDE.md cites
 * dozens without the directory): it resolves under `.github/workflows/`, or —
 * for `pnpm-lock.yaml` and friends — at the repo root (`alt`).
 * @returns {{path: string, alt?: string} | null}
 */
export function normalizePathToken(raw) {
  let t = raw.replace(/^[("'[]+/, "").replace(/^\.\//, "");
  // Trailing punctuation, one character at a time so `).` and `",` unwind fully.
  // A sentence period goes; the `...` of a `src/...` placeholder stays.
  while (/[)"'\],;!?]$/.test(t) || /[^.]\.$/.test(t)) t = t.slice(0, -1);
  t = t
    .replace(/#[\w-]*$/, "")
    .replace(/::[A-Za-z_$][\w$]*$/, "")
    .replace(/:\d+(?:-\d+)?(?::\d+)?$/, "");
  if (ROOT_RE.test(t)) return { path: t };
  if (/^[A-Za-z0-9][\w.-]*\.ya?ml$/.test(t)) return { path: `.github/workflows/${t}`, alt: t };
  return null;
}

/**
 * Pull every reference out of a markdown document.
 * @returns {{paths: {line: number, token: string, path: string}[], flags: {line: number, flag: string}[], skipped: {line: number, text: string}[]}}
 */
export function extractReferences(markdown) {
  const paths = [];
  const flags = [];
  const skipped = [];
  let inFence = false;
  let inFlagSection = false;
  const lines = markdown.split("\n");

  lines.forEach((text, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      return;
    }
    if (!inFence && /^## /.test(text)) inFlagSection = text.trim() === FLAG_SECTION;
    if (text.includes(HISTORICAL_MARKER)) {
      skipped.push({ line, text: text.trim().slice(0, 100) });
      return;
    }

    const candidates = [];
    if (inFence) {
      candidates.push(...text.split(/\s+/));
    } else {
      for (const m of text.matchAll(/`([^`]+)`/g)) candidates.push(...m[1].split(/\s+/));
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) candidates.push(m[1]);
    }
    for (const token of candidates) {
      const ref = normalizePathToken(token);
      if (ref) paths.push({ line, token, ...ref });
    }

    if (inFlagSection && !inFence) {
      for (const m of text.matchAll(/`([^`]+)`/g)) {
        for (const f of m[1].match(/(?<![\w-])--[A-Za-z][A-Za-z0-9-]*/g) ?? []) flags.push({ line, flag: f });
      }
    }
  });
  return { paths, flags, skipped };
}

/** The file/dir lookup: tracked files and every directory above them. */
export function buildPathIndex(root) {
  try {
    // Tracked files plus untracked-but-not-ignored ones: a file you just wrote
    // counts before you `git add` it, while a gitignored local artifact (which
    // would pass here and fail in CI's clean checkout) does not.
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"], // "not a git repository" is expected for a fixture, not noise
    });
    const known = new Set();
    for (const f of out.split("\0").filter(Boolean)) {
      known.add(f);
      for (let d = dirname(f); d !== "." && d !== "/" && !known.has(d); d = dirname(d)) known.add(d);
    }
    if (known.size > 0) return (p) => known.has(p);
  } catch {
    // not a git checkout (e.g. a test fixture) — fall through to the filesystem
  }
  return (p) => existsSync(join(root, p));
}

/** Directory to verify for a token: itself, or its last literal directory when it holds a glob/placeholder. */
export function checkTarget(path) {
  const trimmed = path.replace(/\/+$/, "");
  const m = PLACEHOLDER_RE.exec(trimmed);
  if (!m) return trimmed;
  const literal = trimmed.slice(0, m.index);
  const cut = literal.lastIndexOf("/");
  return cut <= 0 ? literal.replace(/\/+$/, "") : literal.slice(0, cut);
}

/** Does `cliSource` parse `flag`? It must appear as a quoted string, as the arg parser writes it. */
export function cliParsesFlag(cliSource, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`]${escaped}(?:["'\`=])`).test(cliSource);
}

export function checkClaudeMd({ markdown, exists, cliSource }) {
  const refs = extractReferences(markdown);
  const problems = [];
  const seen = new Set();
  for (const r of refs.paths) {
    const target = checkTarget(r.path);
    const key = `${r.line}:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!exists(target) && !(r.alt && exists(r.alt))) {
      const why = target === r.path.replace(/\/+$/, "") ? "does not exist" : `directory ${target}/ does not exist`;
      problems.push({ line: r.line, what: r.token, why });
    }
  }
  for (const f of refs.flags) {
    if (!cliParsesFlag(cliSource, f.flag)) {
      problems.push({ line: f.line, what: f.flag, why: "is not parsed by src/cli.ts" });
    }
  }
  return { problems, refs };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(arg("--root", resolve(here, "..")));
  const file = resolve(root, arg("--file", "CLAUDE.md"));
  const cliPath = resolve(root, arg("--cli", "src/cli.ts"));
  let markdown;
  let cliSource;
  try {
    markdown = readFileSync(file, "utf8");
    cliSource = readFileSync(cliPath, "utf8");
  } catch (err) {
    console.error(`check-claude-md-paths: FAILED — ${err.message}`);
    process.exit(2);
  }

  const { problems, refs } = checkClaudeMd({ markdown, exists: buildPathIndex(root), cliSource });
  for (const s of refs.skipped) {
    console.log(`check-claude-md-paths: skipped line ${s.line} (${HISTORICAL_MARKER}): ${s.text}`);
  }
  for (const p of problems) {
    console.error(`${file}:${p.line}: \`${p.what}\` ${p.why}`);
  }
  if (problems.length > 0) {
    console.error(
      `check-claude-md-paths: FAILED — ${problems.length} dangling reference(s) in CLAUDE.md. Fix the text, or ` +
        `append ${HISTORICAL_MARKER} to a line that deliberately names something that no longer exists.`,
    );
    process.exit(1);
  }
  console.log(
    `check-claude-md-paths: OK — ${refs.paths.length} path reference(s) and ${refs.flags.length} CLI flag(s) resolve` +
      (refs.skipped.length ? `; ${refs.skipped.length} line(s) skipped as historical` : ""),
  );
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main();
}
