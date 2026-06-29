#!/usr/bin/env node
// Sprint progress statusline for Claude Code.
// PRIMARY: reads from the base remote ref (origin/main or upstream/main) via a
// single batched `git grep` call so the statusline always reflects committed truth
// even when the local /workspace working tree is behind.
// FALLBACK: scans the local working-tree plan/issues/*.md frontmatter.
// LAST RESORT: reads from dashboard/data/sprints.json cache.
// Emits a colored badge: "sprint N  NN%"

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES_DIR = join(ROOT, "plan", "issues");
const SPRINTS_JSON = join(ROOT, "website", "dashboard", "data", "sprints.json");

// ── Remote detection ────────────────────────────────────────────────────────

/** Returns 'upstream' if that remote exists in this repo, else 'origin'. */
function detectBaseRemote() {
  try {
    const r = spawnSync("git", ["-C", ROOT, "remote"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0) {
      const remotes = r.stdout.trim().split("\n");
      if (remotes.includes("upstream")) return "upstream";
    }
  } catch {
    // ignore
  }
  return "origin";
}

// ── Remote ref scan (PRIMARY) ───────────────────────────────────────────────

/**
 * Reads sprint+status frontmatter for all issue files on <remote>/main via a
 * single `git grep -E` call (batched — never per-file git show).
 * Returns { sprint, done, total } or null on failure / unavailability.
 */
function sprintFromRemote(remote) {
  const ref = `${remote}/main`;

  // Single grep for sprint and status lines across all flat issue files.
  // git grep output format: <ref>:<path>:<matched-line>
  const grepResult = spawnSync(
    "git",
    ["-C", ROOT, "grep", "-E", "^(sprint: [0-9]|sprint: current|status: )", ref, "--", "plan/issues/*.md"],
    { encoding: "utf8", timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
  );

  // grep exits 1 when no matches (treat as empty, not failure)
  if (!grepResult.stdout) return null;

  // Parse output lines: <ref>:<path>:<content>
  // Split only on the first two colons (paths never contain colons on Linux).
  const byFile = new Map(); // path -> { sprint?, current?, status? }
  for (const line of grepResult.stdout.split("\n")) {
    if (!line) continue;
    const c1 = line.indexOf(":");
    if (c1 === -1) continue;
    const c2 = line.indexOf(":", c1 + 1);
    if (c2 === -1) continue;
    const path = line.slice(c1 + 1, c2);
    const content = line.slice(c2 + 1);

    // Only flat issue files (not plan/issues/sprints/*.md subdirectory)
    if (path.includes("/sprints/")) continue;
    // Filename must start with a digit
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (!/^\d/.test(base)) continue;

    const file = byFile.get(path) ?? {};
    // First-wins: frontmatter appears before body text
    if (file.sprint === undefined && file.current === undefined) {
      const m = content.match(/^sprint:\s*(\d+)\s*$/);
      if (m) file.sprint = Number(m[1]);
      else if (/^sprint:\s*current\s*$/.test(content)) file.current = true;
    }
    if (file.status === undefined) {
      const m = content.match(/^status:\s*(\S+)/);
      if (m) file.status = m[1];
    }
    byFile.set(path, file);
  }

  if (byFile.size === 0) return null;

  // Detect inactive sprint numbers from sprint doc files on the remote ref.
  const sprintDocGrep = spawnSync(
    "git",
    ["-C", ROOT, "grep", "-E", "^status: (planning|planned|closed|done)", ref, "--", "plan/issues/sprints/*.md"],
    { encoding: "utf8", timeout: 4000 },
  );

  const inactive = new Set();
  if (sprintDocGrep.stdout) {
    for (const line of sprintDocGrep.stdout.split("\n")) {
      if (!line) continue;
      const c1 = line.indexOf(":");
      if (c1 === -1) continue;
      const c2 = line.indexOf(":", c1 + 1);
      if (c2 === -1) continue;
      const path = line.slice(c1 + 1, c2);
      const m = path.match(/\/(\d+)\.md$/);
      if (m) inactive.add(Number(m[1]));
    }
  }

  // Build sprint buckets from the parsed file map. The rolling budget-window
  // model (#2751) tags live work `sprint: current`; that is the active window
  // and takes precedence over any frozen numbered sprint.
  const bySprint = new Map(); // sprintNum -> { total, done }
  const current = { total: 0, done: 0 }; // the `sprint: current` window
  for (const { sprint, current: isCurrent, status } of byFile.values()) {
    if (isCurrent) {
      current.total++;
      if (status === "done" || status === "wont-fix") current.done++;
      continue;
    }
    if (!sprint) continue;
    const bucket = bySprint.get(sprint) ?? { total: 0, done: 0 };
    bucket.total++;
    if (status === "done" || status === "wont-fix") bucket.done++;
    bySprint.set(sprint, bucket);
  }

  // The live `current` window wins when it has any work.
  if (current.total > 0) return { sprint: "cur", done: current.done, total: current.total };

  if (bySprint.size === 0) return null;

  // Fallback: highest numbered sprint that is not inactive.
  const nums = [...bySprint.keys()].filter((n) => !inactive.has(n)).sort((a, b) => b - a);
  const sprintNum = nums[0] ?? 0;
  if (!sprintNum) return null;

  const { total, done } = bySprint.get(sprintNum);
  return { sprint: sprintNum, done, total };
}

// ── Local working-tree fallback ─────────────────────────────────────────────

function fromJson() {
  if (!existsSync(SPRINTS_JSON)) return null;
  try {
    const sprints = JSON.parse(readFileSync(SPRINTS_JSON, "utf8"));
    // Prefer the live `current` window (#2751); else the latest active numbered
    // sprint (not closed, not planning — same logic as the dashboard).
    const active =
      sprints.find((s) => s.isCurrent) ??
      sprints
        .filter((s) => Number.isFinite(s.sprintNumber) && !s.isClosed && !s.isPlanning)
        .sort((a, b) => a.sprintNumber - b.sprintNumber)
        .at(-1);
    if (!active) return null;
    const total = (active.issueIds || []).length;
    const done = (active.completedIssueIds || []).length;
    return { sprint: active.isCurrent ? "cur" : active.sprintNumber, done, total };
  } catch {
    return null;
  }
}

const ISSUE_FILE_RE = /^\d+[a-z]?(?:[-_].+)?\.md$/i;
const NON_ISSUE = new Set(["backlog.md", "index.md", "SCHEMA.md", "log.md", "1578-test262-analysis.md"]);

// Scan the flat issue tree once, bucketing by numeric `sprint:` value plus the
// live `sprint: current` window (#2751).
function scanFlatTree() {
  const bySprint = new Map(); // sprintNum -> { total, done }
  const current = { total: 0, done: 0 }; // the `sprint: current` window
  let names = [];
  try {
    names = readdirSync(ISSUES_DIR);
  } catch {
    return { bySprint, current };
  }
  for (const f of names) {
    if (NON_ISSUE.has(f) || !ISSUE_FILE_RE.test(f)) continue;
    let content;
    try {
      content = readFileSync(join(ISSUES_DIR, f), "utf8");
    } catch {
      continue;
    }
    const sprintRaw = content.match(/^sprint:\s*(\S+)/m)?.[1] ?? "";
    const isDone = /^status:\s*(done|wont-fix)\b/m.test(content);
    if (sprintRaw === "current") {
      current.total++;
      if (isDone) current.done++;
      continue;
    }
    if (!/^\d+$/.test(sprintRaw)) continue; // skip Backlog / 0 / unset
    const n = Number(sprintRaw);
    const bucket = bySprint.get(n) ?? { total: 0, done: 0 };
    bucket.total++;
    if (isDone) bucket.done++;
    bySprint.set(n, bucket);
  }
  return { bySprint, current };
}

let _flatCache = null;
function flatTree() {
  return (_flatCache ??= scanFlatTree());
}

const SPRINTS_DIR = join(ISSUES_DIR, "sprints");
// A sprint whose doc status is one of these is NOT the current working sprint.
const INACTIVE_SPRINT_STATUSES = new Set(["planning", "planned", "closed", "done"]);
function inactiveSprintNumbers() {
  const out = new Set();
  let names = [];
  try {
    names = readdirSync(SPRINTS_DIR);
  } catch {
    return out;
  }
  for (const f of names) {
    const m = f.match(/^(\d+)\.md$/);
    if (!m) continue;
    let content;
    try {
      content = readFileSync(join(SPRINTS_DIR, f), "utf8");
    } catch {
      continue;
    }
    const st = content.match(/^status:\s*(\S+)/m)?.[1] ?? "";
    if (INACTIVE_SPRINT_STATUSES.has(st)) out.add(Number(m[1]));
  }
  return out;
}

// Returns "cur" when the live `current` window has work, else the highest
// non-inactive numbered sprint (or 0).
function currentSprintLocal() {
  const { bySprint, current } = flatTree();
  if (current.total > 0) return "cur";
  const inactive = inactiveSprintNumbers();
  const nums = [...bySprint.keys()].filter((n) => !inactive.has(n)).sort((a, b) => b - a);
  return nums[0] ?? 0;
}

function sprintProgressLocal(n) {
  const { bySprint, current } = flatTree();
  if (n === "cur") return current;
  return bySprint.get(n) ?? { done: 0, total: 0 };
}

// ── Main ────────────────────────────────────────────────────────────────────

// Priority 1: remote ref (always reflects committed truth regardless of local-tree state)
const remote = detectBaseRemote();
let sprintData = sprintFromRemote(remote);

// Priority 2: local working-tree scan (fallback when offline / ref not yet fetched)
if (!sprintData) {
  const localSprint = currentSprintLocal();
  if (localSprint) {
    sprintData = { sprint: localSprint, ...sprintProgressLocal(localSprint) };
  }
}

// Priority 3: pre-built sprints.json cache (last resort)
if (!sprintData) {
  sprintData = fromJson();
}

const sprint = sprintData?.sprint ?? 0;
const done = sprintData?.done ?? 0;
const total = sprintData?.total ?? 0;
const pct = total === 0 ? 0 : done / total;

// --porcelain: emit machine-readable "N done total" for shell callers
// (.claude/statusline-command.sh renders its own progress bar from these).
if (process.argv.includes("--porcelain")) {
  process.stdout.write(`${sprint} ${done} ${total}\n`);
  process.exit(0);
}

function interpolateColor(pct) {
  // Hue 0 (red) → 60 (yellow) → 120 (green) via HSL→RGB
  const hue = pct * 120;
  const h = hue / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  let r, g, b;
  if (h < 1) {
    r = 1;
    g = x;
    b = 0;
  } else if (h < 2) {
    r = x;
    g = 1;
    b = 0;
  } else {
    r = 0;
    g = 1;
    b = x;
  }
  return [Math.round(r * 220), Math.round(g * 200), Math.round(b * 20)];
}

const [r, g, b] = interpolateColor(pct);

// ANSI 24-bit foreground color + reset
const colored = `\x1b[38;2;${r};${g};${b}m`;
const reset = "\x1b[0m";

// Numbered sprint → "sN"; the live `current` window → "cur" (no `s` prefix).
const sprintLabel = sprint === "cur" ? "cur" : `s${sprint}`;
process.stdout.write(`${colored}${sprintLabel} ${done}/${total}${reset}`);
