#!/usr/bin/env node
/**
 * build-data.js — Generates dashboard/data/ JSON files from project sources.
 * Run: node dashboard/build-data.js
 * No dependencies — uses only Node.js built-ins.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(import.meta.dirname, "data");
const SPRINT_ROOT = join(ROOT, "plan/issues/sprints");
const LEGACY_SPRINT_ROOT = join(ROOT, "plan/sprints");

mkdirSync(OUT, { recursive: true });

const ISSUE_ROOT = join(ROOT, "plan/issues");

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function getTrackedMarkdownFiles(root) {
  try {
    return new Set(
      git(["ls-files", root])
        .split("\n")
        .map((file) => file.trim())
        .filter((file) => file.endsWith(".md"))
        .map((file) => join(ROOT, file)),
    );
  } catch {
    return null;
  }
}

function getStableGeneratedAt(paths) {
  const candidates = paths.filter((p) => existsSync(p));
  if (!candidates.length) return "";
  try {
    return git(["log", "-1", "--no-merges", "--format=%aI", "--", ...candidates]);
  } catch {
    return "";
  }
}

function isIssueFileName(name) {
  return /^\d+[a-z]?(?:-.+)?\.md$/i.test(name);
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const file = join(root, name);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      out.push(...walkFiles(file));
    } else {
      out.push(file);
    }
  }
  return out;
}

// ── Frontmatter parser ───────────────────────────────────────
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const obj = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (val.startsWith("[") && val.endsWith("]"))
      val = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    obj[key] = val;
  }
  return obj;
}

function extractTitle(text) {
  const m = text.match(/^#\s+.*?—\s*(.+)$/m) || text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "Untitled";
}

function extractSprintNumber(name) {
  const match = String(name).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function extractSprintNumberFromLabel(label) {
  return extractSprintNumber(label);
}

// ── Load issues ──────────────────────────────────────────────
function normalizeIssueStatus(rawStatus) {
  const status = String(rawStatus || "").trim();
  if (status === "in_progress") return "in-progress";
  if (status === "review" || status === "in-review" || status === "in_review") return "in-review";
  if (status) return status;
  return "ready";
}

// When the same issue ID appears in multiple sprint snapshot directories
// (e.g. a done issue in sprints/42/ and a carry-forward in sprints/45/),
// prefer the version with the highest-priority status so that done issues
// don't show up as "ready" in a later sprint's board.
const STATUS_PRIORITY = {
  done: 0,
  "wont-fix": 1,
  blocked: 2,
  "in-review": 3,
  "in-progress": 4,
  ready: 5,
  deferred: 6,
  backlog: 7,
};
function issueStatusPriority(status) {
  return STATUS_PRIORITY[status] ?? 8;
}

function loadIssues() {
  if (!existsSync(ISSUE_ROOT)) return [];
  const trackedFiles = getTrackedMarkdownFiles("plan/issues");
  const raw = walkFiles(ISSUE_ROOT)
    .filter((file) => isIssueFileName(file.split("/").pop()))
    .filter((file) => !trackedFiles || trackedFiles.has(file))
    .map((file) => {
      const text = readFileSync(file, "utf-8");
      const f = file.split("/").pop();
      const fm = parseFrontmatter(text);
      const id = String(fm.id || f.replace(".md", ""));
      const title = fm.title || extractTitle(text);
      // Sprint membership: prefer explicit `sprint:` frontmatter, but fall
      // back to the parent directory name. The repo convention is that an
      // issue file at `plan/issues/sprints/<N>/<id>-…md` belongs to sprint
      // <N>, even when the frontmatter omits the field. (The dashboard
      // previously dropped 55+ sprint-47 issues that didn't have an explicit
      // `sprint:` line — that's the root cause behind "sprint shows only one
      // ticket" reports.)
      const dirSegments = file.split("/");
      const sprintsIdx = dirSegments.lastIndexOf("sprints");
      const sprintFromDir =
        sprintsIdx >= 0 && sprintsIdx + 1 < dirSegments.length - 1 ? dirSegments[sprintsIdx + 1] : "";
      const slug = f.replace(".md", "");
      return {
        id,
        title,
        slug,
        priority: fm.priority || "medium",
        feasibility: fm.feasibility || "",
        depends_on: fm.depends_on || [],
        goal: fm.goal || "",
        status: normalizeIssueStatus(fm.status),
        sprint: fm.sprint || sprintFromDir,
      };
    });

  // Deduplicate by ID — same issue can appear in multiple sprint snapshot dirs.
  // Keep the copy with the highest-priority status (done beats ready/deferred).
  const byId = new Map();
  for (const issue of raw) {
    const existing = byId.get(issue.id);
    if (!existing || issueStatusPriority(issue.status) < issueStatusPriority(existing.status)) {
      byId.set(issue.id, issue);
    }
  }
  return [...byId.values()].sort((a, b) => String(b.id).localeCompare(String(a.id), undefined, { numeric: true })); // newest first
}

const issues = {
  backlog: [],
  blocked: [],
  ready: [],
  inprogress: [],
  review: [],
  done: [],
};

for (const iss of loadIssues()) {
  if (iss.status === "backlog") {
    issues.backlog.push(iss);
  } else if (iss.status === "blocked") {
    issues.blocked.push(iss);
  } else if (iss.status === "in-progress") {
    issues.inprogress.push(iss);
  } else if (iss.status === "in-review") {
    issues.review.push(iss);
  } else if (iss.status === "done" || iss.status === "wont-fix") {
    // wont-fix is a label, not a separate lane — shown in Done with a tag
    issues.done.push(iss);
  } else {
    issues.ready.push(iss);
  }
}

const allIssueEntries = [
  ...issues.backlog,
  ...issues.ready,
  ...issues.inprogress,
  ...issues.review,
  ...issues.blocked,
  ...issues.done,
];
const issueIdsBySprint = new Map();
const completedIssueIdsBySprint = new Map();
// The rolling budget-window model (#2751) tags live work `sprint: current` — a
// non-numeric value the numbered bucketing below would drop. Collect it into a
// dedicated active-window bucket and emit a synthetic sprint object afterwards.
const currentIssueIds = new Set();
const currentCompletedIssueIds = new Set();
for (const issue of allIssueEntries) {
  if (issue.sprint === "current") {
    currentIssueIds.add(String(issue.id));
    if (issue.status === "done" || issue.status === "wont-fix") currentCompletedIssueIds.add(String(issue.id));
    continue;
  }
  const sprintNumber = extractSprintNumberFromLabel(issue.sprint);
  if (!Number.isFinite(sprintNumber)) continue;
  if (!issueIdsBySprint.has(sprintNumber)) issueIdsBySprint.set(sprintNumber, new Set());
  issueIdsBySprint.get(sprintNumber).add(String(issue.id));
  if (issue.status === "done" || issue.status === "wont-fix") {
    if (!completedIssueIdsBySprint.has(sprintNumber)) completedIssueIdsBySprint.set(sprintNumber, new Set());
    completedIssueIdsBySprint.get(sprintNumber).add(String(issue.id));
  }
}

writeFileSync(join(OUT, "issues.json"), JSON.stringify(issues, null, 2));
console.log(
  `Issues: ${issues.backlog.length} backlog, ${issues.ready.length} ready, ${issues.inprogress.length} in-progress, ${issues.review.length} in-review, ${issues.blocked.length} blocked, ${issues.done.length} done (incl. wont-fix)`,
);

// ── Load test262 runs ────────────────────────────────────────
const runsPath = join(ROOT, "benchmarks/results/runs/index.json");
let runs = [];
if (existsSync(runsPath)) {
  const all = JSON.parse(readFileSync(runsPath, "utf-8"));
  // Before Mar 20: smaller suite, keep all > 20K.
  // After the suite expansion, keep only full conformance runs and exclude
  // tiny crash artifacts, but do not require totals to stay near the old
  // proposal-inclusive 48K size because official-scope runs are lower.
  runs = all
    .filter((r) => {
      const ts = r.timestamp || "";
      if (ts < "2026-03-20") return r.total >= 20000;
      return r.total >= 40000;
    })
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
}
// Copy runs to data/ for the dashboard to fetch
writeFileSync(join(OUT, "runs.json"), JSON.stringify(runs));
console.log(`Test262 runs: ${runs.length} entries (filtered from raw data)`);

// ── Load sprints ─────────────────────────────────────────────
function findSprintFiles() {
  const files = [];
  for (const file of walkFiles(SPRINT_ROOT)) {
    // Post-flatten (#576): sprint docs are `plan/issues/sprints/<N>.md` directly
    // under SPRINT_ROOT. Match the numbered filename only when it sits directly
    // in SPRINT_ROOT so leftover sub-directory artifacts (e.g.
    // sprints/54/sprint-candidates.md) are ignored.
    if (dirname(file) === SPRINT_ROOT && /^\d+\.md$/.test(basename(file))) {
      const sprintNumber = extractSprintNumber(basename(file));
      if (Number.isFinite(sprintNumber)) files.push({ file, sprintNumber });
      continue;
    }
    // LEGACY layout: `plan/issues/sprints/<N>/sprint.md`.
    if (file.endsWith("/sprint.md")) {
      const sprintNumber = extractSprintNumber(basename(dirname(file)));
      if (Number.isFinite(sprintNumber)) files.push({ file, sprintNumber });
    }
  }
  if (existsSync(LEGACY_SPRINT_ROOT)) {
    for (const name of readdirSync(LEGACY_SPRINT_ROOT)) {
      if (!/^sprint-\d+\.md$/.test(name)) continue;
      const file = join(LEGACY_SPRINT_ROOT, name);
      const sprintNumber = extractSprintNumber(name);
      if (Number.isFinite(sprintNumber)) files.push({ file, sprintNumber });
    }
  }
  return files.sort((a, b) => a.sprintNumber - b.sprintNumber);
}

const sprints = [];
const sprintFiles = findSprintFiles();
for (const entry of sprintFiles) {
  const text = readFileSync(entry.file, "utf-8");
  const fm = parseFrontmatter(text);
  const name = `sprint ${entry.sprintNumber}`;

  // Extract date
  const dateM = text.match(/\*\*Date\*\*:\s*(.+)/);
  const date = dateM ? dateM[1].trim() : "";

  // Extract baseline
  const baseM = text.match(/\*\*Baseline\*\*:\s*(.+)/);
  const baseline = baseM ? baseM[1].trim() : "";

  // Extract result
  const resultM = text.match(/\*\*Final numbers?\*\*:\s*(.+)/i) || text.match(/\*\*Result\*\*:\s*(.+)/i);
  const result = resultM ? resultM[1].trim() : "";

  // Count merged issues
  const mergedCount = (text.match(/\*\*Merged\*\*/gi) || []).length;

  const sprintNumber = entry.sprintNumber;
  const explicitCarryOver =
    /Issues not completed in this sprint were returned to the backlog/i.test(text) ||
    /moved into \[sprint-\d+\.md\]/i.test(text) ||
    /contains only the unfinished carry-over work/i.test(text);
  const issueIds =
    sprintNumber != null
      ? [...(issueIdsBySprint.get(sprintNumber) || new Set())].sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true }),
        )
      : [];
  const completedIssueIds =
    sprintNumber != null
      ? [...(completedIssueIdsBySprint.get(sprintNumber) || new Set())].sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true }),
        )
      : [];
  sprints.push({
    name,
    sprintNumber,
    status: fm.status || "",
    date,
    baseline,
    result,
    issueCount: mergedCount,
    issueIds,
    completedIssueIds,
    explicitCarryOver,
  });
}
// Determine isClosed / isPlanning using explicit frontmatter status where available.
// Legacy sprints (status === "") fall back to the maxSprintNumber heuristic, but
// only compared against other legacy sprints so that new "planning" sprints don't
// push the current active sprint into isClosed.
const CLOSED_STATUSES = new Set(["closed", "done"]);
// "planned" is a not-yet-current state: such a sprint exists and renders in the
// dashboard sprint list, but it is NOT the active sprint. It must be excluded
// from "current active" selection (statusline + dashboard getLatestActiveSprint),
// which select the highest sprintNumber with !isClosed && !isPlanning. Treating
// "planned" as planning (isClosed=false, isPlanning=true) keeps it visible as an
// upcoming sprint while preventing it from shadowing the truly "active" sprint.
const ACTIVE_STATUSES = new Set(["active"]);
const PLANNING_STATUSES = new Set(["planning", "planned"]);
const explicitlyClosedMax = Math.max(
  ...sprints.filter((s) => CLOSED_STATUSES.has(s.status)).map((s) => s.sprintNumber || 0),
  0,
);
for (const sprint of sprints) {
  sprint.isPlanning = PLANNING_STATUSES.has(sprint.status);
  if (CLOSED_STATUSES.has(sprint.status)) {
    sprint.isClosed = true;
  } else if (ACTIVE_STATUSES.has(sprint.status) || PLANNING_STATUSES.has(sprint.status)) {
    sprint.isClosed = false;
  } else {
    // Legacy sprint with no status field: closed if at or below the explicit threshold.
    sprint.isClosed = sprint.sprintNumber <= explicitlyClosedMax || sprint.explicitCarryOver;
  }
}

