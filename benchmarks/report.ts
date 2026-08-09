import { isMeasured, type BenchmarkResult, type Strategy } from "./harness.js";
import * as fs from "node:fs";
import * as path from "node:path";

const STRATEGIES: Strategy[] = ["js", "host-call", "gc-native", "linear-memory"];

interface GroupedRow {
  name: string;
  results: Map<Strategy, BenchmarkResult>;
}

function groupByName(results: BenchmarkResult[]): GroupedRow[] {
  const map = new Map<string, Map<Strategy, BenchmarkResult>>();
  for (const r of results) {
    let m = map.get(r.name);
    if (!m) {
      m = new Map();
      map.set(r.name, m);
    }
    m.set(r.strategy, r);
  }
  return Array.from(map.entries()).map(([name, results]) => ({ name, results }));
}

/** Measured result for a strategy, or undefined when absent or failed (#3904). */
function measured(row: GroupedRow, s: Strategy): BenchmarkResult | undefined {
  const r = row.results.get(s);
  return r && isMeasured(r) ? r : undefined;
}

function winner(row: GroupedRow): Strategy | null {
  let best: Strategy | null = null;
  let bestMs = Infinity;
  for (const [s, r] of row.results) {
    // A failed lane carries medianMs === 0 and would otherwise always "win".
    if (!isMeasured(r)) continue;
    if (r.medianMs < bestMs) {
      bestMs = r.medianMs;
      best = s;
    }
  }
  return best;
}

