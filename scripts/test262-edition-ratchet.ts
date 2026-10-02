#!/usr/bin/env npx tsx
/**
 * Per-ES-edition conformance ratchet.
 *
 * The whole-corpus regression gate already catches "main got worse overall".
 * It does NOT catch "ES5 got worse while ES2016 got better by more" — the two
 * cancel in the headline number, and an edition the project has already
 * finished can rot silently while attention is on the edition being worked.
 * That is exactly what this gate exists to prevent: **an edition that has been
 * completed may never go backwards, whatever else improves.**
 *
 * Two independent checks, both against `scripts/test262-edition-ratchet-baseline.json`:
 *
 *   1. COUNTS — a ratcheted edition's pass count may rise or hold, never fall.
 *   2. PER-TEST — with `--compare <baseline.jsonl>`, any individual test in a
 *      ratcheted edition that goes pass -> not-pass fails the gate, even when
 *      the edition's total is flat or up. A count-only ratchet lets you break
 *      test A and fix test B and call it even; that is not "no regressions".
 *   3. COMPLETED — an edition marked `completed` (it reached 100 %) is
 *      zero-tolerance: EVERY row of it present in the run must pass, except
 *      rows listed in its `exceptions` with a reason. This needs no compare
 *      baseline and no full coverage — a partial run is checked on the rows it
 *      has — so it cannot be switched off by a lagging baseline or a scoped
 *      shard. `--update` sets `completed` the first time a full run measures
 *      pass == total, and never clears it. (Project-lead rule, 2026-09-29: no
 *      regression is allowed inside an edition that has reached 100 %. ES5 lost
 *      7 rows between 2026-09-23 and 09-28 while this gate reported OK, because
 *      CI classified every row as "Unclassified (legacy)" — see the test262
 *      check below.)
 *   4. HOST LANE (#6786) — `--host-lane --compare <host-baseline.jsonl>` checks
 *      the js-host jsonl ROW BY ROW: no row of a `completed` edition that passed
 *      in the host baseline may stop passing, whatever the net. Checks 1-3 do
 *      not run on this lane. The js-host lane is not at 100 % in any edition
 *      (the published host artifact has ES5 at 8,001 / 9,029), so "every row
 *      must pass" cannot apply there. "Nothing that passed may regress" can.
 *      Only the baseline's DESIGNATIONS are read on this lane (`completed`,
 *      `ratcheted`, `host_exceptions`). Its pass counts are standalone-measured
 *      and are not scored. Two flake classes are listed but not gated: rows in
 *      scripts/test262-host-noise-quarantine.json (exact paths seen changing
 *      status between same-SHA canary runs, #3426) and pass -> compile_timeout
 *      (runner-load flake, #1192; the #1942 compile-time guard owns real
 *      slowdowns). In-progress editions stay with the net gate
 *      (scripts/diff-test262.ts, `check for test262 regressions`). This mode
 *      never banks anything, and it refuses (exit 2) rather than compare nothing.
 *
 * THE CLASSIFIER READS TEST262. Each row's edition comes from its test file's
 * frontmatter. Without a test262 checkout every row classifies as
 * "Unclassified (legacy)", every real edition reads as NOT COVERED, and the
 * gate passes having checked nothing. So a missing checkout is refused (exit 2),
 * never scored.
 *
 * PARTIAL RUNS ARE REFUSED, NOT SCORED. A path-filtered or sharded run sees
 * only some of an edition's tests, so its pass count is meaninglessly low. The
 * same hazard bit `runs/index.json` in #4412, where a single-shard local run
 * posted a partial total beside real full-corpus rows. Here an edition whose
 * observed row count is below its baseline `total` is reported as NOT COVERED
 * and skipped — and `--update` refuses to write from such a run at all, so a
 * scoped run can never silently lower the bar.
 *
 * Usage:
 *   npx tsx scripts/test262-edition-ratchet.ts --results <run.jsonl> [--target standalone]
 *   npx tsx scripts/test262-edition-ratchet.ts --results <run.jsonl> --compare <base.jsonl>
 *   npx tsx scripts/test262-edition-ratchet.ts --results <run.jsonl> --update
 *   npx tsx scripts/test262-edition-ratchet.ts --host-lane --results <host.jsonl> --compare <host-base.jsonl>
 *
 * Exit codes: 0 clean · 1 regression · 2 usage / refused input.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type HostNoiseQuarantineManifest, validateHostNoiseQuarantineManifest } from "./diff-test262.ts";
import { classifyEdition, editionStringToYear, parseFrontmatter } from "./generate-editions.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_BASELINE = join(ROOT, "scripts", "test262-edition-ratchet-baseline.json");
const DEFAULT_HOST_QUARANTINE = join(ROOT, "scripts", "test262-host-noise-quarantine.json");

function findTest262Root(base: string): string {
  // Test hook: lets the gate's own tests prove it refuses a missing checkout.
  const override = process.env.EDITION_RATCHET_TEST262_ROOT;
  if (override) return override;
  const direct = join(base, "test262");
  if (existsSync(join(direct, "test"))) return direct;
  const fromMain = join(base, "..", "..", "..", "test262");
  if (existsSync(join(fromMain, "test"))) return fromMain;
  return direct;
}
const TEST262_ROOT = findTest262Root(ROOT);

const EDITION_NAMES: Record<number, string> = {
  5: "ES5",
  2015: "ES2015",
  2016: "ES2016",
  2017: "ES2017",
  2018: "ES2018",
  2019: "ES2019",
  2020: "ES2020",
  2021: "ES2021",
  2022: "ES2022",
  2023: "ES2023",
  2024: "ES2024",
  2025: "ES2025",
  2026: "ES2026",
  2027: "ES2027",
  [-1]: "Proposals",
  [-2]: "Unclassified (legacy)",
  [-3]: "Unclassified (untagged)",
};

interface EditionEntry {
  /** When true, this edition may never regress. Set false only with a reason. */
  ratcheted: boolean;
  /** Why an edition is NOT ratcheted. Required when `ratcheted` is false. */
  reason?: string;
  pass: number;
  fail: number;
  compile_error: number;
  other: number;
  total: number;
  /**
   * The edition reached 100 %: every row of it must pass from now on (check 3).
   * Set by `--update` when a full run measures pass == total; never cleared by
   * the tool. Clearing it is a hand edit with a reason, like lowering a floor.
   */
  completed?: boolean;
  /**
   * Rows of a completed edition that may be non-pass, each with its reason:
   * a row that cannot pass on this target by construction, or a known failure
   * that has never passed since the floor was seeded. Never a regression — a
   * row that passed and stopped passing is exactly what this gate refuses.
   */
  exceptions?: { file: string; reason: string }[];
  /**
   * The js-host lane's own escape (check 4): rows of a completed edition that
   * may go pass -> not-pass on the host lane, each with its reason. Read ONLY
   * by `--host-lane`. `exceptions` above is standalone's and is not honoured
   * there, so excusing a row on one lane never loosens the other.
   */
  host_exceptions?: { file: string; reason: string }[];
}

