// The IR standalone test262 measurements the site publishes (#7551, #7616).
//
// test262-sharded.yml's "merge complete IR standalone measurement" job uploads one of two artifacts:
//   test262-ir-standalone-measurement          the FULL corpus (the daily schedule, a full_run dispatch)
//   test262-ir-standalone-edition-measurement  the CURRENT edition only (every merge-queue group, and a
//                                              direct push the queue did not measure)
// Only a measurement of a commit on main's first-parent line counts: a queue group that failed or was
// cancelled never lands there. The newest full measurement supplies every published file and every
// edition row, so no figure the pages sum or scale mixes two commits. An edition measurement of a
// LATER commit is published beside them as the envelope's `currentEdition`, with its own commit and
// date. The edition history keeps, per kind, the newest measurement of each day.
//
// Usage (deploy-pages.yml, in a full-history checkout of the deployed main commit):
//   node scripts/test262-ir-site-measurements.mjs
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ghWithRetry } from "./lib/gh-api-retry.mjs";
import { editionBucket } from "./lib/test262-edition-bucket.mjs";

export const IR_ARTIFACTS = {
  full: "test262-ir-standalone-measurement",
  edition: "test262-ir-standalone-edition-measurement",
};
const PRODUCER_JOB = "merge complete IR standalone measurement";
const RESULTS = "benchmarks/results";

/** @param {string[]} args */
const gitOutput = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Main's first-parent commits, newest first, by position: the commits a measurement may come from. */
function mainLine(git) {
  return new Map(
    git(["rev-list", "--first-parent", "HEAD"])
      .trim()
      .split("\n")
      .map((sha, position) => [sha, position]),
  );
}

function listAll(api, path, field) {
  const items = [];
  for (let page = 1; ; page++) {
    const response = api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...response[field]);
    if (response[field].length < 100) return items;
  }
}

/** The completed Test262 Sharded run of this repository whose one IR producer job succeeded, or undefined. */
function producingRun(api, repository, runId) {
  const execution = api(`repos/${repository}/actions/runs/${runId}`);
  if (
    execution.name !== "Test262 Sharded" ||
    execution.status !== "completed" ||
    execution.head_repository?.full_name !== repository
  )
    return undefined;
  const producers = listAll(api, `repos/${repository}/actions/runs/${execution.id}/jobs`, "jobs").filter(
    (job) => job.name === PRODUCER_JOB,
  );
  if (producers.length !== 1 || producers[0].status !== "completed" || producers[0].conclusion !== "success")
    return undefined;
  return execution;
}

/**
 * Whether the run's commit carries this script, and with it the scope.json that names compilerPath:
 * edition artifacts of earlier commits cannot be valid, so they are not even downloaded.
 */
function carriesThisPublisher({ git }, sha) {
  try {
    git(["cat-file", "-e", `${sha}:${relative(process.cwd(), fileURLToPath(import.meta.url))}`]);
    return true;
  } catch {
    return false;
  }
}

const json = (fs, path) => JSON.parse(fs.readFileSync(path, "utf8"));
// Edition files are optional (older measurements predate them): absent means unmeasured.
const optional = (fs, path) => {
  try {
    return json(fs, path);
  } catch {
    return undefined;
  }
};

