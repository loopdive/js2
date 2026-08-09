#!/usr/bin/env npx tsx
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3613) THE STANDING VACUITY DETECTOR.
//
// What a vacuous pass is
// ----------------------
// A test262 file that the runner scores `pass` without the test body having
// validated anything. It is strictly worse than a failure: it inflates the
// conformance number AND hides the defect it was supposed to catch. ~5,000 of
// them (18.4 % of the standalone lane) survived undetected for months (#3592)
// because nothing tested the harness itself.
//
// The method: CONDITIONAL throw injection
// ---------------------------------------
// For a passing test, append a throw to the END of its body:
//
//     if (typeof Test262Error === "function") { throw new Test262Error("…"); }
//
// A test whose body genuinely runs to completion MUST now be scored `fail`.
// One that is still scored `pass` never reached the end of its body — yet was
// counted as conformance. That is the definition of vacuous.
//
// Why CONDITIONAL and not a bare `throw` — this is load-bearing
// -------------------------------------------------------------
// #3592 RC1: a module whose body was an UNCONDITIONAL top-level `throw`
// emitted no `__module_init` at all and exited 0. So an unconditional probe
// was itself compiled away, and the audit of 2026-07-25 reported a spurious
// "43/43 vacuous" — the technique for detecting vacuity was defeated by the
// very bug it was hunting. A throw nested inside an `if` is not a top-level
// ThrowStatement and is structurally immune to that collector bug. The guard
// condition (`typeof Test262Error === "function"`) is also true exactly when
// the harness prefix ran, which is the precondition for the probe to mean
// anything at all.
//
// Why CONTROLS are mandatory, not optional
// ----------------------------------------
// A known-FAIL control is what caught the bad methodology above. This script
// refuses to report ANY finding until three controls hold:
//
//   1. a synthetic genuinely-passing test scores `pass`   (the runner runs)
//   2. a synthetic genuinely-failing test scores `fail`   (the runner judges)
//   3. that same passing test, PROBED, scores `fail`      (the probe bites)
//
// Any control disagreement aborts with exit 3 and reports nothing. And after
// the run, if the probe flipped NOTHING in the whole sample, the script
// reports PROBE INERT rather than "100 % vacuous" — see the vacuous-verifier
// guard in scripts/lib/verifier-guard.mjs.
//
// Usage
// -----
//   npx tsx scripts/detect-vacuity.ts --sample 25 --seed 20260725
//   npx tsx scripts/detect-vacuity.ts --lane standalone --files list.txt
//   npx tsx scripts/detect-vacuity.ts --sample 12 --json .tmp/vacuity.json
//
//   --sample N            files to probe (default 20)
//   --seed S              deterministic sample seed (default 20260725)
//   --lane gc|standalone  compile lane (default gc)
//   --files PATH          newline-separated test paths instead of the baseline
//   --position tail|head  where to inject (default tail; head classifies
//                         "body never started" vs "body never finished")
//   --json PATH           write the machine-readable report here
//   --max-vacuous-rate R  exit 1 when the measured rate exceeds R (0..1)
//   --timeout MS          per-file runner timeout (default 30000)

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BASELINE_CACHE_PATH,
  STANDALONE_BASELINE_CACHE_PATH,
  ensureBaselineJsonl,
  ensureStandaloneBaselineJsonl,
} from "./fetch-baseline-jsonl.mjs";
import { checkVerifierCoverage } from "./lib/verifier-guard.mjs";
import { parseMeta, runTest262File } from "../tests/test262-runner.js";
import { restoreHostBuiltins } from "../tests/test262-restore-builtins.js";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const TEST262_TEST_ROOT = join(REPO_ROOT, "test262", "test");

export const PROBE_MARKER = "__JS2WASM_VACUITY_PROBE__";

/**
 * How many candidates may be DRAWN per requested probe. A pool can be
 * dominated by ineligible rows (the standalone baseline's `pass` set is
 * heavily negative-tests), and a fixed-size draw would then probe nothing and
 * report "0 vacuous" — the silent zero this whole file exists to refuse.
 */
