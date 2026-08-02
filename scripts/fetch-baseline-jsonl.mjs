#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1528 — Fetch the canonical test262 baseline JSONL from the
// `loopdive/js2wasm-baselines` repo on demand, caching it locally.
//
// Why this exists:
//   We used to commit ~15 MB `benchmarks/results/test262-current.jsonl` to
//   the main repo and refresh it with a dedicated workflow. The same data
//   already lives in `loopdive/js2wasm-baselines` (pushed by the
//   `promote-baseline` step in `test262-sharded.yml` after every push to
//   main). Carrying the duplicate in the main repo bloated every clone
//   and every CI checkout for no real benefit. This helper replaces the
//   committed copy with an on-demand fetch + local cache.
//
// Source:
//   https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-current.jsonl
//
// Cache location:
//   <repo-root>/.test262-cache/test262-current.jsonl   (gitignored)
//
// Usage:
//   node scripts/fetch-baseline-jsonl.mjs                # FRESHNESS IS THE DEFAULT (#3629):
//                                                        #   serves the cache when it is younger than
//                                                        #   DEFAULT_MAX_AGE_HOURS, otherwise refetches.
//                                                        #   ALWAYS reports what it served and how old it is.
//   node scripts/fetch-baseline-jsonl.mjs --force        # always re-download
//   node scripts/fetch-baseline-jsonl.mjs --offline      # serve the cache without network; says so loudly
//   node scripts/fetch-baseline-jsonl.mjs --max-age-hours N   # override the freshness window
//   node scripts/fetch-baseline-jsonl.mjs --no-cache     # download to a tmp path, do not write cache
//   node scripts/fetch-baseline-jsonl.mjs --print-path   # print the resolved cache path and exit 0
//
// (#3629) The bare command used to be a SILENT no-op when any cache existed —
// exit 0, no output, a week-stale file indistinguishable from a fresh fetch.
// It now refetches stale caches automatically and never returns without saying
// what it served. Reporting goes to STDERR so STDOUT stays parseable.
//
// Programmatic use (from other scripts):
//   import { ensureBaselineJsonl, BASELINE_CACHE_PATH } from "./fetch-baseline-jsonl.mjs";
//   await ensureBaselineJsonl();   // downloads if missing
//   const data = readFileSync(BASELINE_CACHE_PATH, "utf-8");
//
// Exit codes:
//   0 — cache is ready (either pre-existing or freshly downloaded)
//   1 — upstream unreachable AND no local cache exists
//   2 — internal error (filesystem, malformed args)

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// The baselines repo's default branch is `main` and the file lives at the
// repo root. If this ever moves, update both constants together — the URL
// and the documented path in `CLAUDE.md`.
export const BASELINE_REMOTE_URL =
  "https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-current.jsonl";

// (#2095) The STANDALONE lane has its own baseline JSONL in the same baselines
// repo, refreshed by the `promote-baseline` job alongside the host JSONL. The
// validator (#2095) samples it so a rotted standalone baseline can't silently
// weaken the #1897 standalone regression floor.
export const STANDALONE_BASELINE_REMOTE_URL =
  "https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl";

// (#3462) The FAST native-harness lane (host only) gates the merge queue against
// its OWN self-consistent baseline so the ~9,244 native-harness boundary flips
// are baked in once and never false-fail a PR (the #3450 hybrid two-oracle
// pipeline). It lives in the same baselines repo, seeded/refreshed on push:main
// from the merge_group's fast host JSONL (#3448 rework, wired in #3463) and
// initially seeded by #3465. Stamped `oracle_lane: fast-nativeharness`. This is
// NEVER read by any landing-page/badge path — the published number is honest v8.
export const FAST_BASELINE_REMOTE_URL =
  "https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-fast-current.jsonl";

export const BASELINE_CACHE_DIR = resolve(REPO_ROOT, ".test262-cache");
export const BASELINE_CACHE_PATH = resolve(BASELINE_CACHE_DIR, "test262-current.jsonl");
export const STANDALONE_BASELINE_CACHE_PATH = resolve(BASELINE_CACHE_DIR, "test262-standalone-current.jsonl");
export const FAST_BASELINE_CACHE_PATH = resolve(BASELINE_CACHE_DIR, "test262-fast-current.jsonl");

