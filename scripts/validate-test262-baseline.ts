#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1218 / #2095 — Auto-validate the test262 baselines by spot-checking random
// rows against the current `main` HEAD compiler.
//
// Why: the baseline JSONL is what `dev-self-merge` Step 4 reads for
// bucket-by-path regression analysis, and what the #1897 standalone floor
// gates against. If a baseline rots (mass-rewritten by a malformed merge,
// desynced by a workflow bug), the bucket analysis silently produces wrong
// answers and the merge gate becomes unreliable.
//
// As of #1528 the baselines are not committed to the main repo — they live in
// `loopdive/js2wasm-baselines` and are fetched on demand to `.test262-cache/`
// via `scripts/fetch-baseline-jsonl.mjs` (host + standalone lanes).
//
// #2095 — the validator now covers BOTH lanes and BOTH row classes:
//   - HOST lane (gc)         pass rows (must still pass) + fail rows
//   - STANDALONE lane        pass rows (must still pass) + fail rows
// A sampled `pass` row that no longer passes means the baseline floor rotted
// too low (#1218). A sampled `fail` row that now PASSES means the baseline is
// stale — it inflates the regression-gate `improvements` count and can mask
// one real regression per PR diff (#2095). Standalone rows compile+run with
// `--target standalone`. It's a smoke test, not a full validator, but a single
// miss in either lane/class strongly suggests broader baseline corruption.
//
// Usage:
//   npx tsx scripts/validate-test262-baseline.ts                    # default seed
//   SAMPLE_SIZE=50 FAIL_SAMPLE_SIZE=25 SEED=12345 npx tsx scripts/validate-test262-baseline.ts
//   PR_NUMBER=109 npx tsx scripts/validate-test262-baseline.ts       # CI mode
//
// Exit codes:
//   0 — every sampled row matches its baseline status; baselines are honest
//   1 — at least one sampled row diverged (pass→non-pass, or fail→pass); drift suspected
//   2 — internal error (missing files, etc.)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runTest262File, TEST_CATEGORIES } from "../tests/test262-runner.ts";
// #1528 — fetch baseline JSONL on demand from `loopdive/js2wasm-baselines`
// instead of reading a committed copy. The helper handles caching and
// graceful fallback if upstream is unreachable.
// #2095 — the standalone lane has its own baseline JSONL fetched the same way.
import {
  BASELINE_CACHE_PATH,
  STANDALONE_BASELINE_CACHE_PATH,
  ensureBaselineJsonl,
  ensureStandaloneBaselineJsonl,
} from "./fetch-baseline-jsonl.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** Prepare the default standalone eval engine before sampling its baseline. */
function prepareStandaloneEvalProvider(): void {
  const engine = process.env.JS2WASM_EVAL_ENGINE ?? "quickjs";
  if (engine !== "quickjs") return;

  // The selector is intentionally build-free and never falls back to the
  // native interpreter. Establish a fresh compiler key, then make the default
  // QuickJS artifact+adapter pair available before any sampled eval row runs.
  execFileSync("pnpm", ["run", "build:compiler-bundle"], { cwd: ROOT, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/build-quickjs-eval-provider.mjs"], {
    cwd: ROOT,
    env: { ...process.env, JS2WASM_EVAL_ENGINE: "quickjs" },
    stdio: "inherit",
  });
}

// (#2095) Per-lane `pass`-row sample size (the historical SAMPLE_SIZE knob) and
// a separate, smaller `fail`-row sample. Fail rows assert STILL-failing: a fail
// row that now passes inflates the regression-gate `improvements` count and can
// mask one real regression per PR diff, so we sample them too. M defaults lower
// than N because fail rows are cheaper signal-per-row and the corpus is huge.
const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE ?? "50");
const FAIL_SAMPLE_SIZE = Number(process.env.FAIL_SAMPLE_SIZE ?? "25");

/** Resolve a deterministic seed from env. PR number > explicit SEED > Date.now(). */
function resolveSeed(): number {
  const pr = process.env.PR_NUMBER;
  if (pr && /^\d+$/.test(pr)) return Number(pr) * 31 + 7;
  const explicit = process.env.SEED;
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
  return 0xabad1dea; // Stable default — same sample on every local run.
}