// Synthetic active-window sprint for the rolling `sprint: current` model (#2751).
// It has no `sprints/<N>.md` doc, so it is built here from the collected current
// bucket and appended with a finite sentinel number (highest numbered sprint + 1)
// so the dashboard's `Number.isFinite(sprintNumber)` filters include it and
// `getLatestActiveSprint` selects it. `isCurrent` lets consumers label it "current".
if (currentIssueIds.size > 0) {
  const maxSprintNumber = sprints.reduce(
    (m, s) => Math.max(m, Number.isFinite(s.sprintNumber) ? s.sprintNumber : 0),
    0,
  );
  const sortIds = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  sprints.push({
    name: "current",
    sprintNumber: maxSprintNumber + 1,
    status: "active",
    date: "",
    baseline: "",
    result: "",
    issueCount: currentIssueIds.size,
    issueIds: [...currentIssueIds].sort(sortIds),
    completedIssueIds: [...currentCompletedIssueIds].sort(sortIds),
    explicitCarryOver: false,
    isCurrent: true,
    isClosed: false,
    isPlanning: false,
  });
}
writeFileSync(join(OUT, "sprints.json"), JSON.stringify(sprints, null, 2));
console.log(`Sprints: ${sprints.length} entries`);

// ── Also write embedded data for file:// mode ────────────────
const embedded = `// Auto-generated by build-data.js — do not edit
window.__DASHBOARD_DATA__ = ${JSON.stringify({ issues, runs, sprints })};
`;
writeFileSync(join(import.meta.dirname, "data.js"), embedded);
console.log("Wrote dashboard/data.js (embedded mode)");