// Sanity-check thresholds — a healthy baseline has ~43k entries and is ~15 MB.
// Smaller than this almost certainly means a partial download or a corrupted
// upstream. We use a generous lower bound so legitimate trimming doesn't trip
// the guard.
const MIN_REASONABLE_BYTES = 1_000_000; // 1 MB — well below the ~15 MB norm
const MIN_REASONABLE_LINES = 5_000; // ~43k entries today

// (#3629) FRESHNESS. Before this, a cache hit was a SILENT no-op: the helper
// exited 0, printed nothing, and served whatever was on disk regardless of age.
// That is indistinguishable from a successful fresh fetch — the most dangerous
// shape a tool can have, because the error scales with cache age and looks
// perfectly healthy the whole way.
//
// Measured 2026-07-25: the bare command served a SEVEN-DAY-OLD cache reading
// `pass 25,545` while main was at `30,931` — a 5,386-test gap, an entire
// session's landed work invisible. Multiple dev lanes were told to "fetch
// fresh" with that exact incantation and silently got the stale file. A sibling
// lane's standalone cache was a snapshot from a wholesale-compile-error run
// (`compile_error 43,469 / pass 4,508`), so every "pass" in it was a negative
// test — an input that yields a confident, entirely wrong "0% vacuous, all
// clean" from any detector without a vacuity guard.
//
// So: freshness is now the DEFAULT. A cache older than this refetches
// automatically; `--offline` is the opt-in for the genuinely disconnected case.
export const DEFAULT_MAX_AGE_HOURS = 6;

export const CACHE_ABSENT = "ABSENT";
export const CACHE_TOO_SMALL = "TOO_SMALL";
export const CACHE_STALE = "STALE";
export const CACHE_FRESH = "FRESH";

/**
 * Classify a cache file by presence, size and AGE. Pure — the caller does the
 * `stat`, so this is directly testable without touching the filesystem.
 *
 * @param {{exists: boolean, sizeBytes?: number, mtimeMs?: number}} stat
 * @param {{now?: number, maxAgeHours?: number, minBytes?: number}} [opts]
 * @returns {{state: string, ageHours: number|null, sizeBytes: number|null}}
 */
export function classifyCache(stat, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const minBytes = opts.minBytes ?? MIN_REASONABLE_BYTES;

  if (!stat || !stat.exists) return { state: CACHE_ABSENT, ageHours: null, sizeBytes: null };
  const sizeBytes = typeof stat.sizeBytes === "number" ? stat.sizeBytes : null;
  if (sizeBytes === null || sizeBytes < minBytes) {
    return { state: CACHE_TOO_SMALL, ageHours: null, sizeBytes };
  }
  // An unreadable/absent mtime means we CANNOT establish freshness. Treat that
  // as STALE (refetch), never as FRESH — "I don't know how old this is" must
  // not resolve to "it's current". Same third-state rule as every other
  // detector in this repo.
  const mtimeMs = typeof stat.mtimeMs === "number" && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  if (mtimeMs === null) return { state: CACHE_STALE, ageHours: null, sizeBytes };

  const ageHours = (now - mtimeMs) / 3_600_000;
  return { state: ageHours > maxAgeHours ? CACHE_STALE : CACHE_FRESH, ageHours, sizeBytes };
}

/** Human-readable age, or an explicit "unknown" — never a silent blank. */
export function formatAge(ageHours) {
  if (ageHours === null || ageHours === undefined || !Number.isFinite(ageHours)) return "age UNKNOWN";
  if (ageHours < 1) return `${Math.round(ageHours * 60)}m old`;
  if (ageHours < 48) return `${ageHours.toFixed(1)}h old`;
  return `${(ageHours / 24).toFixed(1)}d old`;
}

/**
 * All #3629 reporting goes to STDERR on purpose. Callers parse STDOUT for the
 * cache path (`--print-path`, and the path echoed under `--force`/`--no-cache`),
 * so adding informational lines there would break them. Loud-to-a-human and
 * clean-to-a-pipe are not in tension as long as they use different streams.
 */
function report(msg) {
  process.stderr.write(`[fetch-baseline-jsonl] ${msg}\n`);
}

/**
 * Download the baseline JSONL from the baselines repo to a target path.
 * Throws on network failure or sanity-check failure.
 *
 * @param {string} targetPath absolute path to write to
 * @returns {Promise<{ bytes: number; lines: number }>}
 */