/** xorshift32 PRNG — deterministic, fast, plenty of randomness for shuffling. */
function makePRNG(seed: number): () => number {
  // Avoid 0 (xorshift fixed point).
  let s = seed | 0;
  if (s === 0) s = 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // Map to [0, 1).
    return (s >>> 0) / 0x100000000;
  };
}

/** Fisher-Yates shuffle using the supplied PRNG; stable across runs given the same seed. */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface BaselineEntry {
  /** Path relative to test262 root, e.g. "test/built-ins/Promise/resolve/length.js" */
  file: string;
  /** Expected status — only "pass" entries are sampled here. */
  status: string;
  /** Optional category folder hint, e.g. "built-ins/Promise/resolve" */
  category?: string;
}

function loadBaseline(baselinePath: string): BaselineEntry[] {
  let raw: string;
  try {
    raw = readFileSync(baselinePath, "utf-8");
  } catch (e: unknown) {
    console.error(`fatal: cannot read ${baselinePath}: ${(e as Error).message}`);
    process.exit(2);
  }
  const out: BaselineEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (typeof d.file === "string" && typeof d.status === "string") {
        out.push({ file: d.file, status: d.status, category: d.category });
      }
    } catch {
      // Skip malformed lines silently — a malformed JSONL is itself a corruption signal,
      // but counting those is the job of a different validator.
    }
  }
  return out;
}

/** Map a test path back to a TEST_CATEGORIES entry so runTest262File can wrap correctly. */
function categoryFor(file: string): string {
  // file looks like "test/built-ins/Promise/resolve/length.js" — strip the leading "test/".
  const trimmed = file.startsWith("test/") ? file.slice(5) : file;
  // Pick the longest matching prefix from TEST_CATEGORIES so e.g. "built-ins/Promise" is
  // preferred over "built-ins" when both are listed.
  let best = "";
  for (const cat of TEST_CATEGORIES) {
    if (trimmed.startsWith(cat + "/") && cat.length > best.length) best = cat;
  }
  if (!best) {
    // Fallback: take the top-level directory.
    const i = trimmed.indexOf("/");
    return i > 0 ? trimmed.slice(0, i) : trimmed;
  }
  return best;
}

