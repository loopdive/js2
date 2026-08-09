#!/usr/bin/env node
// budget-status.mjs — pull-time budget + parallelism awareness (#2751).
//
// An agent about to claim a new task runs this FIRST to learn:
//   • the remaining token budget in the current window,
//   • the current parallelism (how many agents are active),
//   • the per-agent budget share, and
//   • the largest task HORIZON it should pull so it does not overrun the window.
//
// Then it claims an adequately-sized task: highest-priority `sprint: current`
// task whose `[horizon]` fits. This realises "prefer long-horizon tasks at the
// beginning of a budget" structurally — at a fresh window the per-agent share is
// large so XL/L tasks fit and are surfaced first (big rocks first); as the window
// drains (or parallelism rises) the share shrinks and only smaller tasks are
// recommended, with S tasks as the always-available tail filler. A task too big
// for the remaining share is deferred to the next window's start, never started
// late where it would strand.
//
// BUDGET SOURCE: the statusline (.claude/statusline-command.sh, which shows "wkly"
// % and "d left") caches rate_limits.seven_day to ~/.claude/js2wasm-budget.json on
// every render; this script reads it automatically. Env vars below override it; with
// neither cache nor env it assumes a fresh window (R=100%) so it recommends big rocks
// rather than falsely deferring.
//
// INPUTS (env; all optional):
//   JS2WASM_BUDGET_REMAINING_PCT   remaining budget, 0..100   (overrides cache)
//   JS2WASM_BUDGET_PCT             spent budget, 0..100        (remaining = 100 - spent)
//   JS2WASM_PARALLELISM            active-agent count override (else auto-detected)
//   JS2WASM_HORIZON_COSTS          JSON override of class costs, e.g. {"xl":0.25,...}
//
// Usage:
//   node scripts/budget-status.mjs            # human summary + recommended max horizon
//   node scripts/budget-status.mjs --pick      # also print the best-fit claimable task(s)
//   node scripts/budget-status.mjs --json       # machine-readable
//   node scripts/budget-status.mjs --quiet      # one line (for statuslines/hooks)
//
// CLAIMABILITY (#3965) ---------------------------------------------------------
// `--pick` used to rank on `priority` + `horizon` ALONE. It never asked whether
// a candidate was already claimed, nor whether the agent reading the list was
// even allowed to take it — so it recommended work `scripts/pre-dispatch-gate.mjs`
// then refused. Measured 2026-08-01: 5 of 5 XL suggestions unusable for an
// Opus-lane developer (one CLAIMED live, four `model: fable`), and 5 of 5 at the
// live L setting too. Because `--pick` is the documented FIRST step of the dev
// claim loop, that is a duplicate-dispatch amplifier: the agent burns context
// orienting on the issue and only the pre-dispatch gate catches it.
//
// So `--pick` now also filters on:
//   • the LIVE claim ref (`refs/heads/issue-assignments`), read at the moment of
//     the call via `claim-issue.mjs --list --json` — never from a cached fetch,
//     because a stale read is precisely the bug being fixed here;
//   • role scope (title role-tags + `task_type:`) and lane (`model:`).
//
// Every exclusion is PRINTED with its reason, and the funnel counts are printed
// too. A picker that quietly returns fewer rows is indistinguishable from one
// that found nothing — the silent-empty family. Zero returned must be
// distinguishable from zero considered, and "no claims" from "claims unreadable".
//
// Identity flags (all optional; each one absent is announced, never silently
// treated as "no filter needed"):
//   --as <ttraenkler/name>   requesting agent — its OWN claim is not a blocker
//   --role <role>            developer (default) | senior-developer | architect |
//                            product-owner | tech-lead | any
//   --model <name>           opus | fable | sonnet | … — skips issues pinned to a
//                            different lane. Absent ⇒ model filter NOT applied.
//   --limit <n>              rows to print (default 5); truncation is disclosed
//   --no-claim-check         skip the claim-ref read (offline); every row is then
//                            stamped UNVERIFIED

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const PICK = args.includes("--pick");
const JSON_OUT = args.includes("--json");
const QUIET = args.includes("--quiet");
const NO_CLAIM_CHECK = args.includes("--no-claim-check");
function argValue(name, fallback = "") {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}
const AS = argValue("--as", process.env.JS2WASM_AGENT || "");
// `--role` has a default, so unlike --model its absence is not self-announcing:
// an architect passing only `--as` would get developer scope applied silently,
// with exclusions printed against a role it never claimed. Track WHERE the value
// came from so the report can say "assumed" rather than implying it was asked for.
const ROLE_RAW = argValue("--role", process.env.JS2WASM_ROLE || "");
const ROLE_DEFAULTED = !ROLE_RAW;
const ROLE = (ROLE_RAW || "developer").toLowerCase();
const MODEL_RAW = argValue("--model", process.env.JS2WASM_MODEL || "");
const LIMIT = Math.max(1, Number(argValue("--limit", "5")) || 5);