async function downloadTo(targetPath, url = BASELINE_REMOTE_URL) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "js2wasm-baseline-fetcher/1.0" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0).length;
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes < MIN_REASONABLE_BYTES || lines < MIN_REASONABLE_LINES) {
    throw new Error(
      `Downloaded baseline looks truncated (bytes=${bytes}, lines=${lines}). ` + `Refusing to write. Source: ${url}`,
    );
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, text);
  return { bytes, lines };
}

/**
 * Make sure `BASELINE_CACHE_PATH` exists and is non-trivially populated.
 * Returns the path. Idempotent: a no-op if the cache is already present
 * and `force` is false.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]   force re-download even if cache exists
 * @param {boolean} [opts.noCache] write to a tempfile and return that path
 *                                 instead of populating the persistent cache
 * @returns {Promise<string>} absolute path to a JSONL file ready to read
 */
export async function ensureBaselineJsonl(opts = {}) {
  return ensureLaneBaselineJsonl(BASELINE_REMOTE_URL, BASELINE_CACHE_PATH, "test262-current", opts);
}

/**
 * (#2095) Standalone-lane analog of {@link ensureBaselineJsonl}. Fetches
 * `test262-standalone-current.jsonl` from the baselines repo to
 * `STANDALONE_BASELINE_CACHE_PATH`. Same idempotent + graceful-fallback
 * semantics as the host fetch.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 * @param {boolean} [opts.noCache]
 * @returns {Promise<string>} absolute path to a standalone JSONL ready to read
 */
export async function ensureStandaloneBaselineJsonl(opts = {}) {
  return ensureLaneBaselineJsonl(
    STANDALONE_BASELINE_REMOTE_URL,
    STANDALONE_BASELINE_CACHE_PATH,
    "test262-standalone-current",
    opts,
  );
}

/**
 * (#3462) FAST-lane analog of {@link ensureBaselineJsonl}. Fetches
 * `test262-fast-current.jsonl` (host-only native-harness baseline) from the
 * baselines repo to `FAST_BASELINE_CACHE_PATH`. Same idempotent +
 * graceful-fallback semantics as the host/standalone fetch: an existing cache is
 * a no-op; a download failure falls back to a present cache and only throws when
 * upstream is unreachable AND no cache exists. The regression gate selects this
 * baseline for the host diff when the run is fast-mode (`TEST262_ORACLE_MODE=fast`,
 * wired in #3463). Until the fast baseline is seeded (#3465) upstream 404s, so
 * callers must not invoke this before the seed exists (documented ordering).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 * @param {boolean} [opts.noCache]
 * @returns {Promise<string>} absolute path to the fast-lane JSONL ready to read
 */
export async function ensureFastBaselineJsonl(opts = {}) {
  return ensureLaneBaselineJsonl(FAST_BASELINE_REMOTE_URL, FAST_BASELINE_CACHE_PATH, "test262-fast-current", opts);
}

/**
 * Shared fetch+cache core for a single lane's baseline JSONL.
 *
 * @param {string} remoteUrl   raw.githubusercontent URL of the lane's JSONL
 * @param {string} cachePath   absolute local cache path for the lane
 * @param {string} stem        cache-file stem, used for the --no-cache tmp name
 * @param {{force?: boolean, noCache?: boolean}} [opts]
 * @returns {Promise<string>}
 */