interface Baseline {
  generated_at: string;
  commit: string;
  target: string;
  /**
   * Which runtime-eval provider produced these numbers. A refusal-only provider
   * fails every eval-dependent test by construction — measured 2026-09-04, that
   * is ~558 ES5 tests — so its pass counts are NOT comparable to a QuickJS run.
   */
  eval_engine: string;
  test262_ref: string;
  note: string;
  editions: Record<string, EditionEntry>;
}

interface Row {
  file: string;
  status: string;
}

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Cache: a test262 path is classified once per process, not once per run file. */
const editionCache = new Map<string, number>();
function editionOf(relFile: string): number {
  const cached = editionCache.get(relFile);
  if (cached !== undefined) return cached;
  // JSONL rows carry paths like `test/built-ins/Array/...`, relative to test262/.
  const abs = join(TEST262_ROOT, relFile);
  const ed = classifyEdition(parseFrontmatter(abs), abs);
  editionCache.set(relFile, ed);
  return ed;
}

function readRows(path: string): Row[] {
  if (!existsSync(path)) {
    console.error(`test262-edition-ratchet: results file not found: ${path}`);
    process.exit(2);
  }
  const rows: Row[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (typeof r.file === "string" && typeof r.status === "string") rows.push({ file: r.file, status: r.status });
    } catch {
      /* a partially-written trailing line is normal while a run is in flight */
    }
  }
  return rows;
}

interface Tally {
  pass: number;
  fail: number;
  compile_error: number;
  other: number;
  total: number;
  passing: Set<string>;
}

