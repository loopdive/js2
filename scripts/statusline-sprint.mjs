#!/usr/bin/env node
// Sprint progress statusline for Claude Code.
// Prefers dashboard/data/sprints.json (accurate deduplicated view) when available.
// Falls back to scanning the flat plan/issues/*.md tree, reading the `sprint:`
// and `status:` frontmatter fields (#1616 — sprint membership is frontmatter,
// not directory).
// Emits a colored badge: "sprint N  NN%"

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ISSUES_DIR = join(ROOT, "plan", "issues");
const SPRINTS_JSON = join(ROOT, "website", "dashboard", "data", "sprints.json");

function fromJson() {
  if (!existsSync(SPRINTS_JSON)) return null;
  try {
    const sprints = JSON.parse(readFileSync(SPRINTS_JSON, "utf8"));
    // Active sprint: not closed, not planning (same logic as dashboard)
    const active = sprints
      .filter((s) => Number.isFinite(s.sprintNumber) && !s.isClosed && !s.isPlanning)
      .sort((a, b) => a.sprintNumber - b.sprintNumber)
      .at(-1);
    if (!active) return null;
    const total = (active.issueIds || []).length;
    const done = (active.completedIssueIds || []).length;
    return { sprint: active.sprintNumber, done, total };
  } catch {
    return null;
  }
}

const ISSUE_FILE_RE = /^\d+[a-z]?(?:[-_].+)?\.md$/i;
const NON_ISSUE = new Set(["backlog.md", "index.md", "SCHEMA.md", "log.md", "1578-test262-analysis.md"]);

// Scan the flat issue tree once, bucketing by numeric `sprint:` value.
function scanFlatTree() {
  const bySprint = new Map(); // sprintNum -> { total, done }
  let names = [];
  try {
    names = readdirSync(ISSUES_DIR);
  } catch {
    return bySprint;
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
    if (!/^\d+$/.test(sprintRaw)) continue; // skip Backlog / 0 / unset
    const n = Number(sprintRaw);
    const bucket = bySprint.get(n) ?? { total: 0, done: 0 };
    bucket.total++;
    if (/^status:\s*(done|wont-fix)\b/m.test(content)) bucket.done++;
    bySprint.set(n, bucket);
  }
  return bySprint;
}

let _flatCache = null;
function flatTree() {
  return (_flatCache ??= scanFlatTree());
}

function currentSprint() {
  const buckets = flatTree();
  const nums = [...buckets.keys()].sort((a, b) => b - a);
  return nums[0] ?? 0;
}

function sprintProgress(n) {
  return flatTree().get(n) ?? { done: 0, total: 0 };
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

const jsonData = fromJson();
const sprint = jsonData ? jsonData.sprint : currentSprint();
const { done, total } = jsonData ?? sprintProgress(sprint);
const pct = total === 0 ? 0 : done / total;
const pctInt = Math.round(pct * 100);

// --porcelain: emit machine-readable "N done total" for shell callers
// (.claude/statusline-command.sh renders its own progress bar from these).
if (process.argv.includes("--porcelain")) {
  process.stdout.write(`${sprint} ${done} ${total}\n`);
  process.exit(0);
}

const [r, g, b] = interpolateColor(pct);

// ANSI 24-bit foreground color + reset
const colored = `\x1b[38;2;${r};${g};${b}m`;
const reset = "\x1b[0m";

process.stdout.write(`${colored}s${sprint} ${done}/${total}${reset}`);