export const SAMPLE_ATTEMPT_FACTOR = 8;

/**
 * The injected probe. See the header for why the throw is CONDITIONAL and why
 * the guard is `typeof Test262Error === "function"` specifically.
 */
export const VACUITY_PROBE = `\nif (typeof Test262Error === "function") { throw new Test262Error("${PROBE_MARKER}"); }\n`;

// ── Probe injection ────────────────────────────────────────────────────────

/** End of the test262 `/*--- … ---*\/` metadata block, or 0 when absent. */
function endOfFrontmatter(source: string): number {
  const start = source.indexOf("/*---");
  if (start < 0) return 0;
  const end = source.indexOf("---*/", start);
  return end < 0 ? 0 : end + "---*/".length;
}

export function injectVacuityProbe(source: string, position: "tail" | "head" = "tail"): string {
  if (position === "head") {
    const at = endOfFrontmatter(source);
    return source.slice(0, at) + VACUITY_PROBE + source.slice(at);
  }
  return `${source}\n${VACUITY_PROBE}`;
}

export interface Eligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Not every passing test can be probed meaningfully. Excluding these is
 * honesty, not convenience — each exclusion is a case where a `pass` under the
 * probe would NOT prove vacuity.
 */
export function probeEligibility(source: string): Eligibility {
  const meta = parseMeta(source);
  if (meta.negative) {
    // A negative test's verdict is "was it rejected for the expected reason";
    // an injected throw changes the program under test, so a probed pass says
    // nothing about the original.
    return { eligible: false, reason: "negative test" };
  }
  if (meta.flags?.includes("raw")) {
    // `raw` tests run with NO harness, so `Test262Error` does not exist and
    // the guard condition is false by construction — the probe cannot bite.
    return { eligible: false, reason: "raw (no harness)" };
  }
  if (/\bTest262Error\b/.test(source) === false && /\bassert\b/.test(source) === false) {
    // Nothing in the body references the harness; the file may legitimately
    // assert nothing (a smoke/compile test). Still probe-able, but flag it.
    return { eligible: true, reason: "no harness reference in body" };
  }
  return { eligible: true };
}

// ── Sampling ───────────────────────────────────────────────────────────────