const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), ".claude");
const TASKS_ROOT = join(CLAUDE_HOME, "tasks");
const TEAM = process.env.JS2WASM_TEAM || "js2wasm";
const TEAM_DIR = join(TASKS_ROOT, TEAM);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_REPO = resolve(SCRIPT_DIR, "..");
// A cwd without `plan/issues` would silently yield ZERO candidates, which reads
// exactly like "the queue is empty". Fall back to the script's own repo root and
// say so, rather than reporting an empty queue that isn't.
const REPO_REQUESTED = process.env.REPO_ROOT || process.cwd();
const REPO = existsSync(join(REPO_REQUESTED, "plan", "issues")) ? REPO_REQUESTED : SCRIPT_REPO;
const REPO_FELL_BACK = REPO !== REPO_REQUESTED;
const ISSUES_DIR = join(REPO, "plan", "issues");
const CLAIM_SCRIPT = join(SCRIPT_REPO, "scripts", "claim-issue.mjs");

// Horizon cost as a FRACTION OF A FULL BUDGET WINDOW. Tunable via env; the
// relative ordering is what matters more than the absolute numbers.
const DEFAULT_COSTS = { xl: 0.25, l: 0.12, m: 0.05, s: 0.015 };
const HORIZON_COSTS = (() => {
  try {
    return {
      ...DEFAULT_COSTS,
      ...(process.env.JS2WASM_HORIZON_COSTS ? JSON.parse(process.env.JS2WASM_HORIZON_COSTS) : {}),
    };
  } catch {
    return DEFAULT_COSTS;
  }
})();
const CLASSES_BIG_FIRST = ["xl", "l", "m", "s"]; // cost-descending
const SLACK = 0.03;
const PRIO_RANK = { high: 1, medium: 2, low: 3 };

// --- weekly budget cache (written by the statusline, #2751) -------------------
// .claude/statusline-command.sh caches rate_limits.seven_day here on every render
// (the "wkly" / "d left" indicators); standalone scripts can't see that stdin JSON
// otherwise. { seven_day_used_pct, resets_at, written_at }.
function readBudgetCache() {
  try {
    const c = JSON.parse(readFileSync(join(CLAUDE_HOME, "js2wasm-budget.json"), "utf8"));
    return c && Number.isFinite(Number(c.seven_day_used_pct)) ? c : null;
  } catch {
    return null;
  }
}
const BUDGET_CACHE = readBudgetCache();

