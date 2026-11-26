#!/usr/bin/env node --experimental-strip-types
/**
 * #7551 — the per-merge test262 scope: the CURRENT ES edition, on the IR path.
 *
 * The full corpus is measured daily. Every merge measures only the edition
 * being worked on (`scripts/test262-current-edition.json`) and compares it,
 * test by test, with the nearest earlier IR measurement on the same lineage.
 * A test of the edition that passed there and does not pass now is a
 * regression on the goal metric, and fails the report.
 *
 * Editions are classified by `classifyTest262File`, the edition ratchet's own
 * classifier, so "ES5" means the same set of files in both places.
 *
 *   paths   --test262 <root> --out <file>          write the edition's file list
 *   fetch-baseline --from <sha> --dest <dir>         download the nearest earlier measurement
 *   report  --results <jsonl> --meta <scope.json> --test262 <root>
 *           [--baseline-dir <dir>] --summary <md> --json <out>
 *
 * Exit codes: 0 ok (including "no baseline") · 1 regression · 2 usage / bad input.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyTest262File, editionStringToYear } from "./generate-editions.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_EDITION_CONFIG = join(ROOT, "scripts", "test262-current-edition.json");

/** Artifact names of the two IR measurement scopes; consumers tell them apart by name. */
const EDITION_ARTIFACT = "test262-ir-standalone-edition-measurement";
const FULL_ARTIFACT = "test262-ir-standalone-measurement";
/** First-parent commits searched for an earlier measurement before reporting "no baseline". */
const MAX_BASELINE_DISTANCE = 25;

export interface CurrentEdition {
  edition: string;
  year: number;
  chunks: number;
}

export function readCurrentEdition(path = CURRENT_EDITION_CONFIG): CurrentEdition {
  const { edition, chunks } = JSON.parse(readFileSync(path, "utf-8"));
  const year = typeof edition === "string" ? editionStringToYear(edition) : undefined;
  // Only a published edition is a measurable scope; the sentinels are residues.
  if (year === undefined || year < 5) throw new Error(`${path}: "${edition}" is not an ES edition`);
  if (!Number.isInteger(chunks) || chunks < 1) throw new Error(`${path}: chunks must be a positive integer`);
  return { edition, year, chunks };
}

/**
 * Every test file of `year`, as `test/...` paths: the key the runner's
 * TEST262_PATH_FILTER_FILE matches and every result row carries. The walk uses
 * the runner's discovery rule (tests/test262-runner.ts `findTestFiles`).
 */
export function editionPaths(test262Root: string, year: number): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(test262Root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (isTestFile(entry.name) && classifyTest262File(test262Root, child) === year) out.push(child);
    }
  };
  walk("test");
  return out.sort();
}

function isTestFile(name: string): boolean {
  return name.endsWith(".js") && !name.includes("_FIXTURE") && !name.endsWith(".imports.js");
}

/** What a measurement artifact says about itself (`scope.json`). */
export interface ScopeMeta {
  scope: "edition" | "full";
  edition?: string;
  sourceSha: string;
  test262Sha: string;
  evalEngine: string;
}

/** Why a measurement cannot serve as this run's baseline, or null when it can. */
function baselineMismatch(baseline: ScopeMeta, current: ScopeMeta): string | null {
  if (baseline.evalEngine !== current.evalEngine)
    return `it ran under eval engine ${baseline.evalEngine}, this run under ${current.evalEngine}`;
  if (baseline.scope === "edition" && baseline.edition !== current.edition)
    return `it measured ${baseline.edition}, this run measures ${current.edition}`;
  return null;
}

export type StatusMap = Map<string, string>;

function readStatuses(path: string): StatusMap {
  const out: StatusMap = new Map();
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (typeof row.file === "string" && typeof row.status === "string") out.set(row.file, row.status);
  }
  return out;
}

export interface Counts {
  pass: number;
  fail: number;
  compile_error: number;
  other: number;
  total: number;
}