// Graph files live in public/ (served by Vite + included in pages-dist via build)

// ── Feature test stats (#1327) ───────────────────────────────────
//
// Augments public/feature-examples.json with per-feature test262 stats
// (`testCategories`, `passCount`, `totalCount`, `tests[]`) so the landing
// page can surface live pass/fail counts and link to the new feature
// report page (public/benchmarks/feature-report.html).
//
// Each feature is mapped (by name) to one or more test262 path prefixes.
// Prefixes match against `entry.file` as `test/<prefix>/...` — broad
// prefixes (e.g. `built-ins/Array`) cover all sub-tests. Per the spec
// (#1327) we use 1-5 prefixes per feature; a few features that span
// many sub-areas (e.g. Operators) get a slightly wider list.
//
// First-feature-wins: each test is bucketed into the FIRST feature whose
// testCategories prefix matches its file path. Order in feature-examples.json
// therefore matters — the iteration order is the priority order.
//
// #2665 — the name→test262-category map is the SINGLE SOURCE OF TRUTH for
// per-feature buckets and is shared with `scripts/derive-feature-badges.mjs`
// (which bakes the landing-page badges) so the two never drift. It lives in
// `scripts/feature-test-categories.json`. Object key order is preserved by
// JSON.parse, so first-match-wins priority is unchanged.
const FEATURE_TEST_CATEGORIES = JSON.parse(readFileSync(join(ROOT, "scripts/feature-test-categories.json"), "utf-8"));