/** mulberry32 — the same deterministic PRNG the #3592 A/B sampling used. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededSample<T>(items: T[], n: number, seed: number): T[] {
  const copy = items.slice();
  const rnd = mulberry32(seed);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

// ── Controls ───────────────────────────────────────────────────────────────

interface Control {
  id: string;
  source: string;
  expect: "pass" | "fail";
  why: string;
}

const CONTROL_PASS_BODY = `/*---\ndescription: "#3613 vacuity control — genuinely passing"\n---*/\nassert.sameValue(1, 1, "control");\n`;

const CONTROLS: Control[] = [
  {
    id: "control-pass",
    source: CONTROL_PASS_BODY,
    expect: "pass",
    why: "the runner actually runs and can reach a pass — otherwise a 'vacuous' verdict is just a broken runner",
  },
  {
    id: "control-fail",
    source: `/*---\ndescription: "#3613 vacuity control — genuinely failing"\n---*/\nassert.sameValue(1, 2, "control");\n`,
    expect: "fail",
    why: "the runner actually JUDGES — a runner that passes everything would report 100% vacuous... by passing everything",
  },
  {
    id: "control-probe",
    source: injectVacuityProbe(CONTROL_PASS_BODY),
    expect: "fail",
    why: "THE control that caught the bad methodology on 2026-07-25: it proves the injected probe BITES. An inert probe (e.g. compiled away by #3592 RC1) makes every probed run look vacuous",
  },
];

// ── Runner plumbing ────────────────────────────────────────────────────────

type Lane = "gc" | "standalone";

async function runSource(
  dir: string,
  id: string,
  source: string,
  lane: Lane,
  timeoutMs: number,
): Promise<{ status: string; error?: string }> {
  const file = join(dir, `${id.replace(/[^a-z0-9._-]/gi, "_")}.js`);
  writeFileSync(file, source);
  try {
    const r = await runTest262File(file, "vacuity-probe", timeoutMs, lane === "standalone" ? "standalone" : undefined);
    return { status: r.status, error: r.error };
  } catch (e) {
    return { status: "runner_threw", error: (e as Error)?.message };
  } finally {
    // The in-process runner executes test code in this realm (#3318).
    restoreHostBuiltins();
  }
}

// ── Candidate discovery ────────────────────────────────────────────────────

async function baselinePassingFiles(lane: Lane): Promise<string[]> {
  const standalone = lane === "standalone";
  const cachePath = standalone ? STANDALONE_BASELINE_CACHE_PATH : BASELINE_CACHE_PATH;
  // Fetch the LANE'S OWN baseline. Calling the gc fetcher for the standalone
  // lane leaves the standalone cache absent on a fresh checkout, so the run
  // dies with "no baseline JSONL" — which on a scheduled canary reads as
  // infrastructure noise rather than the missing measurement it is.
  if (!existsSync(cachePath)) await (standalone ? ensureStandaloneBaselineJsonl() : ensureBaselineJsonl());
  if (!existsSync(cachePath)) {
    throw new Error(
      `#3613: no baseline JSONL at ${cachePath}. Run \`node scripts/fetch-baseline-jsonl.mjs\` or pass --files.`,
    );
  }
  const files: string[] = [];
  for (const line of readFileSync(cachePath, "utf-8").split("\n")) {
    if (!line) continue;
    let row: { file?: string; status?: string };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.status === "pass" && row.file) files.push(row.file);
  }
  // The baseline JSONL is AUTHORITATIVE over any local run (a local repro has
  // been observed reporting `fail` where CI said `compile_error`). We use it
  // only to CHOOSE candidates; every candidate is re-run unprobed below, and a
  // local disagreement is reported as `drifted`, never silently dropped.
  return files;
}