export interface EditionDiff {
  /** pass -> not-pass, the gated set. */
  regressions: { file: string; now: string }[];
  /** pass -> compile_timeout: runner-load flake (#1192), listed but not gated. */
  timeouts: string[];
  improvements: string[];
  /** In the edition now, absent from the baseline (new test262 files, or a baseline that never ran them). */
  unbaselined: number;
}

function countStatuses(run: StatusMap, paths: ReadonlySet<string>): Counts {
  const c: Counts = { pass: 0, fail: 0, compile_error: 0, other: 0, total: 0 };
  for (const [file, status] of run) {
    if (!paths.has(file)) continue;
    c.total++;
    if (status === "pass" || status === "fail" || status === "compile_error") c[status]++;
    else c.other++;
  }
  return c;
}

/** Per-test diff restricted to the edition, so a full-corpus baseline serves as well as an edition one. */
export function compareEditionRuns(run: StatusMap, baseline: StatusMap, paths: ReadonlySet<string>): EditionDiff {
  const diff: EditionDiff = { regressions: [], timeouts: [], improvements: [], unbaselined: 0 };
  for (const [file, now] of run) {
    if (!paths.has(file)) continue;
    const was = baseline.get(file);
    if (was === undefined) diff.unbaselined++;
    else if (was === "pass" && now === "compile_timeout") diff.timeouts.push(file);
    else if (was === "pass" && now !== "pass") diff.regressions.push({ file, now });
    else if (was !== "pass" && now === "pass") diff.improvements.push(file);
  }
  return diff;
}

export interface ArtifactRef {
  id: number;
  name: string;
  runId: number;
  sha: string;
  createdAt: string;
}

/**
 * The measurement nearest to the start of `lineage` (first-parent order, newest
 * first). Within one commit the newest artifact wins, so a re-run supersedes.
 */
export function nearestBaseline(
  lineage: readonly string[],
  artifacts: readonly ArtifactRef[],
): { artifact: ArtifactRef; distance: number } | null {
  for (const [distance, sha] of lineage.entries()) {
    const atSha = artifacts.filter((a) => a.sha === sha).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (atSha.length > 0) return { artifact: atSha[0]!, distance };
  }
  return null;
}

export interface Report {
  edition: string;
  sourceSha: string;
  counts: Counts;
  baseline: { sha: string; runId?: number; distance?: number; test262Sha: string } | null;
  /** Set exactly when `baseline` is null: why nothing was compared. */
  noBaselineReason?: string;
  diff?: EditionDiff;
}

const LIST_LIMIT = 200;

export function renderSummary(r: Report): string {
  const c = r.counts;
  const lines = [
    `## test262 on the IR path — ${r.edition} (current edition, #7551)`,
    "",
    `Commit \`${r.sourceSha}\`. This is the edition only, not the full corpus (that runs daily).`,
    "",
    "| pass | fail | compile_error | other | total |",
    "|---:|---:|---:|---:|---:|",
    `| ${c.pass} | ${c.fail} | ${c.compile_error} | ${c.other} | ${c.total} |`,
    "",
  ];
  if (!r.baseline || !r.diff) {
    lines.push(`**No baseline — not compared.** ${r.noBaselineReason}`, "");
    lines.push("Regressions cannot be ruled out for this run; the next run compares against this one.");
    return lines.join("\n") + "\n";
  }
  const b = r.baseline;
  const distance = b.distance === undefined ? "" : `, ${b.distance} first-parent commit(s) back`;
  lines.push(`Compared with the IR measurement of \`${b.sha}\`${b.runId ? ` (run ${b.runId})` : ""}${distance}.`);
  if (b.test262Sha !== "" && b.test262Sha !== "unknown") lines.push(`Baseline test262 revision: \`${b.test262Sha}\`.`);
  lines.push("");
  const d = r.diff;
  const list = (title: string, items: string[]) => {
    lines.push(`### ${title}: ${items.length}`, "");
    for (const item of items.slice(0, LIST_LIMIT)) lines.push(`- ${item}`);
    if (items.length > LIST_LIMIT) lines.push(`- … and ${items.length - LIST_LIMIT} more (see the JSON report)`);
    lines.push("");
  };
  const code = (file: string) => `\`${file}\``;
  list(
    "Regressions (pass → not pass)",
    d.regressions.map((x) => `${code(x.file)} → ${x.now}`),
  );
  list("Improvements (not pass → pass)", d.improvements.map(code));
  if (d.timeouts.length > 0) list("Not gated: pass → compile_timeout (runner-load flake)", d.timeouts.map(code));
  if (d.unbaselined > 0) lines.push(`${d.unbaselined} test(s) of the edition have no row in the baseline.`, "");
  return lines.join("\n") + "\n";
}