function fmtMs(ms: number): string {
  if (ms < 0.001) return "<0.001ms";
  if (ms < 1) return ms.toFixed(3) + "ms";
  if (ms < 100) return ms.toFixed(2) + "ms";
  return ms.toFixed(1) + "ms";
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

function speedup(row: GroupedRow, base: Strategy, target: Strategy): string {
  const b = measured(row, base);
  const t = measured(row, target);
  if (!b || !t) return "—";
  // #3898 — a ratio against an implausible lane is not a measurement.
  if (b.implausible || t.implausible) return "⚠ implausible";
  const ratio = b.medianMs / t.medianMs;
  if (ratio > 1) return `${ratio.toFixed(2)}x faster`;
  if (ratio < 1) return `${(1 / ratio).toFixed(2)}x slower`;
  return "1.00x";
}

// ---------------------------------------------------------------------------
// Plausibility guard (#3898)
// ---------------------------------------------------------------------------

/**
 * Floor on the cost of one primitive string/array operation, in nanoseconds.
 *
 * At 3 GHz a clock cycle is ~0.33 ns. No `indexOf` over a 10,000-character
 * haystack, and no `toLowerCase` of a 23-character string, completes in under
 * three cycles. A lane reporting below this floor is not doing the work its
 * benchmark claims — in #3898 the cause was TurboFan hoisting a loop-invariant
 * call out of the JS baseline's loop and running it once, which made the
 * published "js2wasm is 16,000x slower" bars pure artifacts.
 */
export const MIN_PLAUSIBLE_NS_PER_OP = 1;

/**
 * Mark every lane whose implied per-operation cost is impossible. Mutates
 * `results` in place and returns the offending lanes.
 *
 * The floor is `max(MIN_PLAUSIBLE_NS_PER_OP, def.minNsPerOp)`: the universal
 * physical bound, raised where the benchmark knows more about its own operation.
 * `string/indexOf` is why the second term exists — its hoisted baseline reported
 * 1.56 ns/op, which clears 1 ns yet is still ~20x faster than the honest cost.
 *
 * Only benchmarks that declare `opsPerCall` are checked; the guard cannot know
 * the operation count otherwise.
 *
 * Failed rows (#3904) are exempt. They carry `medianMs === 0` by construction,
 * so an unguarded check would compute 0 ns/op and report every broken lane as a
 * hoisted one — turning a precise "compile error in gc-native" into a wrong
 * "the loop was eliminated". A lane that never ran has no per-op cost to judge.
 */
export function flagImplausibleLanes(results: BenchmarkResult[]): BenchmarkResult[] {
  const flagged: BenchmarkResult[] = [];
  for (const r of results) {
    if (!isMeasured(r)) continue;
    if (!r.opsPerCall) continue;
    const nsPerOp = r.nsPerOp ?? (r.medianMs * 1e6) / r.opsPerCall;
    r.nsPerOp = nsPerOp;
    const floor = Math.max(MIN_PLAUSIBLE_NS_PER_OP, r.minNsPerOp ?? 0);
    if (nsPerOp < floor) {
      r.implausible = true;
      flagged.push(r);
    } else if (r.implausible) {
      delete r.implausible;
    }
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

export function generateMarkdown(results: BenchmarkResult[]): string {
  const rows = groupByName(results);
  const lines: string[] = [];

  lines.push("# js2wasm Benchmark Results\n");
  lines.push(`Date: ${new Date().toISOString().split("T")[0]}`);
  lines.push(`Node: ${process.version}`);
  lines.push(`Platform: ${process.platform} ${process.arch}\n`);

  // Plausibility warnings (#3898) — surfaced above the numbers, not buried.
  const implausible = results.filter((r) => r.implausible);
  if (implausible.length > 0) {
    lines.push("## ⚠ Implausible lanes — NOT valid comparisons\n");
    lines.push(
      "The following lanes report a per-operation cost below their physical " +
        "floor. The engine almost certainly hoisted or eliminated the " +
        "benchmark's inner loop, so any speedup computed against them is an " +
        "artifact (see #3898).\n",
    );
    lines.push("| Benchmark | Strategy | median | ops/call | ns/op | floor |");
    lines.push("|-----------|----------|--------|----------|-------|-------|");
    for (const r of implausible) {
      const floor = Math.max(MIN_PLAUSIBLE_NS_PER_OP, r.minNsPerOp ?? 0);
      lines.push(
        `| ${r.name} | ${r.strategy} | ${fmtMs(r.medianMs)} | ${r.opsPerCall} | ` +
          `${r.nsPerOp?.toFixed(3)} | ${floor} |`,
      );
    }
    lines.push("");
  }

  // Summary table
  lines.push("## Summary\n");
  lines.push("| Benchmark | JS | Host-call | GC-native | Linear | Winner |");
  lines.push("|-----------|-----|-----------|-----------|--------|--------|");
  for (const row of rows) {
    const cols = STRATEGIES.map((s) => {
      const r = row.results.get(s);
      // Three distinct states, and conflating any two of them is a bug that has
      // already shipped once: "—" not applicable (#3904), "FAILED" ran and broke
      // (#3904), "⚠" measured but the number is impossible (#3898).
      if (!r) return "—"; // deliberately skipped / not applicable
      if (!isMeasured(r)) return "FAILED";
      return r.implausible ? `⚠ ${fmtMs(r.medianMs)}` : fmtMs(r.medianMs);
    });
    const w = winner(row) ?? "—";
    lines.push(`| ${row.name} | ${cols.join(" | ")} | ${w} |`);
  }

  // (#3904) Spell the failures out. "—" means not applicable; a lane listed
  // here ran and broke, and the message is what makes it diagnosable without
  // re-running the suite.
  const failures = results.filter((r) => !isMeasured(r));
  if (failures.length > 0) {
    lines.push("\n## Failed strategies\n");
    lines.push("| Benchmark | Strategy | Phase | Error |");
    lines.push("|-----------|----------|-------|-------|");
    for (const f of failures) {
      lines.push(`| ${f.name} | ${f.strategy} | ${f.failedPhase ?? "?"} | ${f.error ?? "(no message)"} |`);
    }
  }

  // (#3898) Per-operation costs — the sanity check that catches a collapsed
  // loop. Failed rows have no timings to divide, so they stay out of this table
  // entirely; they are already accounted for in "Failed strategies" above.
  const withOps = rows.filter((row) => Array.from(row.results.values()).some((r) => isMeasured(r) && r.opsPerCall));
  if (withOps.length > 0) {
    lines.push("\n## Cost per operation (ns)\n");
    lines.push("| Benchmark | ops/call | JS | Host-call | GC-native | Linear |");
    lines.push("|-----------|----------|-----|-----------|-----------|--------|");
    for (const row of withOps) {
      const ops = Array.from(row.results.values()).find((r) => isMeasured(r) && r.opsPerCall)?.opsPerCall;
      const cols = STRATEGIES.map((s) => {
        const r = measured(row, s);
        if (!r?.nsPerOp) return "—";
        return (r.implausible ? "⚠ " : "") + r.nsPerOp.toFixed(2);
      });
      lines.push(`| ${row.name} | ${ops} | ${cols.join(" | ")} |`);
    }
  }

  // Speedup vs JS
  lines.push("\n## Speedup vs JS baseline\n");
  lines.push("| Benchmark | Host-call | GC-native | Linear |");
  lines.push("|-----------|-----------|-----------|--------|");
  for (const row of rows) {
    const hc = speedup(row, "js", "host-call");
    const gc = speedup(row, "js", "gc-native");
    const lm = speedup(row, "js", "linear-memory");
    lines.push(`| ${row.name} | ${hc} | ${gc} | ${lm} |`);
  }

  // Speedup: GC-native vs host-call
  lines.push("\n## GC-native vs Host-call\n");
  lines.push("| Benchmark | Speedup |");
  lines.push("|-----------|---------|");
  for (const row of rows) {
    const s = speedup(row, "host-call", "gc-native");
    if (s !== "—") lines.push(`| ${row.name} | ${s} |`);
  }

  // Binary sizes
  const hasSizes = rows.some((r) => Array.from(r.results.values()).some((v) => v.binarySize));
  if (hasSizes) {
    lines.push("\n## Binary sizes\n");
    lines.push("| Benchmark | Host-call | GC-native | Linear |");
    lines.push("|-----------|-----------|-----------|--------|");
    for (const row of rows) {
      const cols = (["host-call", "gc-native", "linear-memory"] as Strategy[]).map((s) => {
        const r = measured(row, s);
        return r?.binarySize ? fmtSize(r.binarySize) : "—";
      });
      lines.push(`| ${row.name} | ${cols.join(" | ")} |`);
    }
  }

  // Compile times
  lines.push("\n## Compile times\n");
  lines.push("| Benchmark | Host-call | GC-native | Linear |");
  lines.push("|-----------|-----------|-----------|--------|");
  for (const row of rows) {
    const cols = (["host-call", "gc-native", "linear-memory"] as Strategy[]).map((s) => {
      const r = measured(row, s);
      return r?.compileMs ? fmtMs(r.compileMs) : "—";
    });
    lines.push(`| ${row.name} | ${cols.join(" | ")} |`);
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Save results
// ---------------------------------------------------------------------------

export function saveResults(results: BenchmarkResult[], outDir: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  // #3898 — refuse to publish a lane that reports impossible per-op costs.
  const flagged = flagImplausibleLanes(results);
  if (flagged.length > 0) {
    process.stderr.write(
      `\n!! ${flagged.length} benchmark lane(s) report an impossible per-operation cost\n` +
        `   and are NOT valid comparisons (#3898):\n` +
        flagged
          .map(
            (r) =>
              `     ${r.name} [${r.strategy}] — ${r.nsPerOp?.toFixed(3)} ns/op over ${r.opsPerCall} ops ` +
              `(floor ${Math.max(MIN_PLAUSIBLE_NS_PER_OP, r.minNsPerOp ?? 0)} ns)\n`,
          )
          .join("") +
        `   The inner loop was almost certainly hoisted or eliminated. Fix the\n` +
        `   benchmark input so it varies with the loop induction variable.\n\n`,
    );
    process.exitCode = 1;
  }

  // JSON
  const jsonPath = `${outDir}/${timestamp}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${jsonPath}`);

  // Markdown
  const md = generateMarkdown(results);
  const mdPath = `${outDir}/${timestamp}.md`;
  fs.writeFileSync(mdPath, md);
  console.log(`Report saved to ${mdPath}`);

  // Also write latest
  fs.writeFileSync(`${outDir}/latest.json`, JSON.stringify(results, null, 2));
  fs.writeFileSync(`${outDir}/latest.md`, md);

  // Build history.json from all timestamped result files
  buildHistory(outDir);
  syncPublicSummary(outDir);
}

// ---------------------------------------------------------------------------
// History — aggregate all timestamped result files into history.json
// ---------------------------------------------------------------------------

interface HistoryPoint {
  timestamp: string;
  benchmarks: Record<string, Record<string, number>>; // name → strategy → medianMs
}

export function buildHistory(outDir: string): void {
  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(f))
    .sort();

  // The repository intentionally keeps only a small subset of the historical
  // timestamped result files. Preserve the committed aggregate before folding
  // in files produced by this checkout; rebuilding from the sparse file set
  // alone silently truncated history on every refresh.
  const byTimestamp = new Map<string, HistoryPoint>();
  const historyPath = `${outDir}/history.json`;
  if (fs.existsSync(historyPath)) {
    try {
      const existing: HistoryPoint[] = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
      if (Array.isArray(existing)) {
        for (const point of existing) {
          if (
            point &&
            typeof point.timestamp === "string" &&
            Number.isFinite(Date.parse(point.timestamp)) &&
            point.benchmarks &&
            typeof point.benchmarks === "object" &&
            !Array.isArray(point.benchmarks)
          ) {
            byTimestamp.set(point.timestamp, point);
          }
        }
      }
    } catch {
      // A malformed aggregate must not hide valid timestamped source files.
    }
  }

  for (const file of files) {
    // Parse timestamp from filename: 2026-03-07T23-00-07-232Z → 2026-03-07T23:00:07.232Z
    const isoTimestamp = file
      .replace(/\.json$/, "")
      .replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/, "$1$2:$3:$4.$5Z");

    try {
      const raw: BenchmarkResult[] = JSON.parse(fs.readFileSync(`${outDir}/${file}`, "utf-8"));
      const benchmarks: Record<string, Record<string, number>> = {};
      for (const r of raw) {
        // (#3904) Failed lanes carry medianMs === 0; folding them into the
        // trend series would plot a phantom "infinitely fast" data point.
        if (!isMeasured(r)) continue;
        if (!benchmarks[r.name]) benchmarks[r.name] = {};
        benchmarks[r.name][r.strategy] = r.medianMs;
      }
      // Timestamped source files are authoritative for their own point and
      // replace any matching point from the committed aggregate.
      byTimestamp.set(isoTimestamp, { timestamp: isoTimestamp, benchmarks });
    } catch {}
  }

  const history = [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  fs.writeFileSync(`${outDir}/history.json`, JSON.stringify(history, null, 2));
  console.log(`History saved to ${outDir}/history.json (${history.length} runs)`);
}

function syncPublicSummary(outDir: string): void {
  const publicResultsDir = path.resolve(outDir, "..", "..", "public", "benchmarks", "results");
  fs.mkdirSync(publicResultsDir, { recursive: true });

  for (const file of ["latest.json", "history.json"]) {
    const source = path.join(outDir, file);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(publicResultsDir, file));
  }

  console.log(`Public benchmark summaries updated in ${publicResultsDir}`);
}
