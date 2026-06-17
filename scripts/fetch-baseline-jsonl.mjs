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
//   node scripts/fetch-baseline-jsonl.mjs                # cache-aware, no-op if cached
//   node scripts/fetch-baseline-jsonl.mjs --force        # always re-download
//   node scripts/fetch-baseline-jsonl.mjs --no-cache     # download to a tmp path, do not write cache
//   node scripts/fetch-baseline-jsonl.mjs --print-path   # print the resolved cache path and exit 0
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

export const BASELINE_CACHE_DIR = resolve(REPO_ROOT, ".test262-cache");
export const BASELINE_CACHE_PATH = resolve(BASELINE_CACHE_DIR, "test262-current.jsonl");
export const STANDALONE_BASELINE_CACHE_PATH = resolve(BASELINE_CACHE_DIR, "test262-standalone-current.jsonl");

// Sanity-check thresholds — a healthy baseline has ~43k entries and is ~15 MB.
// Smaller than this almost certainly means a partial download or a corrupted
// upstream. We use a generous lower bound so legitimate trimming doesn't trip
// the guard.
const MIN_REASONABLE_BYTES = 1_000_000; // 1 MB — well below the ~15 MB norm
const MIN_REASONABLE_LINES = 5_000; // ~43k entries today

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
 * Shared fetch+cache core for a single lane's baseline JSONL.
 *
 * @param {string} remoteUrl   raw.githubusercontent URL of the lane's JSONL
 * @param {string} cachePath   absolute local cache path for the lane
 * @param {string} stem        cache-file stem, used for the --no-cache tmp name
 * @param {{force?: boolean, noCache?: boolean}} [opts]
 * @returns {Promise<string>}
 */
async function ensureLaneBaselineJsonl(remoteUrl, cachePath, stem, opts = {}) {
  const { force = false, noCache = false } = opts;

  if (noCache) {
    const tmpPath = resolve(BASELINE_CACHE_DIR, `${stem}.${process.pid}.tmp.jsonl`);
    await downloadTo(tmpPath, remoteUrl);
    return tmpPath;
  }

  if (!force && existsSync(cachePath)) {
    const sz = statSync(cachePath).size;
    if (sz >= MIN_REASONABLE_BYTES) {
      return cachePath;
    }
    // Cached file exists but looks suspicious — fall through and re-download.
    console.warn(`[fetch-baseline-jsonl] cached file is suspiciously small (${sz} bytes); re-downloading.`);
  }

  try {
    const { bytes, lines } = await downloadTo(cachePath, remoteUrl);
    console.log(
      `[fetch-baseline-jsonl] downloaded ${remoteUrl} -> ${cachePath} ` +
        `(${bytes.toLocaleString()} bytes, ${lines.toLocaleString()} entries).`,
    );
    return cachePath;
  } catch (e) {
    // If we already have a cached copy, fall back to it — better stale than
    // nothing. Callers that need fresh data should pass `force: true`.
    if (existsSync(cachePath)) {
      console.warn(
        `[fetch-baseline-jsonl] download failed (${e instanceof Error ? e.message : e}); ` +
          `using existing cache at ${cachePath}.`,
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
  const standalone = args.includes("--standalone"); // (#2095) fetch the standalone lane JSONL

  const cachePath = standalone ? STANDALONE_BASELINE_CACHE_PATH : BASELINE_CACHE_PATH;
  const ensure = standalone ? ensureStandaloneBaselineJsonl : ensureBaselineJsonl;
  const remoteUrl = standalone ? STANDALONE_BASELINE_REMOTE_URL : BASELINE_REMOTE_URL;

  if (printPath) {
    process.stdout.write(`${cachePath}\n`);
    process.exit(0);
  }

  ensure({ force, noCache })
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