function tally(rows: Row[]): Map<number, Tally> {
  const out = new Map<number, Tally>();
  for (const r of rows) {
    const ed = editionOf(r.file);
    let t = out.get(ed);
    if (!t) {
      t = { pass: 0, fail: 0, compile_error: 0, other: 0, total: 0, passing: new Set() };
      out.set(ed, t);
    }
    t.total++;
    if (r.status === "pass") {
      t.pass++;
      t.passing.add(r.file);
    } else if (r.status === "fail") t.fail++;
    else if (r.status === "compile_error") t.compile_error++;
    else t.other++;
  }
  return out;
}

const name = (ed: number) => EDITION_NAMES[ed] ?? `edition ${ed}`;

function main(): void {
  const args = process.argv.slice(2);
  const resultsPath = getArg(args, "--results");
  const baselinePath = getArg(args, "--baseline") ?? DEFAULT_BASELINE;
  const comparePath = getArg(args, "--compare");
  const target = getArg(args, "--target") ?? "standalone";
  // JS2WASM_EVAL_ENGINE is what run-test262-vitest.sh selects; the refusal-only
  // provider is a distinct third state, not an engine, so name it explicitly.
  const evalEngine = getArg(args, "--eval-engine") ?? process.env.JS2WASM_EVAL_ENGINE ?? "quickjs";
  const update = args.includes("--update");
  const force = args.includes("--force");
  const hostLane = args.includes("--host-lane");
  if (hostLane && update) {
    refuseHostLane(
      "--update with --host-lane. The js-host lane banks nothing: completion is measured on the\n" +
        "  standalone lane, and a host run has no counts this baseline could hold.",
    );
  }

  // Seed the floor from the project's OWN published per-edition artifact
  // (`website/public/benchmarks/results/test262-standalone-editions.json`),
  // which CI regenerates from a full merged run under the engine CI actually
  // uses. That is a strictly better seed than any local measurement: it covers
  // every edition, and it is the same classifier's output, so the numbers are
  // directly comparable to what this gate will compute.
  const fromEditions = getArg(args, "--from-editions");
  if (fromEditions) {
    if (!update) {
      console.error("--from-editions only makes sense with --update");
      process.exit(2);
    }
    seedFromEditionsArtifact(fromEditions, baselinePath, target, evalEngine);
    return;
  }

  if (!resultsPath) {
    console.error(
      "usage: test262-edition-ratchet.ts --results <run.jsonl> [--compare <base.jsonl>] [--update]\n" +
        "       test262-edition-ratchet.ts --host-lane --results <host.jsonl> --compare <host-base.jsonl>",
    );
    process.exit(2);
  }

  if (!existsSync(join(TEST262_ROOT, "test"))) {
    console.error(
      `REFUSED: no test262 checkout at ${TEST262_ROOT} — cannot classify a single row by edition.\n` +
        `  Without it every row reads as "Unclassified (legacy)" and every real edition as NOT COVERED,\n` +
        `  so the gate would report OK having checked nothing (this is how ES5 lost 7 rows,\n` +
        `  2026-09-23 → 09-28, under a green ratchet). Check out the test262 submodule first.`,
    );
    process.exit(2);
  }

  if (hostLane) {
    runHostLane({
      resultsPath,
      comparePath,
      baselinePath,
      quarantinePath: getArg(args, "--host-noise-quarantine") ?? DEFAULT_HOST_QUARANTINE,
    });
  }

  const rows = readRows(resultsPath);
  const cur = tally(rows);
  console.log(`test262-edition-ratchet: ${rows.length} rows from ${resultsPath} (target ${target})`);

  // ── Seeding a brand-new baseline ────────────────────────────────────────
  if (!existsSync(baselinePath)) {
    if (!update) {
      console.error(`no baseline at ${baselinePath}. Seed one with --update.`);
      process.exit(2);
    }
    writeBaseline(baselinePath, cur, target, null, evalEngine);
    console.log(`SEEDED baseline at ${baselinePath}`);
    return;
  }

  const base: Baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));

  if (base.target !== target && !force) {
    console.error(
      `REFUSED: baseline was measured for target "${base.target}" but this run is "${target}".\n` +
        `  Edition pass counts are not comparable across targets. Use --target ${base.target}, ` +
        `a baseline for this target, or --force if you really mean to.`,
    );
    process.exit(2);
  }

  // A floor measured under a WEAKER eval provider is conservative, not wrong:
  // every eval-dependent test that the refusal provider fails can only pass
  // under QuickJS, so the recorded count is a lower bound and the ratchet still
  // fires only on genuine losses. Refusing here would wedge CI over a
  // difference that cannot produce a false failure — so warn, gate anyway, and
  // say plainly that the floor is loose until a CI run re-seeds it.
  if (base.eval_engine && base.eval_engine !== evalEngine) {
    console.log(
      `\nNOTE: baseline eval engine "${base.eval_engine}" != this run's "${evalEngine}".\n` +
        `  Eval-dependent tests differ between them, so the floor is LOOSE in that direction.\n` +
        `  It still gates (a lower floor cannot cause a false failure), but re-seed it from a\n` +
        `  full run on the engine CI uses: --update.`,
    );
    if (process.env.GITHUB_ACTIONS) {
      console.log(
        `::warning::edition ratchet baseline was measured under eval engine ${base.eval_engine}, not ${evalEngine}`,
      );
    }
  }

  // ── Coverage gate — a partial run must never be scored or banked ────────
  const covered: number[] = [];
  const partial: { ed: number; seen: number; expected: number }[] = [];
  for (const [key, entry] of Object.entries(base.editions)) {
    const ed = Number(key);
    const seen = cur.get(ed)?.total ?? 0;
    if (seen >= entry.total) covered.push(ed);
    else partial.push({ ed, seen, expected: entry.total });
  }

  if (partial.length > 0) {
    console.log(`\nNOT COVERED by this run (skipped — a partial run's pass count is not a measurement):`);
    for (const p of partial.sort((a, b) => a.ed - b.ed)) {
      console.log(`  ${name(p.ed).padEnd(24)} ${p.seen} of ${p.expected} rows present`);
    }
  }

  // An edition the run measured but the baseline has never heard of is
  // UNGATED, and silently so. That is the shape of every gate failure in this
  // repo's history (#3953: a floor too low to fire, reporting "passed" for 37
  // merges). Say it out loud, and annotate it in CI, so a new edition — or a
  // baseline seeded from a narrower run than the one now being checked —
  // cannot quietly sit outside the ratchet.
  const ungated = [...cur.keys()].filter((ed) => base.editions[String(ed)] === undefined).sort((a, b) => a - b);
  if (ungated.length > 0) {
    console.log(`\nUNGATED — measured by this run but absent from the baseline, so NOT protected:`);
    for (const ed of ungated) {
      const t = cur.get(ed)!;
      console.log(`  ${name(ed).padEnd(24)} ${t.pass} pass of ${t.total}`);
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::warning::edition ${name(ed)} is not in the ratchet baseline and is therefore ungated`);
      }
    }
    console.log(`  Bank them with --update on a full-corpus run.`);
  }

  if (update) {
    if (partial.length > 0 && !force) {
      console.error(
        `\nREFUSED to update: ${partial.length} edition(s) are only partially covered by this run.\n` +
          `  Banking it would write a lower bar than the project has actually reached — the #4412\n` +
          `  partial-run hazard. Re-run the full corpus, or pass --force if you have a specific reason.`,
      );
      process.exit(2);
    }
    const lowered = covered.filter((ed) => (cur.get(ed)?.pass ?? 0) < base.editions[String(ed)].pass);
    if (lowered.length > 0 && !force) {
      console.error(
        `\nREFUSED to update: these editions would go DOWN:\n` +
          lowered.map((ed) => `  ${name(ed)}: ${base.editions[String(ed)].pass} -> ${cur.get(ed)!.pass}`).join("\n") +
          `\n  A ratchet banks improvements; it does not record regressions. Fix the regression,\n` +
          `  or pass --force with an explicit reason if the drop is genuinely intended.`,
      );
      process.exit(1);
    }
    const violations = findCompletedViolations(rows, base);
    if (violations.length > 0 && !force) {
      console.error(
        `\nREFUSED to update: ${violations.length} row(s) of a COMPLETED edition do not pass:\n` +
          violations
            .slice(0, 20)
            .map((v) => `  ${name(v.ed)}: ${v.status} ${v.file}`)
            .join("\n") +
          `\n  A completed edition allows no regression. Fix the rows first.`,
      );
      process.exit(1);
    }
    writeBaseline(baselinePath, cur, target, base, evalEngine);
    console.log(`\nUPDATED ${baselinePath}`);
    return;
  }

  // ── Check 1: per-edition pass counts ────────────────────────────────────
  const countRegressions: string[] = [];
  const improvements: string[] = [];
  console.log(
    `\n${"edition".padEnd(24)} ${"baseline".padStart(9)} ${"now".padStart(9)} ${"delta".padStart(7)}   state`,
  );
  for (const ed of covered.sort((a, b) => a - b)) {
    const b = base.editions[String(ed)];
    const c = cur.get(ed)!;
    const delta = c.pass - b.pass;
    const state = b.ratcheted ? "ratcheted" : `not ratcheted (${b.reason ?? "no reason given"})`;
    const flag = delta < 0 ? (b.ratcheted ? "  <== REGRESSION" : "  (drop, not gated)") : delta > 0 ? "  +" : "";
    console.log(
      `${name(ed).padEnd(24)} ${String(b.pass).padStart(9)} ${String(c.pass).padStart(9)} ${String(delta >= 0 ? `+${delta}` : delta).padStart(7)}   ${state}${flag}`,
    );
    if (delta < 0 && b.ratcheted) countRegressions.push(`${name(ed)}: ${b.pass} -> ${c.pass} (${delta})`);
    if (delta > 0) improvements.push(`${name(ed)}: +${delta}`);
  }

  // ── Check 2: per-test pass -> not-pass inside a ratcheted edition ───────
  const perTest: { ed: number; file: string; was: string; now: string }[] = [];
  if (comparePath) {
    const baseRows = readRows(comparePath);
    const baseStatus = new Map(baseRows.map((r) => [r.file, r.status]));
    const curStatus = new Map(rows.map((r) => [r.file, r.status]));
    for (const [file, was] of baseStatus) {
      if (was !== "pass") continue;
      const now = curStatus.get(file);
      if (now === undefined || now === "pass") continue; // absent = not covered by this run
      const ed = editionOf(file);
      if (base.editions[String(ed)]?.ratcheted) perTest.push({ ed, file, was, now });
    }
    console.log(
      `\nper-test check vs ${comparePath}: ${baseRows.length} baseline rows, ` +
        `${perTest.length} pass -> not-pass inside ratcheted editions`,
    );
    for (const t of perTest.slice(0, 50)) {
      console.log(`  ${name(t.ed).padEnd(10)} ${t.now.padEnd(14)} ${t.file}`);
    }
    if (perTest.length > 50) console.log(`  ... and ${perTest.length - 50} more`);
  }

  // ── Check 3: a COMPLETED edition is zero-tolerance, row by row ──────────
  const completedViolations = findCompletedViolations(rows, base);
  const completedEditions = Object.entries(base.editions)
    .filter(([, e]) => e.completed && e.ratcheted)
    .map(([k]) => name(Number(k)));
  if (completedEditions.length > 0) {
    console.log(
      `\ncompleted editions (every row must pass): ${completedEditions.join(", ")} — ` +
        `${completedViolations.length} row(s) not passing`,
    );
    for (const v of completedViolations.slice(0, 50)) {
      console.log(`  ${name(v.ed).padEnd(10)} ${v.status.padEnd(14)} ${v.file}`);
    }
    if (completedViolations.length > 50) console.log(`  ... and ${completedViolations.length - 50} more`);
  }

  if (improvements.length > 0) console.log(`\nimprovements: ${improvements.join(", ")}`);

  if (countRegressions.length === 0 && perTest.length === 0 && completedViolations.length === 0) {
    console.log(`\ntest262-edition-ratchet: OK — no ratcheted edition regressed.`);
    process.exit(0);
  }

  console.error(`\ntest262-edition-ratchet: FAILED`);
  for (const r of countRegressions) console.error(`  count regression — ${r}`);
  if (perTest.length > 0) {
    console.error(`  ${perTest.length} individual test(s) went pass -> not-pass in a ratcheted edition`);
  }
  if (completedViolations.length > 0) {
    console.error(
      `  ${completedViolations.length} row(s) of a COMPLETED edition do not pass — a 100 % edition allows no regression`,
    );
  }
  console.error(
    `\n  A completed ES edition may not go backwards. If a drop is genuinely intended,\n` +
      `  say so explicitly by editing ${baselinePath} in the same change, with a reason.`,
  );
  process.exit(1);
}