// --- remaining budget fraction R (0..1) ---------------------------------------
// Precedence: explicit env override → statusline weekly cache → fresh-window.
function remainingFraction() {
  const rem = Number(process.env.JS2WASM_BUDGET_REMAINING_PCT);
  if (Number.isFinite(rem)) return Math.max(0, Math.min(1, rem / 100));
  const spent = Number(process.env.JS2WASM_BUDGET_PCT);
  if (Number.isFinite(spent)) return Math.max(0, Math.min(1, (100 - spent) / 100));
  if (BUDGET_CACHE) return Math.max(0, Math.min(1, (100 - Number(BUDGET_CACHE.seven_day_used_pct)) / 100));
  return 1; // no budget source → assume a fresh window
}
const budgetKnown =
  Number.isFinite(Number(process.env.JS2WASM_BUDGET_REMAINING_PCT)) ||
  Number.isFinite(Number(process.env.JS2WASM_BUDGET_PCT)) ||
  BUDGET_CACHE != null;

// Days left in the weekly window (from the statusline cache's reset timestamp).
function daysLeft() {
  if (!BUDGET_CACHE || !Number.isFinite(Number(BUDGET_CACHE.resets_at))) return null;
  const secs = Number(BUDGET_CACHE.resets_at) - Date.now() / 1000;
  return secs > 0 ? secs / 86400 : 0;
}

// --- task stores --------------------------------------------------------------
function taskStoreDirs() {
  if (!existsSync(TASKS_ROOT)) return [];
  const dirs = [];
  for (const name of readdirSync(TASKS_ROOT)) {
    const p = join(TASKS_ROOT, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name) || /^session-/.test(name);
    const fresh = Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000;
    if (name === TEAM || (isUuid && fresh)) dirs.push(p);
  }
  return dirs;
}
function allTasks() {
  const byId = new Map();
  for (const dir of taskStoreDirs()) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => /\.json$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (t && t.id) byId.set(String(t.id) + "@" + (dir === TEAM_DIR ? "team" : "sess"), t);
      } catch {
        /* skip */
      }
    }
  }
  return [...byId.values()];
}

// --- parallelism: distinct owners of in_progress tasks (min 1) ----------------
function parallelism() {
  const env = Number(process.env.JS2WASM_PARALLELISM);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  const owners = new Set();
  for (const t of allTasks()) {
    if (t.status === "in_progress" && t.owner) owners.add(t.owner);
  }
  return Math.max(1, owners.size);
}

// --- recommended max horizon for a per-agent share ----------------------------
function maxHorizonFor(share) {
  for (const c of CLASSES_BIG_FIRST) {
    if (HORIZON_COSTS[c] <= share + SLACK) return c;
  }
  return "s"; // even S over budget → still allow the tail filler, but flag it
}

// --- frontmatter (minimal) ----------------------------------------------------
function parseFM(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fm[mm[1].toLowerCase()] = v;
  }
  return fm;
}
function normHorizon(v) {
  const s = (v || "").toString().trim().toLowerCase();
  if (["xl", "xlarge", "x-large", "epic"].includes(s)) return "xl";
  if (["l", "large", "big"].includes(s)) return "l";
  if (["s", "small", "tiny", "trivial"].includes(s)) return "s";
  return "m";
}
// Lane pin (#3965). `model:` is written on 306 issues today and, before this,
// was read by NOTHING — so its consumer semantics are defined here and mirrored
// into plan/issues/SCHEMA.md: EXACT-MATCH-OR-UNSET. An issue with no `model:`
// is claimable by any lane; an issue pinned to a lane is skipped for every other
// one. `Opus 5` / `opus-5` / `opus` all normalise to `opus`, so an agent may pass
// the model name it knows itself by; `gpt-5.6-sol` keeps its non-numeric tail.
function normModel(v) {
  return (v || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-?\d+(\.\d+)*$/, "");
}
const MODEL = normModel(MODEL_RAW);

