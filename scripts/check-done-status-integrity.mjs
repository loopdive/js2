// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/check-done-status-integrity.mjs — done-status integrity gate (#3474).
//
// WHY THIS EXISTS
// ---------------
// A 2026-07-20 harvest found a systemic false-`done` problem: issues marked
// `status: done` whose cited test262 tests still FAIL. `done` drifts unreliable
// because nothing structurally couples the status flip to the code reality. The
// drift is also invisible to a commit-message grep — a fix can land without
// citing the issue number (#3449's fix `9761b20`), and a status can go stale
// without any commit at all. This gate keys on CODE STATE instead: the
// baselines-repo JSONL says which tests actually fail and which issue each
// failure cites, so "is #N really done?" is answered by measurement, not by a
// changelog.
//
// WHAT IT DOES (change-scoped, sibling to the #2093 probe gate):
//   - For each `plan/issues/*.md` CHANGED by this change-set that is
//     `status: done` and NOT exempt (`done_cited_ok: true`), count the LIVE
//     test262 failures citing its `#NNNN` across BOTH baseline lanes.
//   - FAIL when any such issue's citation count exceeds THRESHOLD — a PR must
//     not flip (or leave) an issue `done` while its own tests still fail citing
//     it. Reopen it (`status: ready`) or, for a legitimate detector / umbrella /
//     intentional-refusal issue whose citations are EXPECTED, mark it exempt.
//   - Change-scoped ⇒ a PR touching no `done` issue file does ZERO network work.
//     The heavy baseline fetch only happens when a `done` issue is actually
//     edited. On a baseline fetch failure the gate WARNS and PASSES — it is a
//     safety net, not a hard correctness gate, and a 3rd-party network blip must
//     never wedge the queue.
//
// EXEMPTION — a detector/umbrella/intentional-refusal issue (e.g. #2961 the
// host-import leak guard, or an "X is not yet supported in --target standalone
// (#N)" refusal) legitimately stays `done` while accumulating citations: the
// citations ARE the feature working. Mark such an issue exempt with a
// frontmatter flag:
//
//   done_cited_ok: true
//
// CITE EXTRACTION (robust, precision + recall):
//   - `#NNNN` in ANY form (parenthesized `(#N)`, bare `#N:` / `#N.` / `#N `),
//     because the compiler embeds issue tags both ways (`(#2043)`, `#1387:
//     with statement`, `deferred to #1472.`).
//   - EXCLUDING Wasm-index noise: `function #N` and `#N:"name"` (a function
//     index followed by a quoted name), which are runtime error text, not
//     issue references.
//   - AND cross-referenced against `plan/issues/N-*.md` EXISTENCE — a real cite
//     references a real issue file, which drops any residual index noise
//     regardless of surrounding punctuation.
//
// USAGE
//   node scripts/check-done-status-integrity.mjs            # change-scoped gate (CI)
//   node scripts/check-done-status-integrity.mjs --audit    # whole-tree audit (Part A)
//   node scripts/check-done-status-integrity.mjs --json     # machine-readable audit
//   THRESHOLD override: DONE_CITE_THRESHOLD env (default 15).

import { readdirSync, readFileSync, existsSync, createReadStream } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { resolveChangeBase, changedPaths } from "./lib/change-scope.mjs";
import {
  ensureBaselineJsonl,
  ensureStandaloneBaselineJsonl,
  BASELINE_CACHE_PATH,
  STANDALONE_BASELINE_CACHE_PATH,
} from "./fetch-baseline-jsonl.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const ISSUES_DIR = join(REPO_ROOT, "plan", "issues");

// A `done` issue may carry up to this many stray citations before it is flagged.
// Matches the 2026-07-20 harvest's ">=15 live failures" signal; a handful of
// incidental cites is noise, a sustained cluster is a real false-done.
const THRESHOLD = Number(process.env.DONE_CITE_THRESHOLD || "15");

/** id -> { status, doneCitedOk, file } for every issue file on disk. */
export function loadIssueIndex(dir = ISSUES_DIR) {
  const index = new Map();
  if (!existsSync(dir)) return index;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(\d+)[a-z]?-.+\.md$/i);
    if (!m) continue;
    const id = m[1];
    if (index.has(id)) continue; // first file wins (sub-id variants share the base)
    const meta = parseIssueFrontmatter(readFileSync(join(dir, f), "utf-8"));
    index.set(id, { ...meta, file: f });
  }
  return index;
}