/** A full measurement read back and checked against the run that produced it; a string says why not. */
function readFull({ fs }, directory, execution) {
  const report = json(fs, `${directory}/test262-standalone-ir-report.json`);
  if (
    report.compilerPath !== "ir" ||
    report.requestedCompilerPath !== "ir" ||
    report.mode?.target !== "standalone" ||
    !["measured", "unavailable"].includes(report.measurementState) ||
    (report.measurementState === "measured" && report.attemptedCases <= 0) ||
    report.baseline_sha !== execution.head_sha
  )
    return "IR artifact does not match its actual source run";
  const status = json(fs, `${directory}/test262-standalone-ir-status.json`);
  if (
    status.compilerPath !== "ir" ||
    status.requestedCompilerPath !== "ir" ||
    status.mode?.target !== "standalone" ||
    status.state !== report.measurementState ||
    status.baseline_sha !== report.baseline_sha ||
    (status.state === "unavailable" && (typeof status.reason !== "string" || !status.reason))
  )
    return "IR status contradicts its actual requested result";
  const { categories, ...metadata } = report;
  const row = { ...metadata, runId: String(execution.id), sourceSha: execution.head_sha };
  const history =
    report.measurementState === "measured"
      ? optional(fs, `${directory}/ir/runs/standalone-editions-index.json`)
      : undefined;
  if (
    history &&
    (history.compilerPath !== "ir" || history.baseline_sha !== report.baseline_sha || !Array.isArray(history.runs))
  )
    return "IR edition history does not match its actual source run";
  const snapshots = (history?.runs ?? []).map((snapshot) => ({
    ...snapshot,
    runId: row.runId,
    sourceSha: row.sourceSha,
  }));
  return { directory, report, status, row, snapshots };
}

/**
 * An edition measurement read back and checked against the run that produced it and against the
 * edition configured at that commit; a string says why not. Its row is counted from its own result
 * rows exactly as generate-editions counts the full run's (host-free), without the feature breakdown
 * the edition run does not compute.
 */