async function ensureLaneBaselineJsonl(remoteUrl, cachePath, stem, opts = {}) {
  const { force = false, noCache = false, offline = false, maxAgeHours = DEFAULT_MAX_AGE_HOURS } = opts;

  if (noCache) {
    const tmpPath = resolve(BASELINE_CACHE_DIR, `${stem}.${process.pid}.tmp.jsonl`);
    await downloadTo(tmpPath, remoteUrl);
    return tmpPath;
  }

  // (#3629) Classify the cache BEFORE deciding, and always say what we found.
  const exists = existsSync(cachePath);
  let st = { exists };
  if (exists) {
    try {
      const s = statSync(cachePath);
      st = { exists: true, sizeBytes: s.size, mtimeMs: s.mtimeMs };
    } catch {
      st = { exists: true }; // unreadable stat → classifies STALE, not FRESH
    }
  }
  const { state, ageHours, sizeBytes } = classifyCache(st, { maxAgeHours });
  const describe = () => `${cachePath} (${(sizeBytes ?? 0).toLocaleString()} bytes, ${formatAge(ageHours)})`;

  if (!force && exists) {
    if (state === CACHE_FRESH) {
      // THE FIX FOR THE SILENT NO-OP: this path used to `return` with no output
      // whatsoever. Serving a cache is a legitimate outcome; doing it invisibly
      // is not.
      report(`serving CACHED baseline — ${describe()}; within ${maxAgeHours}h freshness window.`);
      return cachePath;
    }
    if (offline) {
      // Opt-in disconnected mode. Still never silent, and never claims currency
      // it cannot establish.
      report(
        `⚠ OFFLINE: serving a cache whose freshness is NOT established — ${describe()} ` +
          `(state=${state}, window ${maxAgeHours}h). Numbers derived from it may be stale. Re-run without --offline to refresh.`,
      );
      return cachePath;
    }
    report(
      state === CACHE_TOO_SMALL
        ? `cached file is suspiciously small (${sizeBytes ?? 0} bytes) — re-downloading.`
        : `cached baseline is STALE (${describe()}, window ${maxAgeHours}h) — refetching automatically.`,
    );
  } else if (!exists && offline) {
    throw new Error(`--offline requested but no cache exists at ${cachePath}. Nothing to serve.`);
  }

  try {
    const { bytes, lines } = await downloadTo(cachePath, remoteUrl);
    console.log(
      `[fetch-baseline-jsonl] downloaded ${remoteUrl} -> ${cachePath} ` +
        `(${bytes.toLocaleString()} bytes, ${lines.toLocaleString()} entries).`,
    );
    return cachePath;
  } catch (e) {
    // THE THIRD STATE: upstream unreachable but a cache exists. We can serve
    // bytes, but we CANNOT say they are current — and "the fetch command exited
    // 0" must not be readable as "the cache is up to date". Previously this
    // warned without ever naming the cache's age, so a 7-day-old file and a
    // 5-minute-old one produced the same reassuring line.
    if (exists) {
      report(
        `⚠ COULD NOT VERIFY FRESHNESS: download failed (${e instanceof Error ? e.message : e}). ` +
          `Falling back to the existing cache — ${describe()}, state=${state}. ` +
          `This is NOT a confirmation that the cache is current.`,
      );
      return cachePath;
    }
    throw e;
  }
}

// CLI entrypoint — only run when invoked as a script, not when imported.
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const noCache = args.includes("--no-cache");
  const printPath = args.includes("--print-path");
  const offline = args.includes("--offline"); // (#3629) opt-in: serve cache without network
  const maxAgeIdx = args.indexOf("--max-age-hours");
  const maxAgeHours = maxAgeIdx >= 0 ? Number(args[maxAgeIdx + 1]) : DEFAULT_MAX_AGE_HOURS;
  const standalone = args.includes("--standalone"); // (#2095) fetch the standalone lane JSONL
  const fast = args.includes("--fast"); // (#3462) fetch the fast native-harness (host) lane JSONL

  const cachePath = fast ? FAST_BASELINE_CACHE_PATH : standalone ? STANDALONE_BASELINE_CACHE_PATH : BASELINE_CACHE_PATH;
  const ensure = fast ? ensureFastBaselineJsonl : standalone ? ensureStandaloneBaselineJsonl : ensureBaselineJsonl;
  const remoteUrl = fast ? FAST_BASELINE_REMOTE_URL : standalone ? STANDALONE_BASELINE_REMOTE_URL : BASELINE_REMOTE_URL;

  if (printPath) {
    process.stdout.write(`${cachePath}\n`);
    process.exit(0);
  }

  ensure({ force, noCache, offline, maxAgeHours })
    .then((path) => {
      if (force || noCache) process.stdout.write(`${path}\n`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`[fetch-baseline-jsonl] fatal: ${e instanceof Error ? e.message : e}`);
      console.error(`[fetch-baseline-jsonl] upstream: ${remoteUrl}`);
      console.error(`[fetch-baseline-jsonl] if the upstream URL has changed, update scripts/fetch-baseline-jsonl.mjs.`);
      process.exit(1);
    });
}
