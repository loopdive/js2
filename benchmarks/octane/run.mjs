// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#874) Octane harness orchestrator. For every selected (bench, lane) it spawns
// ONE child process (isolation from realm pollution, OOM and hangs), collects
// its single JSON status row, and writes
// `benchmarks/results/octane-latest.json` + a timestamped twin (both
// gitignored). Every pair gets exactly one row — a bench that does not compile
// is a row, never an omission.
//
//   pnpm run benchmark:octane:fetch
//   pnpm run benchmark:octane [-- --only richards,deltablue] [--lanes node,gc]
//                             [--reps N] [--timeout SEC] [--run-timeout SEC]
//                             [--out path] [--tamper]
//
// --reps     fixed reps for every lane (default: calibrated on node so one
//            octane_run(reps) call takes ≥ 50 ms, then the SAME reps on all lanes)
// --timeout      compile + instantiate budget per row, seconds (default 900 —
//                box2d standalone compiles for ~4.5 min on a loaded 4-vCPU box)
// --run-timeout  budget for the measured run once the worker reports READY
//                (default 180; a lane that cannot finish node-calibrated reps
//                in that time is a `skipped: timeout (run)` row, with its
//                compile size/time kept)
// --tamper   self-test: append each bench's validation-breaking snippet; every
//            validated bench must then report wrong-result (writes
//            octane-tamper-latest.json instead of octane-latest.json)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { READY_MARKER, ROW_MARKER, SAMPLES } from "./common.mjs";
import { ensureOctaneSources, MANIFEST, REPO_ROOT } from "./fetch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALL_LANES = ["node", "gc", "standalone", "linear", "porffor"];
const JS2_LANES = new Set(["gc", "standalone", "linear"]);

function parseArgs(argv) {
  const get = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (v) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  return {
    only: list(get("only")),
    lanes: list(get("lanes")) ?? ALL_LANES,
    reps: get("reps") ? Number(get("reps")) : null,
    timeoutSec: get("timeout") ? Number(get("timeout")) : 900,
    runTimeoutSec: get("run-timeout") ? Number(get("run-timeout")) : 180,
    out: get("out"),
    tamper: argv.includes("--tamper"),
  };
}

/** Spawn one worker; resolve to its row (or a synthesized failure row). */
function runWorker(bench, lane, opts, reps) {
  const script = JS2_LANES.has(lane) ? "worker-js2.mjs" : `worker-${lane}.mjs`;
  const nodeArgs = JS2_LANES.has(lane) ? ["--max-old-space-size=8192", "--import", "tsx"] : [];
  const workerArgs = ["--bench", bench, "--lane", lane, "--reps", reps == null ? "auto" : String(reps)];
  if (opts.tamper) workerArgs.push("--tamper");
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, join(HERE, script), ...workerArgs], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = null;
    let ready = null;
    const arm = (sec, phase) =>
      setTimeout(() => {
        timedOut = `timeout after ${sec}s (${phase})`;
        child.kill("SIGKILL");
      }, sec * 1000);
    let timer = arm(opts.timeoutSec, "compile/instantiate");
    child.stdout.on("data", (d) => {
      stdout += d;
      if (ready) return;
      const line = stdout.split("\n").find((l) => l.startsWith(READY_MARKER));
      if (!line) return;
      ready = JSON.parse(line.slice(READY_MARKER.length));
      clearTimeout(timer);
      timer = arm(opts.runTimeoutSec, `run, reps ${reps ?? "auto"}`);
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const wallMs = Date.now() - t0;
      const line = stdout.split("\n").find((l) => l.startsWith(ROW_MARKER));
      if (line) return resolve({ ...JSON.parse(line.slice(ROW_MARKER.length)), wallMs });
      if (timedOut) {
        return resolve({ bench, lane, status: "skipped", reason: timedOut, ...(ready ?? {}), reps, wallMs });
      }
      const tail = stderr.trim().split("\n").slice(-4).join(" | ");
      resolve({
        bench,
        lane,
        status: "runtime-error",
        phase: "worker-crash",
        error: `worker exited (code ${code}, signal ${signal}) without a result row: ${tail}`,
        wallMs,
      });
    });
  });
}