function resolveTestPath(file: string): string {
  if (file.startsWith("/")) return file;
  const stripped = file.replace(/^test\//, "");
  return join(TEST262_TEST_ROOT, stripped);
}

// ── Main ───────────────────────────────────────────────────────────────────

export interface VacuityReport {
  lane: Lane;
  position: "tail" | "head";
  seed: number;
  requested: number;
  /** Candidates DRAWN from the pool (probed + drifted + ineligible). */
  attempted: number;
  /** Candidates that were actually probed (unprobed run reproduced `pass`). */
  probed: number;
  /** Probed files that STILL passed — vacuous. */
  vacuous: string[];
  /** Probed files that correctly flipped to a non-pass verdict. */
  flipped: number;
  /** Candidates whose unprobed local run disagreed with the baseline. */
  drifted: { file: string; status: string }[];
  /** Candidates excluded before probing, with the reason. */
  ineligible: { file: string; reason: string }[];
  vacuousRate: number | null;
  probeInert: boolean;
  warnings: string[];
  controls: { id: string; expect: string; got: string; ok: boolean }[];
}

function parseArgs(argv: string[]) {
  const get = (flag: string, dflt?: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : dflt;
  };
  return {
    sample: Number(get("--sample", "20")),
    seed: Number(get("--seed", "20260725")),
    lane: (get("--lane", "gc") as Lane) ?? "gc",
    files: get("--files"),
    position: (get("--position", "tail") as "tail" | "head") ?? "tail",
    json: get("--json"),
    maxRate: get("--max-vacuous-rate") !== undefined ? Number(get("--max-vacuous-rate")) : null,
    timeout: Number(get("--timeout", "30000")),
  };
}

export async function detectVacuity(opts: {
  candidates: string[];
  lane: Lane;
  position: "tail" | "head";
  seed: number;
  sample: number;
  timeout: number;
}): Promise<VacuityReport> {
  const dir = mkdtempSync(join(tmpdir(), "js2wasm-vacuity-"));
  const report: VacuityReport = {
    lane: opts.lane,
    position: opts.position,
    seed: opts.seed,
    requested: opts.sample,
    attempted: 0,
    probed: 0,
    vacuous: [],
    flipped: 0,
    drifted: [],
    ineligible: [],
    vacuousRate: null,
    probeInert: false,
    warnings: [],
    controls: [],
  };

  // ── 1. Controls FIRST. Nothing is concluded until these hold. ────────────
  console.error("── controls (a finding is refused until all three hold) ──");
  let controlsOk = true;
  for (const c of CONTROLS) {
    const got = await runSource(dir, c.id, c.source, opts.lane, opts.timeout);
    const ok = got.status === c.expect;
    controlsOk &&= ok;
    report.controls.push({ id: c.id, expect: c.expect, got: got.status, ok });
    console.error(`  ${ok ? "OK " : "BAD"} ${c.id}: expected ${c.expect}, got ${got.status} — ${c.why}`);
  }
  if (!controlsOk) {
    throw Object.assign(
      new Error(
        "#3613: CONTROL FAILURE — the probe or the runner is not behaving as required, so NO vacuity finding " +
          "is reported. This is the guard that caught the spurious '43/43 vacuous' reading of 2026-07-25 " +
          "(an unconditional throw probe compiled away by #3592 RC1). Fix the control before trusting any number.",
      ),
      { controlFailure: true, report },
    );
  }

  // ── 2. Sample and probe. ────────────────────────────────────────────────
  //
  // Draw from a seeded shuffle of the WHOLE candidate pool and keep going
  // until `sample` files have actually been PROBED (bounded by
  // SAMPLE_ATTEMPT_FACTOR). A fixed-size draw wastes the whole sample when the
  // pool is dominated by ineligible rows — the first standalone run of this
  // detector drew 12 candidates and every one was a negative test, producing a
  // "0 vacuous of 0 probed" that reads exactly like a clean result.
  const shuffled = seededSample(opts.candidates, opts.candidates.length, opts.seed);
  const attemptCap = Math.min(shuffled.length, Math.max(opts.sample, opts.sample * SAMPLE_ATTEMPT_FACTOR));
  console.error(
    `\n── probing up to ${opts.sample} of ${opts.candidates.length} candidate passes ` +
      `(${opts.lane} lane, ≤${attemptCap} draws) ──`,
  );

  for (const rel of shuffled.slice(0, attemptCap)) {
    if (report.probed >= opts.sample) break;
    report.attempted++;
    const path = resolveTestPath(rel);
    if (!existsSync(path)) {
      report.ineligible.push({ file: rel, reason: "file not found" });
      continue;
    }
    const source = readFileSync(path, "utf-8");
    const elig = probeEligibility(source);
    if (!elig.eligible) {
      report.ineligible.push({ file: rel, reason: elig.reason ?? "ineligible" });
      continue;
    }

    // Re-run UNPROBED. The baseline chose the candidate; the local run is what
    // the probed run is compared against, so a lane/environment disagreement
    // must be surfaced rather than turned into a false vacuity claim.
    const before = await runSource(dir, `plain-${rel}`, source, opts.lane, opts.timeout);
    if (before.status !== "pass") {
      report.drifted.push({ file: rel, status: before.status });
      continue;
    }

    const after = await runSource(
      dir,
      `probed-${rel}`,
      injectVacuityProbe(source, opts.position),
      opts.lane,
      opts.timeout,
    );
    report.probed++;
    if (after.status === "pass") {
      report.vacuous.push(rel);
      console.error(`  VACUOUS  ${rel}`);
    } else {
      report.flipped++;
    }
  }

  // ── 3. The vacuous-verifier guard, applied to our OWN output. ───────────
  //
  // (a) Drew candidates but probed NONE. "0 vacuous of 0 probed" reads exactly
  //     like a clean result. Found by this detector on its own first standalone
  //     run: 12 of 12 draws were negative tests.
  const selection = checkVerifierCoverage({
    name: "vacuity probe candidate selection",
    population: report.attempted,
    verified: report.probed,
    hint: "every drawn candidate was ineligible or drifted — check the baseline lane file (a stale/partial JSONL can be dominated by negative tests) and the test262 checkout",
  });
  if (selection.vacuous && selection.message) {
    report.probeInert = true;
    report.warnings.push(selection.message);
    console.error(`\n${selection.message}`);
  }

  // (b) Probed files, but the probe flipped NOTHING. The honest conclusion is
  //     "the probe did not take effect", NOT "100 % vacuous" — that inversion
  //     is precisely the spurious 43/43 reading of 2026-07-25.
  const coverage = checkVerifierCoverage({
    name: "vacuity probe (conditional throw injection)",
    population: report.probed,
    verified: report.flipped,
    hint: "the probe may have been compiled away (cf. #3592 RC1 top-level-throw drop) or the harness prefix may not be running at all — re-check control-probe",
  });
  if (coverage.vacuous && coverage.message) {
    report.probeInert = true;
    report.warnings.push(coverage.message);
    console.error(`\n${coverage.message}`);
  }

  report.vacuousRate = report.probed > 0 ? report.vacuous.length / report.probed : null;
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let candidates: string[];
  if (args.files) {
    candidates = readFileSync(args.files, "utf-8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    candidates = await baselinePassingFiles(args.lane);
  }
  if (candidates.length === 0) {
    console.error("#3613: no candidate passing tests — nothing to probe. Refusing to report a vacuous zero.");
    process.exit(2);
  }

  let report: VacuityReport;
  try {
    report = await detectVacuity({
      candidates,
      lane: args.lane,
      position: args.position,
      seed: args.seed,
      sample: args.sample,
      timeout: args.timeout,
    });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(3);
  }

  console.error("\n── result ──");
  console.error(`  drawn:      ${report.attempted}`);
  console.error(`  probed:     ${report.probed}`);
  console.error(`  flipped:    ${report.flipped} (probe bit — the body ran to completion)`);
  console.error(`  VACUOUS:    ${report.vacuous.length}`);
  console.error(`  drifted:    ${report.drifted.length} (baseline said pass, local run disagreed)`);
  console.error(`  ineligible: ${report.ineligible.length}`);
  // Show WHY, not just how many. A histogram dominated by one reason is a
  // diagnosis in itself: "32x negative test" on the standalone lane is how a
  // stale baseline (one produced when the lane was compile-erroring wholesale,
  // so only negative tests "passed") announces itself. Without this the
  // operator sees a bare count and has to go open the JSON.
  const reasons: Record<string, number> = {};
  for (const r of report.ineligible) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.error(`                ${n}x ${reason}`);
  }
  if (report.vacuousRate !== null) {
    console.error(`  rate:       ${(report.vacuousRate * 100).toFixed(1)}% of ${report.probed} probed`);
  }

  if (args.json) {
    mkdirSync(dirname(resolve(args.json)), { recursive: true });
    writeFileSync(resolve(args.json), JSON.stringify(report, null, 2));
    console.error(`  report:     ${args.json}`);
  }

  if (report.probeInert) {
    console.error("\nEXIT 4 — probe inert. NO vacuity rate is claimed from this run.");
    process.exit(4);
  }
  if (args.maxRate !== null && report.vacuousRate !== null && report.vacuousRate > args.maxRate) {
    console.error(
      `\nEXIT 1 — vacuity rate ${(report.vacuousRate * 100).toFixed(1)}% exceeds the declared ceiling ` +
        `${(args.maxRate * 100).toFixed(1)}%. Vacuous passes inflate conformance AND hide defects; ` +
        `triage the listed files before this lands.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

// Only run the CLI when invoked directly (the unit tests import the helpers).
if (process.argv[1] && resolve(process.argv[1]).endsWith("detect-vacuity.ts")) {
  await main();
}