// Role scope. Mirrors the pre-claim gate documented in .claude/agents/developer.md
// and CLAUDE.md ("Owner pins + scope are how the auto-dispatcher is steered").
//
// DENY-lists, not allow-lists, and the asymmetry is deliberate — the same one
// scripts/lib/claim-record.mjs argues for heldness. `task_type:` has 57 distinct
// values in the wild against SCHEMA.md's 10, so an allow-list would silently drop
// every unrecognised type (a real task made invisible, and invisibly so). A
// deny-list sends the unknown down the safe path: it stays visible, and the agent
// still has the pre-dispatch gate behind it.
const tag = (label, re) => ({ label, re });
const PARKED = [tag("[PARKED]", /\[PARKED/i), tag("[PAUSE]", /\[PAUSE\]/i)];
const ROLE_RULES = {
  developer: {
    denyTitle: [
      ...PARKED,
      tag("[SENIOR-DEV ONLY]", /\[SENIOR-DEV ONLY\]/i),
      tag("[ARCH]", /\[ARCH\]/i),
      tag("arch(...)", /\barch\(/i),
      tag("[EPIC]", /\[EPIC\]/i),
      tag("[CONFLICT]", /\[CONFLICT\]/i),
      tag("[PO]", /\[PO\]/i),
      tag("po:", /^po:/i),
    ],
    denyTaskType: [
      "architecture",
      "architectural",
      "architect-spec",
      "epic",
      "umbrella",
      "planning",
      "meta",
      "decision",
      "process",
      "review",
    ],
  },
  "senior-developer": {
    denyTitle: [
      ...PARKED,
      tag("[ARCH]", /\[ARCH\]/i),
      tag("arch(...)", /\barch\(/i),
      tag("[PO]", /\[PO\]/i),
      tag("po:", /^po:/i),
    ],
    denyTaskType: ["architect-spec", "planning", "meta", "decision", "process", "review"],
  },
  architect: {
    denyTitle: [
      ...PARKED,
      tag("[SENIOR-DEV ONLY]", /\[SENIOR-DEV ONLY\]/i),
      tag("[CONFLICT]", /\[CONFLICT\]/i),
      tag("[PO]", /\[PO\]/i),
      tag("po:", /^po:/i),
    ],
    denyTaskType: [],
  },
  "product-owner": {
    denyTitle: [
      ...PARKED,
      tag("[SENIOR-DEV ONLY]", /\[SENIOR-DEV ONLY\]/i),
      tag("[ARCH]", /\[ARCH\]/i),
      tag("[CONFLICT]", /\[CONFLICT\]/i),
    ],
    denyTaskType: [],
  },
  "tech-lead": { denyTitle: [...PARKED], denyTaskType: [] },
  any: { denyTitle: [...PARKED], denyTaskType: [] },
};
const ROLE_KNOWN = Object.prototype.hasOwnProperty.call(ROLE_RULES, ROLE);
const RULES = ROLE_KNOWN ? ROLE_RULES[ROLE] : ROLE_RULES.any;

function scanIssues() {
  const scanned = { files: 0, current_ready: 0 };
  if (!existsSync(ISSUES_DIR)) return { issues: [], scanned };
  const out = [];
  for (const f of readdirSync(ISSUES_DIR)) {
    if (!/^\d+[a-z]?-.+\.md$/i.test(f)) continue;
    scanned.files++;
    let text;
    try {
      text = readFileSync(join(ISSUES_DIR, f), "utf8");
    } catch {
      continue;
    }
    const fm = parseFM(text);
    if ((fm.sprint || "").toLowerCase() !== "current") continue;
    if ((fm.status || "").toLowerCase() !== "ready") continue; // claimable = ready & unowned
    scanned.current_ready++;
    out.push({
      id: (fm.id || f.match(/^(\d+[a-z]?)-/i)?.[1] || "").toLowerCase(),
      title: fm.title || "",
      priority: (fm.priority || "medium").toLowerCase(),
      horizon: normHorizon(fm.horizon || fm.cost),
      task_type: (fm.task_type || "").toLowerCase(),
      model: normModel(fm.model),
      goal: (fm.goal || "").toLowerCase(),
      file: f,
    });
  }
  return { issues: out, scanned };
}

// --- LIVE claim-ref read (#3965) ---------------------------------------------
// Delegated to `claim-issue.mjs --list --json` on purpose:
//   • it is the only read path with the tri-state hardening (an unreadable ref
//     exits 6 instead of falling through to "unassigned" — #3880);
//   • it uses the warm cache repo, so a FRESH read costs ~1.4 s where a direct
//     fetch of the ref into a full working repo measured 1 m 45 s. Cheapness is
//     what makes reading it at the moment of the call practical at all;
//   • it shares ONE `isHeldRecord`, so this filter cannot drift away from the
//     pre-dispatch gate's answer the way two hand-rolled predicates already did.
//
// The failure mode this function exists to NOT have: `catch { return [] }`.
// Zero claims and an unreadable ref would then be the same value, every
// candidate would pass the filter, and `--pick` would print a confident,
// unfiltered list — the defect, relocated one layer up. So the read is
// tri-state: ok | skipped | unreadable, and the caller must handle unreadable.
function readLiveClaims() {
  if (NO_CLAIM_CHECK) return { state: "skipped", byId: new Map(), reason: "--no-claim-check" };
  if (!existsSync(CLAIM_SCRIPT)) {
    return { state: "unreadable", byId: new Map(), error: `claim-issue.mjs not found at ${CLAIM_SCRIPT}` };
  }
  const r = spawnSync(process.execPath, [CLAIM_SCRIPT, "--list", "--json"], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Number(process.env.JS2WASM_CLAIM_READ_TIMEOUT_MS) || 180000,
  });
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ");
    return { state: "unreadable", byId: new Map(), error: `claim-issue.mjs --list --json exited ${r.status}: ${tail}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return { state: "unreadable", byId: new Map(), error: `unparseable claim JSON: ${e.message}` };
  }
  if (!parsed || !Array.isArray(parsed.held)) {
    return { state: "unreadable", byId: new Map(), error: "claim JSON has no `held` array" };
  }
  // Index by base id. A SLICE claim (`<id>-<slice>.json`) still counts: part of
  // the issue is being worked, so recommending the whole thing to a second agent
  // is the collision this filter exists to stop.
  const byId = new Map();
  for (const h of parsed.held) {
    const key = String(h.id).toLowerCase();
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(h);
  }
  return { state: "ok", byId, tip: parsed.tip || "", total: parsed.total_records || 0, held: parsed.held_count || 0 };
}

// --- compute ------------------------------------------------------------------
const R = remainingFraction();
const N = parallelism();
const share = R / N;
const maxHz = maxHorizonFor(share);
const fitsCost = HORIZON_COSTS[maxHz];
const fresh = maxHz === "xl" || maxHz === "l"; // window has runway for big rocks
const allowed = CLASSES_BIG_FIRST.filter((c) => HORIZON_COSTS[c] <= HORIZON_COSTS[maxHz]); // <= maxHz cost

// Four-stage funnel, every stage counted and every drop explained (#3965).
//   scanned → considered (sprint:current + ready) → horizon-fit
//           → after claim filter → after scope filter → returned
// Skip REASONS are recorded only from the horizon-fit stage onward: an issue
// dropped for horizon is already explained by the two counts, whereas an issue
// dropped for being claimed or out-of-lane is exactly what the caller cannot
// otherwise see.
function pickTasks(claims) {
  const { issues, scanned } = scanIssues();
  const skipped = [];
  const funnel = {
    scanned_issue_files: scanned.files,
    considered: issues.length,
    horizon_fit: 0,
    after_claim_filter: 0,
    after_scope_filter: 0,
    returned: 0,
    truncated: 0,
  };

  const fit = issues.filter((i) => allowed.includes(i.horizon));
  funnel.horizon_fit = fit.length;

  // Stage: live claim. `unreadable` deliberately does NOT drop anything — an
  // unverified list is announced as unverified, never silently presented as
  // filtered. Refusing to answer at all is handled by the caller's exit code.
  const afterClaim = [];
  for (const i of fit) {
    const held = claims.state === "ok" ? claims.byId.get(i.id) || [] : [];
    const byOthers = AS ? held.filter((h) => h.assignee !== AS) : held;
    if (byOthers.length) {
      const h = byOthers[0];
      skipped.push({
        id: i.id,
        stage: "claim",
        reason: `claimed by ${h.assignee}${h.slice ? ` (slice ${h.slice})` : ""} since ${h.claimed_at || "?"}${h.branch ? ` on ${h.branch}` : ""}`,
      });
      continue;
    }
    if (held.length && AS) i.note = `your own claim (${AS}) — resuming`;
    afterClaim.push(i);
  }
  funnel.after_claim_filter = afterClaim.length;

  // Stage: role scope + lane.
  const afterScope = [];
  for (const i of afterClaim) {
    const badTitle = RULES.denyTitle.find((t) => t.re.test(i.title));
    if (badTitle) {
      skipped.push({
        id: i.id,
        stage: "scope",
        reason: `title carries ${badTitle.label} — out of scope for role ${ROLE}`,
      });
      continue;
    }
    if (i.task_type && RULES.denyTaskType.includes(i.task_type)) {
      skipped.push({ id: i.id, stage: "scope", reason: `task_type: ${i.task_type} — not claimable by role ${ROLE}` });
      continue;
    }
    if (MODEL && i.model && i.model !== MODEL) {
      skipped.push({
        id: i.id,
        stage: "lane",
        reason: `model: ${i.model} — pinned to another lane (you are ${MODEL})`,
      });
      continue;
    }
    afterScope.push(i);
  }
  funnel.after_scope_filter = afterScope.length;

  afterScope.sort((a, b) => {
    if (fresh) {
      // big rocks first, then priority
      const hc = HORIZON_COSTS[b.horizon] - HORIZON_COSTS[a.horizon];
      if (hc) return hc;
      return PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
    }
    // draining: priority first, then smallest (tail-pack)
    const pr = PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
    if (pr) return pr;
    return HORIZON_COSTS[a.horizon] - HORIZON_COSTS[b.horizon];
  });

  const returned = afterScope.slice(0, LIMIT);
  funnel.returned = returned.length;
  funnel.truncated = Math.max(0, afterScope.length - returned.length);
  // Sorted for a stable, readable report; the id order is not a ranking.
  skipped.sort((a, b) => Number(a.id) - Number(b.id));
  return { picks: returned, skipped, funnel, all: afterScope };
}

const wantPicks = PICK || JSON_OUT;
const claims = wantPicks ? readLiveClaims() : { state: "not-requested", byId: new Map() };
const result = wantPicks ? pickTasks(claims) : { picks: [], skipped: [], funnel: null, all: [] };
const picks = result.picks;
// UNKNOWN must never fall on the reassuring side: when the claim ref could not
// be read, the recommendation is UNVERIFIED and the process exits non-zero so a
// scripted caller cannot mistake it for a filtered list. `--no-claim-check` is
// the explicit, recorded opt-out.
const claimUnverified = wantPicks && claims.state !== "ok";
const EXIT_CODE = wantPicks && claims.state === "unreadable" ? 6 : 0;

// --- output -------------------------------------------------------------------
const pctRem = Math.round(R * 100);
const dl = daysLeft();
const src = budgetKnown
  ? BUDGET_CACHE &&
    !Number.isFinite(Number(process.env.JS2WASM_BUDGET_REMAINING_PCT)) &&
    !Number.isFinite(Number(process.env.JS2WASM_BUDGET_PCT))
    ? " (source: statusline weekly cache)"
    : ""
  : " (no budget source — assuming fresh window; statusline writes ~/.claude/js2wasm-budget.json, or set JS2WASM_BUDGET_REMAINING_PCT)";

// Provenance travels WITH the picks, in both output shapes. A consumer that
// reads `picks` without knowing whether the claim filter actually ran is back to
// trusting a possibly-unverified list, so `claim_ref` and `filters_applied` are
// fields, not just human-readable banners.
const claimRefReport = {
  state: claims.state,
  ...(claims.state === "ok" ? { tip: claims.tip, total_records: claims.total, held_count: claims.held } : {}),
  ...(claims.state === "unreadable" ? { error: claims.error } : {}),
  ...(claims.state === "skipped" ? { reason: claims.reason } : {}),
};
const filtersApplied = {
  claim: claims.state === "ok",
  scope: wantPicks,
  role: ROLE_KNOWN ? ROLE : `${ROLE} (unknown role — fell back to "any", scope filter effectively OFF)`,
  role_defaulted: ROLE_DEFAULTED,
  model: MODEL ? MODEL : false,
  identity: AS || false,
};

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        remaining_pct: pctRem,
        budget_known: budgetKnown,
        days_left: dl == null ? null : Number(dl.toFixed(2)),
        parallelism: N,
        per_agent_share: Number(share.toFixed(3)),
        recommended_max_horizon: maxHz,
        recommended_max_horizon_cost: fitsCost,
        allowed_horizons: allowed,
        phase: fresh ? "fresh-big-rocks-first" : "draining-small-first",
        issues_dir: ISSUES_DIR,
        issues_dir_fell_back: REPO_FELL_BACK,
        claim_ref: claimRefReport,
        filters_applied: filtersApplied,
        picks_unverified: claimUnverified,
        funnel: result.funnel,
        skipped: result.skipped,
        picks: picks.map((p) => ({
          id: p.id,
          horizon: p.horizon,
          priority: p.priority,
          title: p.title.slice(0, 70),
          ...(p.note ? { note: p.note } : {}),
          ...(claimUnverified ? { unverified: true } : {}),
        })),
      },
      null,
      2,
    ),
  );
} else if (QUIET) {
  console.log(
    `budget ${pctRem}% rem${dl == null ? "" : ` | ${dl.toFixed(1)}d left`} | ${N} agents | share ${(share * 100).toFixed(0)}% | pull ≤ ${maxHz.toUpperCase()}${budgetKnown ? "" : " (assumed)"}`,
  );
} else {
  console.log(`\nbudget-status${src}`);
  console.log(`  remaining budget : ${pctRem}%${dl == null ? "" : `   (${dl.toFixed(1)}d left in window)`}`);
  console.log(`  parallelism      : ${N} active agent(s)`);
  console.log(`  per-agent share  : ${(share * 100).toFixed(0)}% of a window`);
  console.log(`  → pull a task ≤ horizon ${maxHz.toUpperCase()} (cost ≤ ${(fitsCost * 100).toFixed(1)}% of window)`);
  console.log(
    `  phase            : ${fresh ? "fresh → big rocks first (XL/L before M/S)" : "draining → priority + smallest-first tail-pack"}`,
  );
  if (maxHz === "s" && share + SLACK < HORIZON_COSTS.s) {
    console.log(`  ⚠ budget nearly exhausted — only S tail-filler advisable; defer larger work to the next window.`);
  }
  if (REPO_FELL_BACK) {
    console.log(`  note             : no plan/issues under ${REPO_REQUESTED} — reading ${ISSUES_DIR} instead`);
  }
  if (PICK) {
    const f = result.funnel;
    console.log(`\n  claim ref        : ${describeClaimRef()}`);
    console.log(`  filters          : ${describeFilters()}`);
    console.log(
      `  funnel           : scanned ${f.scanned_issue_files} issue files → considered ${f.considered} (sprint: current + ready) ` +
        `→ horizon-fit ${f.horizon_fit} → after claim ${f.after_claim_filter} → after scope ${f.after_scope_filter} → returned ${f.returned}` +
        (f.truncated ? ` (+${f.truncated} more not shown; --limit ${LIMIT})` : ""),
    );

    if (result.skipped.length) {
      console.log(`\n  skipped (${result.skipped.length}) — every drop, with its reason:`);
      for (const s of result.skipped) console.log(`    skipped #${s.id}: ${s.reason}`);
    } else {
      console.log(`\n  skipped (0) — nothing was dropped by the claim or scope filters.`);
    }

    console.log(
      `\n  best-fit claimable tasks (sprint: current, ready, horizon ≤ ${maxHz.toUpperCase()}, role ${ROLE}${MODEL ? `, model ${MODEL}` : ""}):`,
    );
    if (!picks.length) {
      // Zero returned must never be mistaken for zero considered.
      console.log(
        `    (none returned — considered ${f.considered}, horizon-fit ${f.horizon_fit}, ` +
          `${f.horizon_fit - f.after_claim_filter} dropped as claimed, ` +
          `${f.after_claim_filter - f.after_scope_filter} dropped as out-of-scope. ` +
          `${f.considered === 0 ? "The queue itself is EMPTY." : "The queue is NOT empty — the fitting work is taken or out of your lane."})`,
      );
    }
    for (const p of picks) {
      console.log(
        `    #${p.id}  [${p.priority}] [${p.horizon.toUpperCase()}]  ${p.title.slice(0, 66)}` +
          (p.note ? `  ← ${p.note}` : "") +
          (claimUnverified ? `  [UNVERIFIED]` : ""),
      );
    }
  }
  console.log("");
}

// Last line is a verdict (the #3880 convention): callers pipe this, and a pipe
// reports the LAST stage's exit status, so the exit code alone is not legible.
function describeClaimRef() {
  if (claims.state === "ok") {
    return `READ LIVE just now — ${claims.held} live claim(s) of ${claims.total} record(s) @ ${String(claims.tip).slice(0, 12)}`;
  }
  if (claims.state === "skipped") return `NOT READ (--no-claim-check) — claim filter NOT applied, picks are UNVERIFIED`;
  if (claims.state === "unreadable") return `UNREADABLE — ${claims.error}`;
  return "not requested (run with --pick)";
}
function describeFilters() {
  const parts = [];
  parts.push(claims.state === "ok" ? "claim=on (live)" : "claim=OFF");
  parts.push(
    ROLE_KNOWN
      ? `role=${ROLE}${ROLE_DEFAULTED ? " (DEFAULT — no --role/$JS2WASM_ROLE given; scope filtered as a developer)" : ""}`
      : `role=${ROLE} UNKNOWN → scope filter effectively OFF`,
  );
  parts.push(MODEL ? `model=${MODEL}` : "model=OFF (no --model/$JS2WASM_MODEL given — task lane NOT filtered)");
  parts.push(AS ? `as=${AS}` : "as=OFF (own claims cannot be distinguished from others')");
  return parts.join(", ");
}

if (wantPicks && !QUIET) {
  if (claims.state === "unreadable") {
    console.error(
      `budget-status: FAILED — the claim ref could not be read (${claims.error}). ` +
        `The ${picks.length} recommendation(s) above are UNFILTERED and may already be claimed. ` +
        `An unreadable ref is NOT an empty one — re-run, or pass --no-claim-check to accept unverified picks deliberately. (exit 6)`,
    );
  } else if (claims.state === "skipped") {
    console.error(
      `budget-status: OK (UNVERIFIED) — ${picks.length} pick(s) of ${result.funnel.after_scope_filter} claimable; ` +
        `claim filter deliberately skipped via --no-claim-check (exit 0)`,
    );
  } else {
    console.error(
      `budget-status: OK — ${picks.length} pick(s) returned of ${result.funnel.after_scope_filter} claimable, ` +
        `${result.funnel.considered} considered, ${result.skipped.length} skipped with reasons (exit 0)`,
    );
  }
}

process.exit(EXIT_CODE);