/** Parse the `status`, `done_cited_ok`, and `title` frontmatter fields. */
export function parseIssueFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : "";
  const status = (fm.match(/^status:\s*"?(.*?)"?\s*$/m)?.[1] || "").toLowerCase();
  const title = fm.match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] || "";
  const doneCitedOk = /^done_cited_ok:\s*true\s*$/m.test(fm);
  return { status, title, doneCitedOk };
}

/**
 * Extract the set of issue ids CITED in one error string. Robust to both cite
 * forms; excludes Wasm function-index noise; keeps only ids that exist as an
 * issue file (`issueExists(id)`), which is the decisive noise filter. Pure +
 * exported for unit testing.
 *
 * @param {string} errorText
 * @param {(id: string) => boolean} issueExists
 * @returns {Set<string>}
 */
export function extractIssueCites(errorText, issueExists) {
  const out = new Set();
  if (!errorText) return out;
  for (const m of errorText.matchAll(/#(\d{2,4})/g)) {
    const id = m[1];
    const start = m.index;
    const before = errorText.slice(Math.max(0, start - 9), start);
    const after = errorText.slice(start + m[0].length, start + m[0].length + 2);
    if (before.endsWith("function ")) continue; // Wasm function index ("Compiling function #104")
    if (after.startsWith(':"')) continue; // function index + quoted name ("#104:\"__closure_26\"")
    if (!issueExists(id)) continue; // not a real issue → residual index noise
    out.add(id);
  }
  return out;
}

/**
 * Stream a baseline JSONL and count, per issue id, how many FAILING records
 * cite it (once per record). Only the ids in `wanted` are counted when
 * provided (the change-scoped fast path); pass `null` to count all.
 */
async function countCitesInLane(jsonlPath, issueExists, wanted, counts) {
  if (!existsSync(jsonlPath)) return 0;
  const rl = createInterface({ input: createReadStream(jsonlPath), crlfDelay: Infinity });
  let fails = 0;
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.status === "pass" || o.status === "skip") continue;
    fails++;
    for (const id of extractIssueCites(String(o.error || ""), issueExists)) {
      if (wanted && !wanted.has(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return fails;
}

/** Fetch (best-effort) + count cites across both lanes. Returns { counts, ok }. */
async function tallyCites(issueExists, wanted) {
  const counts = new Map();
  let ok = true;
  for (const [ensure, cachePath] of [
    [ensureBaselineJsonl, BASELINE_CACHE_PATH],
    [ensureStandaloneBaselineJsonl, STANDALONE_BASELINE_CACHE_PATH],
  ]) {
    let path = cachePath;
    try {
      path = await ensure();
    } catch {
      // fall through to whatever cache exists; flag not-ok if nothing usable
    }
    if (!existsSync(path)) {
      ok = false;
      continue;
    }
    await countCitesInLane(path, issueExists, wanted, counts);
  }
  return { counts, ok };
}

/**
 * Pure verdict — exported for unit testing. Given the candidate done-issues
 * (id -> meta) and their cite counts, split into violations (over threshold,
 * not exempt) and exempted.
 */
export function classifyDoneCites(candidates, counts, threshold) {
  const violations = [];
  const exempted = [];
  for (const [id, meta] of candidates) {
    const cites = counts.get(id) ?? 0;
    if (cites <= threshold) continue;
    if (meta.doneCitedOk) exempted.push({ id, cites, title: meta.title });
    else violations.push({ id, cites, title: meta.title });
  }
  return { violations, exempted };
}

async function runGate() {
  const index = loadIssueIndex();
  const issueExists = (id) => index.has(id);
  const { base, how } = resolveChangeBase(REPO_ROOT);

  // Change-scoped: only issue files this change-set adds/modifies.
  let changed;
  if (base) changed = changedPaths(REPO_ROOT, base, "plan/issues");
  if (!changed) {
    console.log("done-status-integrity (#3474): no resolvable change base — skipping (no build block).");
    return 0;
  }

  const candidates = new Map();
  for (const p of changed) {
    if (!p.endsWith(".md")) continue;
    const m = p.match(/(\d+)[a-z]?-.+\.md$/i);
    if (!m) continue;
    const id = m[1];
    const abs = join(REPO_ROOT, p);
    if (!existsSync(abs)) continue; // deleted by this change-set
    const meta = parseIssueFrontmatter(readFileSync(abs, "utf-8"));
    if (meta.status === "done" && !meta.doneCitedOk) candidates.set(id, meta);
  }

  if (candidates.size === 0) {
    console.log(
      `done-status-integrity (#3474): OK — no changed \`done\` issue files to check (base: ${how}). No baseline fetch.`,
    );
    return 0;
  }

  console.log(
    `done-status-integrity (#3474): checking ${candidates.size} changed \`done\` issue(s) against live citations…`,
  );
  const { counts, ok } = await tallyCites(issueExists, new Set(candidates.keys()));
  if (!ok) {
    console.log(
      "::warning::done-status-integrity (#3474): baseline JSONL unavailable (network/cache) — skipping the citation check (safety-net gate, not blocking).",
    );
    return 0;
  }

  const { violations, exempted } = classifyDoneCites(candidates, counts, THRESHOLD);
  for (const e of exempted) console.log(`  ✓ #${e.id} exempt (done_cited_ok): ${e.cites} cites.`);

  if (violations.length > 0) {
    process.stderr.write("\nDone-status integrity gate FAILED (#3474):\n");
    for (const v of violations.sort((a, b) => b.cites - a.cites)) {
      process.stderr.write(`  ✖ #${v.id} is \`done\` but still has ${v.cites} live test262 failures citing it.\n`);
      process.stderr.write(`      ${v.title}\n`);
    }
    process.stderr.write(
      `\nAn issue must not be \`done\` while its own tests still fail (threshold ${THRESHOLD}). Either:\n` +
        `  • reopen it: set \`status: ready\` (cite the live count), or\n` +
        `  • if the citations are EXPECTED (a detector/umbrella, or an intentional\n` +
        `    "not yet supported in --target standalone (#N)" refusal), mark it exempt:\n` +
        `      done_cited_ok: true\n` +
        `See #3474.\n`,
    );
    return 1;
  }

  console.log(`  ✓ all ${candidates.size} changed \`done\` issue(s) within the citation budget.`);
  return 0;
}

/** Whole-tree audit (Part A): report every issue that is cited, with status. */
async function runAudit(asJson) {
  const index = loadIssueIndex();
  const issueExists = (id) => index.has(id);
  const { counts, ok } = await tallyCites(issueExists, null);
  if (!ok) {
    console.error("done-status-integrity audit: baseline JSONL unavailable — cannot audit.");
    process.exit(2);
  }
  const rows = [...counts.entries()]
    .map(([id, cites]) => ({ id, cites, ...(index.get(id) || { status: "?", title: "" }) }))
    .sort((a, b) => b.cites - a.cites);

  if (asJson) {
    console.log(JSON.stringify({ threshold: THRESHOLD, rows }, null, 2));
    return 0;
  }

  console.log(`Done-status integrity audit (#3474) — threshold ${THRESHOLD}\n`);
  console.log("id     | status       | cites | title");
  console.log("-------|--------------|-------|------");
  for (const r of rows) {
    console.log(
      `#${String(r.id).padEnd(5)}| ${String(r.status).padEnd(12)} | ${String(r.cites).padStart(5)} | ${(r.title || "").slice(0, 66)}`,
    );
  }
  const falseDone = rows.filter((r) => r.status === "done" && r.cites > THRESHOLD && !index.get(r.id)?.doneCitedOk);
  console.log(`\n${falseDone.length} \`done\` issue(s) over threshold and NOT exempt (false-done candidates):`);
  for (const r of falseDone) console.log(`  #${r.id} — ${r.cites} cites — ${(r.title || "").slice(0, 74)}`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--audit") || argv.includes("--json")) {
    process.exit(await runAudit(argv.includes("--json")));
  }
  process.exit(await runGate());
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((e) => {
    console.error("done-status-integrity (#3474) gate error:", e);
    // A gate crash must not wedge the queue — this is a safety net.
    process.exit(0);
  });
}