function readEdition({ fs, git }, directory, execution, artifact) {
  const sha = execution.head_sha;
  const scope = json(fs, `${directory}/scope.json`);
  if (
    scope.compilerPath !== "ir" ||
    scope.target !== "standalone" ||
    scope.scope !== "edition" ||
    scope.sourceSha !== sha ||
    scope.edition !== JSON.parse(git(["show", `${sha}:scripts/test262-current-edition.json`])).edition
  )
    return "IR edition artifact does not match its actual source run";
  const report = json(fs, `${directory}/edition-report.json`);
  if (report.sourceSha !== sha || report.edition !== scope.edition)
    return "IR edition report does not match its actual source run";
  const records = new Map();
  for (const line of fs.readFileSync(`${directory}/results.jsonl`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    records.set(record.file, record);
  }
  const counts = { pass: 0, fail: 0, ce: 0, skip: 0 };
  for (const record of records.values()) counts[editionBucket(record, true)]++;
  const total = counts.pass + counts.fail + counts.ce + counts.skip;
  if (total <= 0 || total !== report.counts?.total) return "IR edition results contradict their edition report";
  const provenance = { sourceSha: sha, measuredAt: artifact.created_at, runId: String(execution.id) };
  return {
    row: { edition: scope.edition, ...counts, total, pct: Math.round((counts.pass / total) * 100), ...provenance },
    snapshot: {
      timestamp: artifact.created_at,
      gitHash: sha.slice(0, 8),
      scope: "edition",
      edition: scope.edition,
      editions: [{ edition: scope.edition, pass: counts.pass, total }],
      ...provenance,
    },
  };
}

/**
 * The two artifact kinds. A full measurement that cannot be read or contradicts its source run fails
 * the deploy, as before #7616. An edition one is optional: it is skipped with a warning.
 */
const KINDS = {
  full: {
    name: IR_ARTIFACTS.full,
    admits: () => true,
    read: readFull,
    reject: (_context, reason) => {
      throw new Error(reason);
    },
  },
  edition: {
    name: IR_ARTIFACTS.edition,
    admits: carriesThisPublisher,
    read: readEdition,
    reject: (context, reason) => context.warn(reason),
  },
};

/** The newest valid measurement of each day of one kind, newest commit first. */
function dailyMeasurements(context, kind) {
  const { api, gh, fs, repository, line } = context;
  const artifacts = listAll(api, `repos/${repository}/actions/artifacts?name=${kind.name}`, "artifacts")
    .filter((artifact) => !artifact.expired && line.has(artifact.workflow_run?.head_sha))
    .filter((artifact) => kind.admits(context, artifact.workflow_run.head_sha))
    .sort((a, b) => line.get(a.workflow_run.head_sha) - line.get(b.workflow_run.head_sha) || b.id - a.id);
  const days = new Set();
  const measurements = [];
  for (const artifact of artifacts) {
    const day = artifact.created_at?.slice(0, 10) ?? artifact.id;
    if (days.has(day)) continue;
    const execution = producingRun(api, repository, artifact.workflow_run.id);
    if (!execution) continue;
    const directory = `.ir-measurement-download/${artifact.id}`;
    let measurement;
    try {
      fs.mkdirSync(directory, { recursive: true });
      gh(["run", "download", String(execution.id), "--repo", repository, "--name", kind.name, "--dir", directory]);
      measurement = kind.read(context, directory, execution, artifact);
    } catch (error) {
      measurement = error.message;
    }
    if (typeof measurement === "string") {
      kind.reject(context, `${measurement} (artifact ${artifact.id}, run ${execution.id})`);
      continue;
    }
    days.add(day);
    measurements.push({ ...measurement, position: line.get(execution.head_sha) });
  }
  return measurements;
}

const unavailableStatus = {
  schema: "test262-compiler-path-status-v1",
  compilerPath: "ir",
  requestedCompilerPath: "ir",
  compilerPathVerified: false,
  executionCompilerPath: "unknown",
  measurementState: "unavailable",
  state: "unavailable",
  mode: { target: "standalone" },
  reason: "No retained completed IR standalone measurement is available.",
};

export function publishIrMeasurements({
  repository,
  gh = ghWithRetry,
  git = gitOutput,
  fs = nodeFs,
  warn = (message) => console.log(`::warning::${message}`),
}) {
  const api = (path) => JSON.parse(gh(["api", path]));
  const context = { api, gh, git, fs, warn, repository, line: mainLine(git) };
  const full = dailyMeasurements(context, KINDS.full);
  const editions = dailyMeasurements(context, KINDS.edition);
  const write = (path, data) => fs.writeFileSync(`${RESULTS}/${path}`, JSON.stringify(data));
  fs.mkdirSync(`${RESULTS}/ir/runs`, { recursive: true });
  const latest = full[0];
  if (!latest) {
    // Artifact retention is finite: never substitute legacy numbers or a stale IR score.
    fs.rmSync(`${RESULTS}/test262-standalone-ir-report.json`, { force: true });
    write("test262-standalone-ir-status.json", unavailableStatus);
    return;
  }
  write("test262-standalone-ir-status.json", latest.status);
  if (latest.report.measurementState !== "measured") {
    fs.rmSync(`${RESULTS}/test262-standalone-ir-report.json`, { force: true });
    return;
  }
  const measured = full.filter((measurement) => measurement.report.measurementState === "measured");
  write("test262-standalone-ir-report.json", latest.report);
  write("ir/test262-standalone-categories.json", json(fs, `${latest.directory}/ir/test262-standalone-categories.json`));
  write("ir/runs/standalone-index.json", { ...latest.row, runs: measured.map((measurement) => measurement.row) });
  // Only an edition measurement of a later commit than the full run's is newer news.
  const currentEdition = editions[0]?.position < latest.position ? editions[0].row : undefined;
  for (const [file, field] of [
    ["test262-standalone-editions.json", "editions"],
    ["test262-category-editions.json", "data"],
    ["test262-file-editions.json", "data"],
  ]) {
    const edition = optional(fs, `${latest.directory}/ir/${file}`);
    if (!edition) continue;
    if (
      edition.compilerPath !== "ir" ||
      edition.baseline_sha !== latest.report.baseline_sha ||
      edition.mode?.target !== "standalone" ||
      edition[field] === undefined
    )
      throw new Error("IR edition artifact does not match its actual source run");
    write(`ir/${file}`, field === "editions" && currentEdition ? { ...edition, currentEdition } : edition);
  }
  const history = [...measured.flatMap((measurement) => measurement.snapshots), ...editions.map((m) => m.snapshot)];
  if (history.length > 0) write("ir/runs/standalone-editions-index.json", { ...latest.row, runs: history });
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) publishIrMeasurements({ repository: process.env.GITHUB_REPOSITORY });
