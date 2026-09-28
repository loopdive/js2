#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5393: bounded, isolated observational audit. Refusals and unknowns never count as matches.
import { fork, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatWithOptions } from "node:util";

export const LANES = ["host", "host-O", "standalone", "standalone-O"];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = resolve(ROOT, "scripts/audit-javascript-soundness-probe.ts");
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** The same real Node console formatting is used by both executable JS lanes. */
export function formatConsoleArguments(values) {
  return formatWithOptions({ colors: false }, ...values) + "\n";
}

/** Compare only completed observations. No whitespace or value normalization. */
export function classifyObservation(reference, observed) {
  const inconclusive = new Set(["timeout", "inconclusive", "observation_error", "worker_error"]);
  if (inconclusive.has(reference.status) || !["normal", "abrupt"].includes(reference.status))
    return "oracle_inconclusive";
  if (inconclusive.has(observed.status)) return "inconclusive";
  if (observed.status === "compiler_exception") return "compiler_exception";
  if (observed.status === "compile_error") return "diagnostic_refusal";
  if (observed.status === "invalid_wasm" || observed.status === "link_error") return observed.status;
  if (!["normal", "abrupt"].includes(observed.status)) return "inconclusive";
  if ([reference.stdout, reference.stderr, observed.stdout, observed.stderr].some((text) => typeof text !== "string"))
    return "inconclusive";
  if (observed.status !== reference.status) return "completion_mismatch";
  if (observed.stdout !== reference.stdout || observed.stderr !== reference.stderr) return "output_mismatch";
  if (reference.status === "abrupt") {
    if (!reference.thrown?.comparable || !observed.thrown?.comparable) return "inconclusive";
    if (JSON.stringify(reference.thrown.identity) !== JSON.stringify(observed.thrown.identity))
      return "exception_mismatch";
  }
  return "match";
}

export function loadManifest(path, filter = "") {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.cases))
    throw new Error("Expected version 1 manifest with cases");
  if (
    !Number.isInteger(manifest.expectedCount) ||
    manifest.expectedCount < 1 ||
    manifest.cases.length !== manifest.expectedCount
  ) {
    throw new Error(`Inventory mismatch: expectedCount=${manifest.expectedCount}, actual=${manifest.cases.length}`);
  }
  const seen = new Set();
  const sourceRoot = resolve(dirname(path), manifest.sourceRoot ?? ".");
  const cases = manifest.cases
    .map((entry) => {
      if (!entry.id || !entry.category || seen.has(entry.id))
        throw new Error(`Invalid or duplicate case id: ${entry.id}`);
      seen.add(entry.id);
      if (
        [entry.source !== undefined, entry.sourcePath !== undefined, entry.files !== undefined].filter(Boolean)
          .length !== 1
      ) {
        throw new Error(`${entry.id}: provide exactly one of source, sourcePath, or files`);
      }
      const source =
        entry.sourcePath !== undefined ? readFileSync(resolve(sourceRoot, entry.sourcePath), "utf8") : entry.source;
      if (entry.files && (!entry.entry || typeof entry.files[entry.entry] !== "string"))
        throw new Error(`${entry.id}: missing module entry source`);
      if (!entry.files && typeof source !== "string") throw new Error(`${entry.id}: source must be text`);
      if (entry.files && Object.values(entry.files).some((value) => typeof value !== "string"))
        throw new Error(`${entry.id}: files must contain source text`);
      if (
        entry.completionMarker !== undefined &&
        (typeof entry.completionMarker !== "string" || !entry.completionMarker || entry.completionMarker.includes("\n"))
      ) {
        throw new Error(`${entry.id}: completionMarker must be one nonempty console line`);
      }
      const files = entry.files
        ? Object.fromEntries(Object.entries(entry.files).sort(([a], [b]) => a.localeCompare(b)))
        : undefined;
      return { ...entry, source, files, sourceHash: hash(JSON.stringify(files ?? source)) };
    })
    .filter((entry) => !filter || `${entry.id} ${entry.category}`.includes(filter));
  if (!cases.length) throw new Error("Audit selected zero cases");
  return { manifest, cases };
}

function sourceState() {
  const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const paths = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "src",
    "scripts/audit-javascript-soundness.mjs",
    "scripts/audit-javascript-soundness-probe.ts",
  ])
    .split("\n")
    .filter(Boolean);
  // Include these files before their first commit too.
  const inputs = [
    ...new Set([...paths, "scripts/audit-javascript-soundness.mjs", "scripts/audit-javascript-soundness-probe.ts"]),
  ].sort();
  const stateHash = createHash("sha256");
  for (const path of inputs)
    stateHash
      .update(path)
      .update("\0")
      .update(readFileSync(resolve(ROOT, path)))
      .update("\0");
  return {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]),
    dirty: git(["status", "--porcelain"]),
    sourceStateHash: stateHash.digest("hex"),
  };
}

function engineArgs() {
  const flags = execFileSync(process.execPath, ["--v8-options"], { encoding: "utf8" });
  return [
    "--experimental-vm-modules",
    ...["--experimental-wasm-exnref", "--experimental-wasm-stringref", "--experimental-wasm-custom-descriptors"].filter(
      (flag) => flags.includes(flag),
    ),
    "--import",
    "tsx",
  ];
}