/**
 * `completed` is sticky: once set it survives every rewrite. It is newly set
 * only when this measurement covers at least the recorded total and every row
 * passed — a partial run (fewer rows than the floor knows) can never mark an
 * edition complete.
 */
function completionFields(
  before: EditionEntry | undefined,
  pass: number,
  total: number,
): Pick<EditionEntry, "completed" | "exceptions" | "host_exceptions"> {
  const nowComplete = total > 0 && pass === total && total >= (before?.total ?? 0);
  return {
    ...(before?.completed || nowComplete ? { completed: true } : {}),
    ...(before?.exceptions?.length ? { exceptions: before.exceptions } : {}),
    ...(before?.host_exceptions?.length ? { host_exceptions: before.host_exceptions } : {}),
  };
}

/**
 * Every row of a completed edition that is present in `rows` and does not
 * pass, minus the edition's listed exceptions. Works on partial runs: it
 * checks the rows it has and says nothing about the ones it does not.
 */
function findCompletedViolations(rows: Row[], base: Baseline): { ed: number; file: string; status: string }[] {
  const out: { ed: number; file: string; status: string }[] = [];
  const excepted = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(base.editions)) {
    // An explicit opt-out (`ratcheted: false`, with its reason) wins: it is the
    // one reviewed way to stop gating an edition, completed or not.
    if (entry.completed && entry.ratcheted) excepted.set(key, new Set((entry.exceptions ?? []).map((e) => e.file)));
  }
  if (excepted.size === 0) return out;
  for (const r of rows) {
    if (r.status === "pass") continue;
    const ed = editionOf(r.file);
    const ex = excepted.get(String(ed));
    if (ex === undefined || ex.has(r.file)) continue;
    out.push({ ed, file: r.file, status: r.status });
  }
  return out;
}

