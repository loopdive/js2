#!/usr/bin/env node
/**
 * Append per-ES-edition and per-standalone-target test262 snapshots to the
 * trend-history files that back the landing page's mini edition trend graphs
 * and the scope-reactive primary trend graph.
 *
 * Mirrors the existing runs/index.json append pattern (inline in
 * test262-sharded.yml / refresh-baseline.yml) as a single shared, testable
 * script instead of duplicating the snippet a fourth time.
 *
 * Usage:
 *   node scripts/append-run-history.mjs --runs-dir <dir> [--sha <sha>] \
 *     [--editions <test262-editions.json>] \
 *     [--standalone-editions <test262-standalone-editions.json>] \
 *     [--standalone-report <test262-standalone-report.json>]
 *
 * Writes/updates (only for inputs that were passed and exist):
 *   <runs-dir>/editions-index.json            — [{ timestamp, gitHash, editions: [{edition, pass, total}] }]
 *   <runs-dir>/standalone-editions-index.json — same shape, host-free lane (#4362)
 *   <runs-dir>/standalone-index.json          — [{ timestamp, gitHash, pass, fail, ce, skip, total }]
 *
 * Best-effort: each file is appended independently, and any failure (missing
 * or malformed input) is logged and skipped rather than failing the process —
 * this is cosmetic trend history, not baseline data the regression gate
 * depends on, so it must never block a promote/refresh pipeline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith("--") ? argv[++i] : true;
      args[key] = value;
    }
  }
  return args;
}

function timestampNow() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").substring(0, 15);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function appendEntry(indexPath, entry, isDuplicate) {
  mkdirSync(dirname(indexPath), { recursive: true });
  let idx = [];
  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
      if (Array.isArray(parsed)) idx = parsed;
    } catch {
      idx = [];
    }
  }
  const last = idx[idx.length - 1];
  if (last && isDuplicate(last, entry)) {
    console.log(`append-run-history: skipped duplicate entry for ${indexPath}`);
    return;
  }
  idx.push(entry);
  writeFileSync(indexPath, JSON.stringify(idx, null, 2));
  console.log(`append-run-history: appended to ${indexPath}`);
}

/**
 * Append one per-ES-edition snapshot.
 *
 * `indexName` selects the lane: `editions-index.json` (JS-host) or
 * `standalone-editions-index.json` (#4362, host-free). The two lanes are
 * separate FILES rather than two series in one entry because they are produced
 * by different runs at different times — the host editions file is regenerated
 * in promote-baseline, the standalone one alongside it from the standalone
 * baseline JSONL — and interleaving them in a single index would make the
 * duplicate-suppression check compare a host snapshot against a standalone one
 * and never dedupe.
 */
function appendEditions(runsDir, editionsPath, gitHash, indexName = "editions-index.json") {
  if (!editionsPath || typeof editionsPath !== "string" || !existsSync(editionsPath)) {
    console.log(`append-run-history: no editions file provided/found — skipping ${indexName}.`);
    return;
  }
  try {
    const editions = readJson(editionsPath);
    if (!Array.isArray(editions) || editions.length === 0) return;
    const entry = {
      timestamp: timestampNow(),
      gitHash: String(gitHash || "").substring(0, 8),
      editions: editions.map((e) => ({
        edition: String(e?.edition || ""),
        pass: Number(e?.pass || 0),
        total: Number(e?.total || 0),
      })),
    };
    appendEntry(join(runsDir, indexName), entry, (last, next) => {
      if (!Array.isArray(last.editions) || last.editions.length !== next.editions.length) return false;
      return last.editions.every(
        (e, i) =>
          e.edition === next.editions[i].edition &&
          e.pass === next.editions[i].pass &&
          e.total === next.editions[i].total,
      );
    });
  } catch (err) {
    console.log(`append-run-history: ${indexName} append failed (non-fatal): ${err.message}`);
  }
}

function appendStandalone(runsDir, reportPath, gitHash) {
  if (!reportPath || typeof reportPath !== "string" || !existsSync(reportPath)) {
    console.log("append-run-history: no standalone report provided/found — skipping standalone-index.json.");
    return;
  }
  try {
    const report = readJson(reportPath);
    const s = report?.summary || {};
    const entry = {
      timestamp: timestampNow(),
      gitHash: String(gitHash || "").substring(0, 8),
      pass: Number(s.pass || 0),
      fail: Number(s.fail || 0),
      ce: Number(s.compile_error || 0),
      skip: Number(s.skip || 0),
      total: Number(s.total || 0),
    };
    if (entry.total <= 0) return;
    appendEntry(
      join(runsDir, "standalone-index.json"),
      entry,
      (last, next) => last.pass === next.pass && last.total === next.total,
    );
  } catch (err) {
    console.log(`append-run-history: standalone-index.json append failed (non-fatal): ${err.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runsDir = args["runs-dir"];
  if (!runsDir || typeof runsDir !== "string") {
    console.log("append-run-history: --runs-dir is required — nothing to do.");
    return;
  }
  appendEditions(runsDir, args["editions"], args["sha"]);
  appendEditions(runsDir, args["standalone-editions"], args["sha"], "standalone-editions-index.json");
  appendStandalone(runsDir, args["standalone-report"], args["sha"]);
}

main();