function runProbe(specimen, lane, config) {
  return new Promise((done) => {
    const child = fork(PROBE, [], {
      cwd: ROOT,
      execArgv: config.execArgv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let workerStdout = "",
      workerStderr = "",
      result,
      partial,
      settled = false;
    const finish = (fallback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ...(result ?? fallback), workerStdout, workerStderr });
    };
    const capture = (channel, chunk) => {
      if (channel === "stdout") workerStdout += chunk;
      else workerStderr += chunk;
      if (workerStdout.length + workerStderr.length > 2_000_000) {
        result = { status: "observation_error", reason: "Worker output exceeded 2 MB", stdout: "", stderr: "" };
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("message", (message) => {
      if (message?.type === "observation") result = message.observation;
      if (message?.type === "partial") partial = message.observation;
    });
    child.on("error", (error) => finish({ status: "worker_error", reason: String(error), stdout: "", stderr: "" }));
    child.on("exit", (code, signal) =>
      finish({
        status: "worker_error",
        reason: `Worker exited without observation (${code}, ${signal})`,
        stdout: "",
        stderr: "",
      }),
    );
    const timer = setTimeout(() => {
      result = {
        status: "timeout",
        reason: `Exceeded ${config.timeoutMs} ms`,
        stdout: partial?.stdout ?? null,
        stderr: partial?.stderr ?? null,
        outputComplete: false,
      };
      child.kill("SIGKILL");
    }, config.timeoutMs);
    child.send({ specimen, lane, timeoutMs: config.timeoutMs, maxOutput: 1_000_000 });
  });
}

export async function runAudit(config) {
  const { manifest, cases } = loadManifest(config.manifest, config.filter);
  const lanes = config.lanes ?? LANES;
  if (!lanes.length || new Set(lanes).size !== lanes.length || lanes.some((lane) => !LANES.includes(lane)))
    throw new Error("Invalid lane selection");
  const concurrency = config.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error("Concurrency must be 1..16");
  const timeoutMs = config.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000)
    throw new Error("Timeout must be 100..600000 ms");
  const execArgv = engineArgs();
  const before = sourceState();
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    execArgv,
    sourceState: before,
    manifestHash: hash(readFileSync(config.manifest)),
    inventoryCount: manifest.expectedCount,
    selectedCount: cases.length,
    expectedObservations: cases.length * (lanes.length + 1),
    lanes,
    concurrency,
    timeoutMs,
    observations: [],
    comparisons: [],
  };
  mkdirSync(dirname(config.out), { recursive: true });
  const tasks = cases.flatMap((specimen) => ["node", ...lanes].map((lane) => ({ specimen, lane })));
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const { specimen, lane } = tasks[cursor++];
      const observation = await runProbe(specimen, lane, { timeoutMs, execArgv });
      report.observations.push({
        id: specimen.id,
        category: specimen.category,
        sourceHash: specimen.sourceHash,
        lane,
        ...observation,
      });
      writeFileSync(config.out, JSON.stringify(report, null, 2) + "\n");
      process.stderr.write(
        `${report.observations.length}/${report.expectedObservations} ${specimen.id} ${lane}: ${observation.status}\n`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const after = sourceState();
  report.sourceStateStable = before.sourceStateHash === after.sourceStateHash && before.commit === after.commit;
  report.finalSourceState = after;
  for (const specimen of cases) {
    const expected = report.observations.find((row) => row.id === specimen.id && row.lane === "node");
    for (const lane of lanes) {
      const observed = report.observations.find((row) => row.id === specimen.id && row.lane === lane);
      report.comparisons.push({
        id: specimen.id,
        category: specimen.category,
        lane,
        verdict: report.sourceStateStable ? classifyObservation(expected, observed) : "inconclusive_source_changed",
      });
    }
  }
  report.counts = {};
  for (const row of report.comparisons) report.counts[row.verdict] = (report.counts[row.verdict] ?? 0) + 1;
  report.complete = report.observations.length === report.expectedObservations;
  writeFileSync(config.out, JSON.stringify(report, null, 2) + "\n");
  return report;
}

async function main() {
  const values = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    if (
      !["--manifest", "--out", "--lanes", "--concurrency", "--timeout-ms", "--filter"].includes(name) ||
      process.argv[i + 1] === undefined
    )
      throw new Error(`Invalid argument ${name}`);
    values.set(name, process.argv[i + 1]);
  }
  if (!values.has("--manifest") || !values.has("--out"))
    throw new Error(
      "Usage: node scripts/audit-javascript-soundness.mjs --manifest FILE --out FILE [--lanes host,standalone] [--concurrency 2] [--timeout-ms 30000] [--filter TEXT]",
    );
  const report = await runAudit({
    manifest: resolve(values.get("--manifest")),
    out: resolve(values.get("--out")),
    lanes: values.get("--lanes")?.split(","),
    concurrency: Number(values.get("--concurrency") ?? 2),
    timeoutMs: Number(values.get("--timeout-ms") ?? 30000),
    filter: values.get("--filter") ?? "",
  });
  process.stdout.write(JSON.stringify({ complete: report.complete, counts: report.counts }) + "\n");
  process.exitCode =
    report.complete && report.sourceStateStable && report.comparisons.every((row) => row.verdict === "match") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  });
}