function refuseHostLane(msg: string): never {
  console.error(`REFUSED (js-host lane, #6786): ${msg}`);
  process.exit(2);
}

/** Rows of a jsonl the host lane needs. Missing OR empty is refused: either way it would compare nothing. */
function readRequiredRows(path: string, what: string): Row[] {
  if (!existsSync(path)) refuseHostLane(`${what} not found: ${path}`);
  const rows = readRows(path);
  if (rows.length === 0) refuseHostLane(`${what} has no rows: ${path}`);
  return rows;
}

interface HostRow {
  file: string;
  now: string;
}
interface HostEditionTally {
  checked: number;
  absent: number;
  flips: HostRow[];
  quarantined: HostRow[];
  timeouts: HostRow[];
  excepted: HostRow[];
}

/**
 * Check 4 (#6786): the js-host lane's per-row gate for COMPLETED editions.
 * Every row that passed in the host baseline (`comparePath`) and is present in
 * the run must still pass, minus the two flake classes and the edition's
 * `host_exceptions`. Rows absent from the run are not covered — the #5215
 * completeness validator owns missing verdicts — but a run that covers NONE of
 * them is refused, never reported OK.
 */
function runHostLane(o: {
  resultsPath: string;
  comparePath: string | undefined;
  baselinePath: string;
  quarantinePath: string;
}): never {
  if (!o.comparePath) {
    refuseHostLane(
      "--host-lane needs --compare <host-baseline.jsonl>. Without it there is no pass -> not-pass\n" +
        "  to find, and the gate would report OK having compared nothing.",
    );
  }
  const rows = readRequiredRows(o.resultsPath, "host results jsonl");
  const baseRows = readRequiredRows(o.comparePath, "host baseline jsonl (--compare)");
  if (!existsSync(o.baselinePath)) refuseHostLane(`no edition baseline at ${o.baselinePath}`);
  const base: Baseline = JSON.parse(readFileSync(o.baselinePath, "utf-8"));

  // Which editions are held, and each one's host-lane exceptions (with reasons).
  const held = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(base.editions)) {
    if (!(entry.completed && entry.ratcheted)) continue;
    const ex = new Set<string>();
    for (const e of entry.host_exceptions ?? []) {
      if (!e?.file || !e?.reason?.trim()) {
        refuseHostLane(`${name(Number(key))} host_exceptions entry needs a file AND a reason: ${JSON.stringify(e)}`);
      }
      ex.add(e.file);
    }
    held.set(key, ex);
  }
  console.log(
    `test262-edition-ratchet (js-host lane, #6786): ${rows.length} rows from ${o.resultsPath}, ` +
      `${baseRows.length} baseline rows from ${o.comparePath}\n` +
      `  edition designations from ${o.baselinePath} (measured on ${base.target}; its counts are NOT scored here)`,
  );
  if (held.size === 0) {
    console.log(`\nno edition is marked completed — nothing for the per-row host gate to hold. OK.`);
    process.exit(0);
  }

  // Fail closed, like diff-test262: this file decides which rows are excused.
  let quarantine: ReadonlySet<string>;
  try {
    const manifest = JSON.parse(readFileSync(o.quarantinePath, "utf-8")) as HostNoiseQuarantineManifest;
    quarantine = validateHostNoiseQuarantineManifest(manifest).paths;
  } catch (e) {
    refuseHostLane(`host noise quarantine ${o.quarantinePath} is missing or invalid: ${(e as Error).message}`);
  }
  console.log(`  host noise quarantine: ${quarantine.size} exact paths from ${o.quarantinePath}`);

  const now = new Map(rows.map((r) => [r.file, r.status]));
  const was = new Map(baseRows.map((r) => [r.file, r.status]));
  const tallies = new Map<string, HostEditionTally>();
  for (const [file, status] of was) {
    if (status !== "pass") continue;
    const key = String(editionOf(file));
    const excepted = held.get(key);
    if (excepted === undefined) continue;
    let t = tallies.get(key);
    if (!t) {
      t = { checked: 0, absent: 0, flips: [], quarantined: [], timeouts: [], excepted: [] };
      tallies.set(key, t);
    }
    const cur = now.get(file);
    if (cur === undefined) {
      t.absent++;
      continue;
    }
    t.checked++;
    if (cur === "pass") continue;
    const row = { file, now: cur };
    if (quarantine.has(file)) t.quarantined.push(row);
    else if (cur === "compile_timeout") t.timeouts.push(row);
    else if (excepted.has(file)) t.excepted.push(row);
    else t.flips.push(row);
  }

  const heldNames = [...held.keys()].map((k) => name(Number(k))).join(", ");
  const all = [...tallies.values()];
  const checked = all.reduce((n, t) => n + t.checked, 0);
  if (checked === 0) {
    refuseHostLane(
      `compared nothing: no row of ${heldNames} passed in the baseline and is present in the run.\n` +
        `  A gate that checks nothing must not report OK (ES5 lost 7 rows under exactly that, 2026-09).`,
    );
  }

  console.log(
    `\ncompleted editions held per-row on the js-host lane: ${heldNames}\n` +
      `${"edition".padEnd(12)} ${"checked".padStart(8)} ${"absent".padStart(7)} ${"FLIPPED".padStart(8)} ` +
      `${"quarant.".padStart(8)} ${"ct_flake".padStart(8)} ${"excepted".padStart(8)}`,
  );
  for (const [key, t] of [...tallies].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(
      `${name(Number(key)).padEnd(12)} ${String(t.checked).padStart(8)} ${String(t.absent).padStart(7)} ` +
        `${String(t.flips.length).padStart(8)} ${String(t.quarantined.length).padStart(8)} ` +
        `${String(t.timeouts.length).padStart(8)} ${String(t.excepted.length).padStart(8)}`,
    );
  }
  const list = (title: string, items: HostRow[], max: number) => {
    if (items.length === 0) return;
    console.log(`\n${title}: ${items.length}`);
    for (const r of items.slice(0, max)) console.log(`  pass -> ${r.now.padEnd(14)} ${r.file}`);
    if (items.length > max) console.log(`  ... and ${items.length - max} more`);
  };
  const flips = all.flatMap((t) => t.flips);
  list(
    "NOT gated — host noise quarantine (#3426, same-SHA canary flips)",
    all.flatMap((t) => t.quarantined),
    20,
  );
  list(
    "NOT gated — pass -> compile_timeout (runner-load flake, #1192; see the #1942 guard)",
    all.flatMap((t) => t.timeouts),
    20,
  );
  list(
    "NOT gated — host_exceptions",
    all.flatMap((t) => t.excepted),
    20,
  );
  list("REGRESSIONS in a completed edition", flips, 100);

  if (flips.length === 0) {
    console.log(`\ntest262-edition-ratchet (js-host lane): OK — no completed-edition row went pass -> not-pass.`);
    process.exit(0);
  }
  console.error(
    `\ntest262-edition-ratchet (js-host lane): FAILED — ${flips.length} row(s) of a COMPLETED edition ` +
      `went pass -> not-pass.\n` +
      `  A completed edition allows no regression on either lane, whatever the net (#6786).\n` +
      `  Fix the rows. A row that cannot pass on the js-host lane by construction goes in that\n` +
      `  edition's \`host_exceptions\` in ${o.baselinePath}, with a reason, in a reviewed diff.`,
  );
  process.exit(1);
}