/**
 * Compute per-feature test262 stats and rewrite public/feature-examples.json.
 * No-op if the file or the JSONL baseline is missing.
 *
 * @param {string} jsonlPath  Path to the test262 JSONL baseline.
 * @param {string} examplesPath  Path to public/feature-examples.json.
 */
function buildFeatureStats(jsonlPath, examplesPath) {
  if (!existsSync(examplesPath)) {
    console.warn(`Feature stats: ${examplesPath} not found, skipping.`);
    return;
  }
  const examples = JSON.parse(readFileSync(examplesPath, "utf-8"));
  if (!Array.isArray(examples?.features)) {
    console.warn(`Feature stats: ${examplesPath} has no features array, skipping.`);
    return;
  }

  // Attach testCategories to every feature first (always — useful for the
  // feature-report page even when the baseline JSONL is unavailable).
  for (const feature of examples.features) {
    feature.testCategories = FEATURE_TEST_CATEGORIES[feature.name] ?? [];
    feature.passCount = 0;
    feature.totalCount = 0;
    feature.tests = [];
  }

  if (!existsSync(jsonlPath)) {
    console.warn(`Feature stats: ${jsonlPath} not found — features tagged with empty stats.`);
    examples.features_generated = new Date().toISOString();
    writeFileSync(examplesPath, JSON.stringify(examples, null, 2));
    return;
  }

  // Build a list of (feature, prefixes) tuples in feature-list order so first
  // match wins, plus a same-order array of accumulators.
  const lookup = examples.features.map((f) => ({
    feature: f,
    prefixes: f.testCategories,
    pass: 0,
    total: 0,
    tests: [],
  }));

  const lines = readFileSync(jsonlPath, "utf-8").split("\n");
  let bucketed = 0;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const file = String(entry.file || "");
    if (!file) continue;
    // Match against `test/<prefix>/` so prefix `built-ins/Array` does NOT
    // match `built-ins/ArrayBuffer`.
    let matched = null;
    for (const slot of lookup) {
      for (const prefix of slot.prefixes) {
        if (file === `test/${prefix}` || file.startsWith(`test/${prefix}/`)) {
          matched = slot;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) continue;
    bucketed++;
    matched.total++;
    if (entry.status === "pass") matched.pass++;
    matched.tests.push({
      file,
      status: entry.status,
      error: entry.error ?? "",
      error_category: entry.error_category ?? "",
    });
  }

  // Sort failures first, then compile_error, then pass; cap per feature at 500.
  const STATUS_RANK = { fail: 0, compile_error: 1, compile_timeout: 2, skip: 3, pass: 4 };
  const TESTS_PER_FEATURE_CAP = 500;
  for (const slot of lookup) {
    slot.tests.sort((a, b) => {
      const ra = STATUS_RANK[a.status] ?? 9;
      const rb = STATUS_RANK[b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      return a.file.localeCompare(b.file);
    });
    slot.feature.passCount = slot.pass;
    slot.feature.totalCount = slot.total;
    slot.feature.testsTruncated = slot.tests.length > TESTS_PER_FEATURE_CAP;
    slot.feature.tests = slot.tests.slice(0, TESTS_PER_FEATURE_CAP);
  }

  examples.features_generated = new Date().toISOString();
  writeFileSync(examplesPath, JSON.stringify(examples, null, 2));
  console.log(
    `Feature stats: bucketed ${bucketed} of ${lines.length - 1} test262 entries across ${
      examples.features.length
    } features.`,
  );
}

// #1528 — the JSONL is no longer committed to the main repo. Prefer the
// fetched cache from `scripts/fetch-baseline-jsonl.mjs`, then the legacy
// in-repo path (for backwards compatibility with workflows that still write
// it locally), then the `public/` copy populated by `deploy-pages.yml`.
function resolveBaselineJsonl() {
  const candidates = [
    join(ROOT, ".test262-cache/test262-current.jsonl"),
    join(ROOT, "benchmarks/results/test262-current.jsonl"),
    join(ROOT, "website/public/benchmarks/results/test262-results.jsonl"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Return the legacy path so the "not found" warning still points
  // somewhere informative.
  return candidates[1];
}
buildFeatureStats(resolveBaselineJsonl(), join(ROOT, "website/public/feature-examples.json"));

console.log("Done. Open dashboard/index.html in a browser.");