function machineInfo() {
  return {
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    memMB: Math.round(os.totalmem() / 2 ** 20),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    uptimeSec: Math.round(os.uptime()),
    loadavg: os.loadavg().map((l) => Number(l.toFixed(2))),
    caveat:
      "absolute µs are machine- and instance-specific; low uptime = fresh instance (see benchmarks/cross-engine/README.md restart trap) and a high loadavg = other work on the box; compare ratios within one run only",
  };
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

const isPass = (r) => r?.status === "pass" || r?.status === "pass-unvalidated";

function cell(row, nodeRow) {
  if (!row) return "-";
  if (!isPass(row)) return row.status;
  const ratio = nodeRow && isPass(nodeRow) ? ` (${(nodeRow.minUsPerRun / row.minUsPerRun).toFixed(2)}x)` : "";
  return `${row.octaneScore}${row.status === "pass-unvalidated" ? "*" : ""}${ratio}`;
}

function printTable(report, benches, lanes) {
  const widths = [14, ...lanes.map(() => 20)];
  const fmt = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join(" ");
  console.log(`\n${fmt(["bench", ...lanes])}`);
  for (const bench of benches) {
    const nodeRow = report.rows.find((r) => r.bench === bench && r.lane === "node");
    console.log(
      fmt([
        bench,
        ...lanes.map((l) =>
          cell(
            report.rows.find((r) => r.bench === bench && r.lane === l),
            nodeRow,
          ),
        ),
      ]),
    );
  }
  for (const ex of report.excluded) console.log(fmt([ex.bench, ...lanes.map(() => "skipped")]) + `  (${ex.reason})`);
  console.log("cells: Octane score (node min-µs ÷ lane min-µs) or status; * = pass-unvalidated (no Octane check)");
  for (const g of report.geomean) console.log(`geomean ${g.lane}: ${g.score} over [${g.benches.join(", ")}]`);
}

/** Geomean of scores only over benches that pass on EVERY lane that passes anything. */
function geomeans(rows, benches, lanes) {
  const passingLanes = lanes.filter((l) => rows.some((r) => r.lane === l && isPass(r)));
  const common = benches.filter((b) =>
    passingLanes.every((l) => isPass(rows.find((r) => r.bench === b && r.lane === l))),
  );
  if (!common.length) return [];
  return passingLanes.map((lane) => {
    const scores = common.map((b) => rows.find((r) => r.bench === b && r.lane === lane).octaneScore);
    const score = Math.round(Math.exp(scores.reduce((a, s) => a + Math.log(s), 0) / scores.length));
    return { lane, score, benches: common };
  });
}

const opts = parseArgs(process.argv.slice(2));
const unknownLanes = opts.lanes.filter((l) => !ALL_LANES.includes(l));
if (unknownLanes.length)
  throw new Error(`unknown lane(s): ${unknownLanes.join(", ")} (known: ${ALL_LANES.join(", ")})`);
const benches = Object.keys(MANIFEST.benchmarks).filter((b) => !opts.only || opts.only.includes(b));
if (opts.only) {
  const unknown = opts.only.filter((b) => !MANIFEST.benchmarks[b]);
  if (unknown.length) throw new Error(`unknown bench(es): ${unknown.join(", ")}`);
}

const { bad } = await ensureOctaneSources();
if (bad.length) throw new Error(`Octane sources failed to fetch/verify: ${bad.join(", ")}`);

const porfforDir = process.env.PORFFOR_DIR ?? "/home/user/porffor";
const porfforAvailable = existsSync(join(porfforDir, "porf"));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));

const rows = [];
for (const bench of benches) {
  let reps = opts.reps;
  for (const lane of opts.lanes) {
    let row;
    if (opts.tamper && !MANIFEST.benchmarks[bench].tamper) {
      row = { bench, lane, status: "skipped", reason: "no tamper snippet for this bench (--tamper)" };
    } else {
      process.stderr.write(`[octane] ${bench} / ${lane} (reps ${reps ?? "auto"}) ... `);
      row = await runWorker(bench, lane, opts, reps);
      process.stderr.write(`${row.status}${row.error ? ` — ${String(row.error).slice(0, 120)}` : ""}\n`);
    }
    // The node row fixes the reps every other lane runs (identical work).
    if (lane === "node" && reps == null && isPass(row)) reps = row.reps;
    rows.push(row);
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  js2Commit: git(["rev-parse", "HEAD"]),
  js2Dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
  octaneCommit: MANIFEST.commit,
  partial: Boolean(opts.only) || opts.lanes.length !== ALL_LANES.length,
  tamper: opts.tamper,
  machine: machineInfo(),
  lanes: {
    node: { engine: `node ${process.version}`, how: "driver as a plain script in a fresh node process" },
    gc: { js2: pkg.version, options: "compile(src, { allowJs, skipSemanticDiagnostics, validate:false })" },
    standalone: { js2: pkg.version, options: "+ target: standalone (zero imports asserted)" },
    linear: { js2: pkg.version, options: "+ target: linear" },
    porffor: porfforAvailable
      ? { available: true, dir: porfforDir }
      : { available: false, reason: `porffor not installed (no ${join(porfforDir, "porf")})` },
  },
  methodology: {
    reps: opts.reps
      ? `fixed --reps ${opts.reps}`
      : "node-calibrated (one octane_run(reps) call ≥ 50 ms), same reps on every lane",
    warmup: "calibration calls (node) or one validated octane_run(reps) call; Setup once, TearDown once at the end",
    samples: SAMPLES,
    score: "Octane v9: reference[0] / meanUsPerRun × 100 (base.js NotifyResult/FormatScore)",
    ratio: "node.minUsPerRun / lane.minUsPerRun (min-of-N, as benchmarks/cross-engine)",
    deviationsFromOctane: [
      "fixed reps instead of Octane's ≥ 1 s measurement window",
      "N=5 timed calls instead of one window",
      "multi-benchmark suites (crypto, earley-boyer) score from the arithmetic mean µs over both parts, Octane uses the geomean",
      "latency sub-scores (splay) not measured",
      "js2 lanes are timed from the host around the exported call",
    ],
    timeoutSec: opts.timeoutSec,
    runTimeoutSec: opts.runTimeoutSec,
  },
  rows,
  excluded: MANIFEST.excluded,
};
report.geomean = geomeans(rows, benches, opts.lanes);

const resultsDir = join(REPO_ROOT, "benchmarks", "results");
mkdirSync(resultsDir, { recursive: true });
const stamp = report.generatedAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const base = opts.tamper ? "octane-tamper" : "octane";
const outPath = opts.out ?? join(resultsDir, `${base}-latest.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
if (!opts.out) writeFileSync(join(resultsDir, `${base}-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
printTable(report, benches, opts.lanes);
console.log(`\nwrote ${outPath}`);