/**
 * Seed a baseline from the published editions artifact rather than from a raw
 * run. The artifact carries `skip` where a run carries assorted non-pass
 * statuses; both land in `other`, which the gate never scores — only `pass` is
 * ratcheted and only `total` decides coverage.
 */
function seedFromEditionsArtifact(
  artifactPath: string,
  baselinePath: string,
  target: string,
  evalEngine: string,
): void {
  if (!existsSync(artifactPath)) {
    console.error(`test262-edition-ratchet: editions artifact not found: ${artifactPath}`);
    process.exit(2);
  }
  const rows = JSON.parse(readFileSync(artifactPath, "utf-8")) as {
    edition: string;
    pass: number;
    fail: number;
    ce: number;
    skip?: number;
    total: number;
  }[];
  const prev: Baseline | null = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf-8")) : null;
  const editions: Record<string, EditionEntry> = {};
  const skipped: string[] = [];
  for (const r of rows) {
    const year = editionStringToYear(r.edition);
    if (year === undefined) {
      skipped.push(r.edition);
      continue;
    }
    const before = prev?.editions[String(year)];
    editions[String(year)] = {
      ratcheted: before?.ratcheted ?? true,
      ...(before?.reason ? { reason: before.reason } : {}),
      pass: r.pass,
      fail: r.fail,
      compile_error: r.ce,
      other: r.skip ?? 0,
      total: r.total,
      ...completionFields(before, r.pass, r.total),
    };
  }
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    /* informational only */
  }
  const out: Baseline = {
    generated_at: new Date().toISOString(),
    commit,
    target,
    eval_engine: evalEngine,
    test262_ref: prev?.test262_ref ?? "see .gitmodules / git submodule status test262",
    note:
      "Per-edition conformance floor, seeded from " +
      artifactPath +
      ". `ratcheted: true` means that edition may never lose passes. Lowering a number here is a " +
      "deliberate, reviewable act — never do it to make CI green. Bank improvements with: " +
      "npx tsx scripts/test262-edition-ratchet.ts --results <full-run.jsonl> --update",
    editions,
  };
  writeFileSync(baselinePath, JSON.stringify(out, null, 2) + "\n");
  console.log(`SEEDED ${Object.keys(editions).length} edition(s) from ${artifactPath} -> ${baselinePath}`);
  if (skipped.length > 0) console.log(`  (not editions, skipped: ${skipped.join(", ")})`);
}