/** Build the report; the caller decides the exit code from `diff.regressions`. */
export function buildReport(opts: {
  run: StatusMap;
  meta: ScopeMeta;
  paths: ReadonlySet<string>;
  baseline?: { statuses: StatusMap; meta: ScopeMeta; runId?: number; distance?: number };
  /** Why there is no baseline, when the caller knows better than "none found". */
  noBaselineReason?: string;
}): Report {
  const base: Report = {
    edition: opts.meta.edition ?? "",
    sourceSha: opts.meta.sourceSha,
    counts: countStatuses(opts.run, opts.paths),
    baseline: null,
  };
  if (!opts.baseline) {
    return {
      ...base,
      noBaselineReason:
        opts.noBaselineReason ??
        `No earlier IR measurement was found within ${MAX_BASELINE_DISTANCE} first-parent commits.`,
    };
  }
  const mismatch = baselineMismatch(opts.baseline.meta, opts.meta);
  if (mismatch)
    return { ...base, noBaselineReason: `The nearest earlier IR measurement is not comparable: ${mismatch}.` };
  return {
    ...base,
    baseline: {
      sha: opts.baseline.meta.sourceSha,
      runId: opts.baseline.runId,
      distance: opts.baseline.distance,
      test262Sha: opts.baseline.meta.test262Sha === opts.meta.test262Sha ? "" : opts.baseline.meta.test262Sha,
    },
    diff: compareEditionRuns(opts.run, opts.baseline.statuses, opts.paths),
  };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function required(args: string[], name: string): string {
  const v = arg(args, name);
  if (!v) usage(`missing ${name}`);
  return v;
}

function usage(msg: string): never {
  console.error(`test262-edition-scope: ${msg}`);
  process.exit(2);
}

function cmdPaths(args: string[]): void {
  const { edition, year } = readCurrentEdition();
  const paths = editionPaths(required(args, "--test262"), year);
  if (paths.length === 0) usage(`no ${edition} files under ${arg(args, "--test262")} — is test262 checked out?`);
  writeFileSync(required(args, "--out"), paths.join("\n") + "\n");
  console.log(`${edition}: ${paths.length} test files`);
}

const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf-8" });

/** Both scopes' artifacts, newest first; expired ones cannot be downloaded. */
function listArtifacts(repo: string): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  for (const name of [EDITION_ARTIFACT, FULL_ARTIFACT]) {
    const page = JSON.parse(gh("api", `repos/${repo}/actions/artifacts?name=${name}&per_page=100`));
    for (const a of page.artifacts ?? []) {
      if (a.expired || !a.workflow_run?.head_sha) continue;
      out.push({ id: a.id, name, runId: a.workflow_run.id, sha: a.workflow_run.head_sha, createdAt: a.created_at });
    }
  }
  return out;
}