// Tests in the corpus may throw `WebAssembly.Exception` objects via async
// promise chains that the runner's outer try/catch can't reach. These show up
// as unhandled rejections that crash the process. Swallow them — we already
// classify the test as failed via the runner's TestResult.status, so the
// rejection is redundant signal.
process.on("unhandledRejection", (reason) => {
  // Single-line note to stderr so it's still visible in CI logs without
  // tainting the validator's structured output.
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[unhandledRejection swallowed] ${msg.slice(0, 200)}\n`);
});

// Snapshot global built-in prototype methods that test262 tests may clobber.
// Some tests mutate globalThis.Set.prototype, Array.prototype, etc. in ways
// that survive test isolation (especially when runTest262File is invoked in
// the same process rather than a worker). Restore after each test so
// subsequent runner preprocessing (which uses `new Set()` etc.) still works.
const _savedGlobals: Array<[object, PropertyKey, PropertyDescriptor | undefined]> = [
  [Set.prototype, "add", Object.getOwnPropertyDescriptor(Set.prototype, "add")],
  [Set.prototype, "has", Object.getOwnPropertyDescriptor(Set.prototype, "has")],
  [Set.prototype, "delete", Object.getOwnPropertyDescriptor(Set.prototype, "delete")],
  [Set.prototype, "clear", Object.getOwnPropertyDescriptor(Set.prototype, "clear")],
  [Map.prototype, "set", Object.getOwnPropertyDescriptor(Map.prototype, "set")],
  [Map.prototype, "get", Object.getOwnPropertyDescriptor(Map.prototype, "get")],
  [Map.prototype, "has", Object.getOwnPropertyDescriptor(Map.prototype, "has")],
  [Array.prototype, "push", Object.getOwnPropertyDescriptor(Array.prototype, "push")],
  [Array.prototype, "pop", Object.getOwnPropertyDescriptor(Array.prototype, "pop")],
  [Object.prototype, "hasOwnProperty", Object.getOwnPropertyDescriptor(Object.prototype, "hasOwnProperty")],
];
function restoreGlobals(): void {
  for (const [obj, key, desc] of _savedGlobals) {
    if (desc) Object.defineProperty(obj, key, desc);
  }
  // Remove any numeric-index getter/accessor properties that a test may have
  // installed on Array.prototype in-process (e.g. Object.defineProperty(
  // Array.prototype, "1", {get: fn})). These survive test isolation and cause
  // "Cannot set property N of [object Array] which has only a getter" on the
  // next array index-write inside the validator itself.
  for (const key of Object.getOwnPropertyNames(Array.prototype)) {
    if (/^\d+$/.test(key)) {
      try {
        delete (Array.prototype as Record<string, unknown>)[key];
      } catch {}
    }
  }
}

const TEST262_ROOT = resolve(ROOT, "test262");

interface SampleFailure {
  file: string;
  expected: string;
  observed: string;
  reason?: string;
}

interface LaneResult {
  lane: string;
  passSampled: number;
  failSampled: number;
  failures: SampleFailure[];
}

/**
 * (#2095) Validate a single lane (host or standalone) and a single row class.
 *
 * For `expected: "pass"` rows we FAIL when the row no longer passes (the
 * historical #1218 check) — a `pass` row that regressed signals a rotted
 * baseline whose floor is now too low.
 *
 * For `expected: "fail"` rows we FAIL when the row now PASSES — a stale `fail`
 * row inflates the regression-gate `improvements` count and can mask one real
 * regression per PR diff (#2095). (A `fail` row that still fails — for any
 * reason — is healthy; we only flag the pass flip.)
 */
async function validateRowClass(
  lane: string,
  target: "standalone" | undefined,
  rows: BaselineEntry[],
  expected: "pass" | "fail",
  sampleSize: number,
  rng: () => number,
): Promise<SampleFailure[]> {
  const failures: SampleFailure[] = [];
  if (rows.length === 0) return failures;
  const sample = shuffle(rows, rng).slice(0, Math.min(sampleSize, rows.length));
  console.log(`  [${lane}] sampling ${sample.length} "${expected}" rows.`);

  for (let i = 0; i < sample.length; i++) {
    const entry = sample[i]!;
    const cat = categoryFor(entry.file);
    const fullPath = resolve(TEST262_ROOT, entry.file);
    try {
      const result = await runTest262File(fullPath, cat, undefined, target);
      // `skip` is pass-equivalent for our purposes — the sampled test is
      // filtered by current skip rules; that's config drift, not corruption.
      const nowPasses = result.status === "pass" || result.status === "skip";
      if (expected === "pass" && !nowPasses) {
        failures.push({
          file: entry.file,
          expected: "pass",
          observed: result.status,
          reason: result.error?.slice(0, 160) ?? result.reason,
        });
      } else if (expected === "fail" && result.status === "pass") {
        // A baseline `fail` row that now passes — stale baseline; inflates
        // improvements and can mask a regression. Treat as corruption.
        failures.push({
          file: entry.file,
          expected: "fail",
          observed: "pass",
          reason: "baseline 'fail' row now passes — baseline is stale (inflates improvements, masks regressions)",
        });
      }
    } catch (e: unknown) {
      // A runner exception only matters for `pass` rows — a `fail` row that
      // throws in the runner is still not passing, which is the healthy state.
      if (expected === "pass") {
        failures.push({
          file: entry.file,
          expected,
          observed: "runner_error",
          reason: (e as Error).message?.slice(0, 160) ?? String(e),
        });
      }
    } finally {
      restoreGlobals();
    }
  }
  return failures;
}

/** Validate one lane across both row classes. */
async function validateLane(
  lane: string,
  target: "standalone" | undefined,
  baselinePath: string,
  rng: () => number,
): Promise<LaneResult> {
  const baseline = loadBaseline(baselinePath);
  const passes = baseline.filter((e) => e.status === "pass");
  const fails = baseline.filter((e) => e.status === "fail");
  console.log(`[${lane}] baseline: ${baseline.length} entries — ${passes.length} pass, ${fails.length} fail.`);
  if (passes.length === 0) {
    console.error(`fatal: no \`pass\` entries in the ${lane} baseline — file appears empty or corrupt.`);
    process.exit(2);
  }

  const passFailures = await validateRowClass(lane, target, passes, "pass", SAMPLE_SIZE, rng);
  const failFailures = await validateRowClass(lane, target, fails, "fail", FAIL_SAMPLE_SIZE, rng);

  return {
    lane,
    passSampled: Math.min(SAMPLE_SIZE, passes.length),
    failSampled: Math.min(FAIL_SAMPLE_SIZE, fails.length),
    failures: [...passFailures, ...failFailures],
  };
}