function writeBaseline(
  path: string,
  cur: Map<number, Tally>,
  target: string,
  prev: Baseline | null,
  evalEngine: string,
): void {
  const editions: Record<string, EditionEntry> = {};
  for (const [ed, t] of [...cur].sort((a, b) => a[0] - b[0])) {
    const before = prev?.editions[String(ed)];
    editions[String(ed)] = {
      // Default every edition to ratcheted. A ratchet that only guards the
      // editions someone remembered to list is not a ratchet.
      ratcheted: before?.ratcheted ?? true,
      ...(before?.reason ? { reason: before.reason } : {}),
      pass: t.pass,
      fail: t.fail,
      compile_error: t.compile_error,
      other: t.other,
      total: t.total,
      ...completionFields(before, t.pass, t.total),
    };
  }
  let commit = "unknown";
  try {
    // `.git` is a FILE in a worktree, not a directory, so reading .git/HEAD
    // directly works only in the main checkout. Ask git instead.
    commit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    /* not a git checkout, or git unavailable — the stamp is informational */
  }
  const out: Baseline = {
    generated_at: new Date().toISOString(),
    commit,
    target,
    eval_engine: evalEngine,
    test262_ref: prev?.test262_ref ?? "see .gitmodules / git submodule status test262",
    note:
      "Per-edition conformance floor. `ratcheted: true` means that edition may never " +
      "lose passes. Lowering a number here is a deliberate, reviewable act — never do it " +
      "to make CI green. Bank improvements with: npx tsx scripts/test262-edition-ratchet.ts " +
      "--results <full-run.jsonl> --update",
    editions,
  };
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
}

main();