function cmdFetchBaseline(args: string[]): void {
  const from = required(args, "--from");
  const dest = required(args, "--dest");
  const repo = process.env.GITHUB_REPOSITORY ?? usage("GITHUB_REPOSITORY is not set");
  const lineage = execFileSync(
    "git",
    ["rev-list", "--first-parent", `--max-count=${MAX_BASELINE_DISTANCE + 1}`, from],
    { encoding: "utf-8" },
  )
    .split("\n")
    .filter(Boolean);
  const found = nearestBaseline(lineage, listArtifacts(repo));
  if (!found) {
    console.log(`no IR measurement on the ${lineage.length} first-parent commit(s) from ${from}`);
    return;
  }
  const { artifact, distance } = found;
  gh("run", "download", String(artifact.runId), "--repo", repo, "--name", artifact.name, "--dir", dest);
  writeFileSync(join(dest, "baseline-ref.json"), JSON.stringify({ ...artifact, distance }) + "\n");
  console.log(`baseline: ${artifact.name} of ${artifact.sha} (run ${artifact.runId}, distance ${distance})`);
}

function cmdReport(args: string[]): void {
  const meta: ScopeMeta = JSON.parse(readFileSync(required(args, "--meta"), "utf-8"));
  const { year } = readCurrentEdition();
  const paths = new Set(editionPaths(required(args, "--test262"), year));
  const dir = arg(args, "--baseline-dir");
  let baseline: Parameters<typeof buildReport>[0]["baseline"];
  let noBaselineReason: string | undefined;
  if (dir && existsSync(join(dir, "results.jsonl"))) {
    const ref = existsSync(join(dir, "baseline-ref.json"))
      ? JSON.parse(readFileSync(join(dir, "baseline-ref.json"), "utf-8"))
      : {};
    if (existsSync(join(dir, "scope.json"))) {
      baseline = {
        statuses: readStatuses(join(dir, "results.jsonl")),
        meta: JSON.parse(readFileSync(join(dir, "scope.json"), "utf-8")),
        runId: ref.runId,
        distance: ref.distance,
      };
    } else {
      // Measurements from before #7551 do not record their eval engine or test262 revision.
      noBaselineReason = `The nearest earlier IR measurement (${ref.sha ?? "unknown commit"}) predates scope.json, so its comparability is unknown.`;
    }
  }
  const report = buildReport({
    run: readStatuses(required(args, "--results")),
    meta,
    paths,
    baseline,
    noBaselineReason,
  });
  const summary = renderSummary(report);
  writeFileSync(required(args, "--summary"), summary);
  writeFileSync(required(args, "--json"), JSON.stringify(report, null, 2) + "\n");
  console.log(summary);
  if ((report.diff?.regressions.length ?? 0) > 0) {
    console.log(regressionAnnotation(report));
    process.exit(1);
  }
}

/** Title of the annotation auto-park copies into its park comment (scripts/auto-park-merge-group-failure.mjs). */
export const REGRESSION_ANNOTATION_TITLE = "test262 regressions (#7551)";
const ANNOTATION_LIST_LIMIT = 50;

/**
 * One error annotation naming the regressed tests. GitHub keeps at most 10
 * annotations per step, so a single one carries the whole list.
 */
export function regressionAnnotation(r: Report): string {
  const regressions = r.diff?.regressions ?? [];
  const lines = [
    `${regressions.length} ${r.edition} test(s) went pass -> not pass on the IR path (baseline ${r.baseline?.sha ?? "none"}):`,
    ...regressions.slice(0, ANNOTATION_LIST_LIMIT).map((x) => `${x.file} -> ${x.now}`),
    ...(regressions.length > ANNOTATION_LIST_LIMIT
      ? [`... and ${regressions.length - ANNOTATION_LIST_LIMIT} more (see the job summary)`]
      : []),
  ];
  const data = lines.join("\n").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::error title=${REGRESSION_ANNOTATION_TITLE}::${data}`;
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "paths") cmdPaths(args);
  else if (command === "fetch-baseline") cmdFetchBaseline(args);
  else if (command === "report") cmdReport(args);
  else usage("usage: test262-edition-scope.ts paths|fetch-baseline|report …");
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