async function main(): Promise<void> {
  // #1528 / #2095 — fetch BOTH lane baselines on demand from the baselines
  // repo and cache them locally. Both are idempotent (no-op when cached).
  let standaloneAvailable = true;
  try {
    await ensureBaselineJsonl();
  } catch (e: unknown) {
    console.error(`fatal: could not fetch host baseline JSONL: ${(e as Error).message}`);
    console.error(
      `       source: https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-current.jsonl`,
    );
    console.error(`       cache:  ${BASELINE_CACHE_PATH}`);
    process.exit(2);
  }
  try {
    await ensureStandaloneBaselineJsonl();
  } catch (e: unknown) {
    // The standalone baseline may not exist yet on a fresh seed; degrade to
    // host-only rather than failing the whole validator (#2095 / #1897 note).
    console.warn(
      `warning: standalone baseline JSONL unavailable (${(e as Error).message}); validating host lane only.`,
    );
    standaloneAvailable = false;
  }

  const seed = resolveSeed();
  console.log(`Seed=${seed}. Per-lane sample: ${SAMPLE_SIZE} pass rows + ${FAIL_SAMPLE_SIZE} fail rows.`);

  // One PRNG, consumed in a fixed order (host pass, host fail, standalone pass,
  // standalone fail) so the sample is deterministic given the seed.
  const rng = makePRNG(seed);
  const startMs = Date.now();

  const laneResults: LaneResult[] = [];
  laneResults.push(await validateLane("host", undefined, BASELINE_CACHE_PATH, rng));
  if (standaloneAvailable) {
    prepareStandaloneEvalProvider();
    laneResults.push(await validateLane("standalone", "standalone", STANDALONE_BASELINE_CACHE_PATH, rng));
  }

  const durationS = (Date.now() - startMs) / 1000;
  const allFailures = laneResults.flatMap((r) => r.failures);
  const totalSampled = laneResults.reduce((n, r) => n + r.passSampled + r.failSampled, 0);
  console.log(`\nValidated ${totalSampled} rows across ${laneResults.length} lane(s) in ${durationS.toFixed(1)}s.`);
  for (const r of laneResults) {
    const n = r.failures.length;
    console.log(
      `  [${r.lane}] ${r.passSampled} pass + ${r.failSampled} fail sampled — ${n} discrepanc${n === 1 ? "y" : "ies"}.`,
    );
  }

  if (allFailures.length === 0) {
    console.log("✅ Baseline is honest — both lanes, both row classes verified.");
    process.exit(0);
  }

  console.error("");
  console.error(
    `❌ Baseline drift detected: ${allFailures.length} of ${totalSampled} sampled rows no longer match the baseline on main HEAD.`,
  );
  console.error("");
  console.error(`Most-affected (top ${Math.min(5, allFailures.length)}):`);
  for (const f of allFailures.slice(0, 5)) {
    const reason = f.reason ? ` — ${f.reason}` : "";
    console.error(`  - ${f.file}  (expected: ${f.expected}, observed: ${f.observed})${reason}`);
  }
  if (allFailures.length > 5) console.error(`  ... ${allFailures.length - 5} more`);
  console.error("");
  console.error(`The baseline JSONLs are published to loopdive/js2wasm-baselines by`);
  console.error(`test262-sharded.yml's promote-baseline job after every push to main.`);
  console.error(`Force a fresh fetch with:  node scripts/fetch-baseline-jsonl.mjs --force`);
  console.error(`                           node scripts/fetch-baseline-jsonl.mjs --standalone --force`);
  console.error("");
  console.error(
    `Reproduce locally with:  PR_NUMBER=${process.env.PR_NUMBER ?? "<n>"} SAMPLE_SIZE=${SAMPLE_SIZE} FAIL_SAMPLE_SIZE=${FAIL_SAMPLE_SIZE} npx tsx scripts/validate-test262-baseline.ts`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(2);
});
