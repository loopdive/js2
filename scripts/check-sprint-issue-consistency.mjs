#!/usr/bin/env node
/**
 * Sprint/issue consistency gate — see issue #1523.
 *
 * Walks every issue markdown file under `plan/issues/` (excluding
 * `sprint.md`, `backlog.md`, anything under a `wont-fix/` folder) and
 * enforces:
 *
 *   1. `id:` is present and numeric (or numeric with a single lowercase
 *      letter suffix, e.g. `1326c`).
 *   2. `sprint:` is present and is either a non-negative integer or the
 *      literal string `backlog`.
 *   3. If the file lives under `plan/issues/sprints/<N>/`, `sprint:` MUST
 *      equal `<N>`.
 *   4. If the file lives under `plan/issues/backlog/`, `sprint:` MUST be
 *      `backlog`.
 *   5. No two files share the same `id:` (across the whole tree).
 *   6. The phased-out `plan/log/sprint-current.md` file must not exist as
 *      a tracked file (regression guard — see #1523).
 *   7. No issue body references the path `plan/log/sprint-current.md`
 *      outside the small allow-list (the #1523 issue itself, the
 *      sprint-52 retro that documents the phase-out, and the sprint-53
 *      sprint.md table that lists issue #1523 by its title).
 *
 * Exit 0 on success; exit 1 with a clear per-file report on any failure.
 *
 * Run via `pnpm run check:sprint-consistency` or directly with Node.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const ISSUE_ROOT = join(ROOT, "plan", "issues");
const SPRINT_CURRENT = join(ROOT, "plan", "log", "sprint-current.md");

// Files that may legitimately mention `sprint-current.md` because they
// document its phase-out. Paths are relative to repo root.
const SPRINT_CURRENT_ALLOWLIST = new Set([
  "plan/issues/sprints/53/1523-programmatic-sprint-docs-and-consistency-script.md",
  "plan/log/retrospectives/sprint-52.md",
  "plan/issues/sprints/53/sprint.md",
  "scripts/check-sprint-issue-consistency.mjs",
]);

// File-name pattern reused from scripts/sync-sprint-issue-tables.mjs.
// Accepts `1234.md`, `1234a-foo.md`, `1234-some-slug.md`.
const ISSUE_FILE = /^\d+[a-z]?(?:-.+)?\.md$/i;
const ID_PATTERN = /^\d+[a-z]?$/i;

function walk(root, out = []) {
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const file = join(root, name);
    const stat = statSync(file);
    if (stat.isDirectory()) walk(file, out);
    else out.push(file);
  }
  return out;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const obj = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    obj[key] = val;
  }
  return obj;
}

function folderContext(absPath) {
  const rel = relative(ROOT, absPath).replace(/\\/g, "/");
  const sprintMatch = rel.match(/^plan\/issues\/sprints\/(\d+)\//);
  if (sprintMatch) return { kind: "sprint", expected: sprintMatch[1] };
  if (/^plan\/issues\/backlog\//.test(rel)) {
    return { kind: "backlog", expected: "backlog" };
  }
  // Anything else under plan/issues/ that has an issue-shaped file name
  // (e.g. a stray file at the top level of plan/issues/) is treated as
  // unknown; the script flags it but doesn't try to map it.
  return { kind: "other", expected: null };
}

function isIssueFile(absPath) {
  const name = absPath.split("/").pop();
  if (name === "sprint.md" || name === "backlog.md") return false;
  if (absPath.includes("/wont-fix/")) return false;
  if (!ISSUE_FILE.test(name)) return false;
  return true;
}

function main() {
  const errors = [];
  const idMap = new Map(); // id -> [paths]

  // 1-5: per-file frontmatter checks + global ID map.
  for (const file of walk(ISSUE_ROOT)) {
    if (!isIssueFile(file)) continue;
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const text = readFileSync(file, "utf8");
    const fm = parseFrontmatter(text);
    if (!fm) {
      errors.push(`${rel}: missing YAML frontmatter`);
      continue;
    }

    if (!fm.id || !ID_PATTERN.test(String(fm.id))) {
      errors.push(`${rel}: missing or non-numeric \`id:\` (got: ${JSON.stringify(fm.id)})`);
    } else {
      const id = String(fm.id);
      if (!idMap.has(id)) idMap.set(id, []);
      idMap.get(id).push(rel);
    }

    const ctx = folderContext(file);
    const fmSprint = fm.sprint;
    if (fmSprint === undefined || fmSprint === "" || fmSprint === "~" || fmSprint === "null") {
      errors.push(`${rel}: missing \`sprint:\` frontmatter (expected ${ctx.expected ?? "<number|backlog>"})`);
    } else if (ctx.expected !== null && String(fmSprint) !== ctx.expected) {
      errors.push(`${rel}: \`sprint: ${fmSprint}\` disagrees with folder (expected \`sprint: ${ctx.expected}\`)`);
    } else if (ctx.expected === null) {
      // file lives somewhere weird; require explicit valid sprint
      if (!/^\d+$/.test(String(fmSprint)) && String(fmSprint) !== "backlog") {
        errors.push(`${rel}: \`sprint:\` must be a number or \`backlog\`, got ${JSON.stringify(fmSprint)}`);
      }
    }
  }

  // 5b: duplicate IDs.
  for (const [id, paths] of idMap) {
    if (paths.length > 1) {
      errors.push(`duplicate id #${id} across:\n  - ${paths.join("\n  - ")}`);
    }
  }

  // 6: regression guard — sprint-current.md must not be a tracked file.
  if (existsSync(SPRINT_CURRENT)) {
    errors.push("plan/log/sprint-current.md exists — this file is phased out (#1523). Remove it.");
  }

  // 7: body references to sprint-current.md must be allow-listed.
  const bodyRefs = [];
  for (const file of walk(join(ROOT, "plan"))) {
    if (!file.endsWith(".md")) continue;
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (SPRINT_CURRENT_ALLOWLIST.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes("sprint-current.md")) bodyRefs.push(rel);
  }
  if (bodyRefs.length > 0) {
    errors.push(
      "Non-allow-listed reference(s) to `sprint-current.md` (phased out, see #1523):\n  - " + bodyRefs.join("\n  - "),
    );
  }

  if (errors.length > 0) {
    console.error("Sprint/issue consistency check FAILED:\n");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error(`\n${errors.length} error(s). See plan/issues/sprints/53/1523-*.md for context.`);
    process.exit(1);
  }

  const totalIssues = [...idMap.values()].reduce((a, b) => a + b.length, 0);
  console.log(`Sprint/issue consistency check OK (${totalIssues} issue files, ${idMap.size} unique IDs).`);
}

main();
