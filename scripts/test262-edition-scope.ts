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
 * Exit codes: 0 ok (including "no baseline") · 2 usage · 3 REGRESSION FOUND
 * (the JSON report is written first) · anything else (1 = an uncaught throw)
 * is a crash: the workflow treats it as infrastructure, never as a regression.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { findCategoryTestFiles, TEST_CATEGORIES } from "../tests/test262-categories.ts";
import { classifyTest262File, editionStringToYear } from "./generate-editions.ts";
import { ghWithRetry } from "./lib/gh-api-retry.mjs";
import { REGRESSION_ANNOTATION_TITLE } from "./lib/regression-annotation.mjs";

/** `report` exit code for "a test of the edition regressed" — distinct from a crash (1). */
export const REGRESSION_EXIT_CODE = 3;

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
 * Every test file of `year` the runner discovers, as `test/...` paths: the key
 * TEST262_PATH_FILTER_FILE matches and every result row carries. It walks the
 * runner's own categories with the runner's own file rule
 * (tests/test262-categories.ts), so the list is exactly the set a complete
 * edition run registers — the merge step validates against it.
 */
export function editionPaths(test262Root: string, year: number): string[] {
  const out = new Set<string>();
  for (const category of TEST_CATEGORIES) {
    for (const file of findCategoryTestFiles(category, test262Root)) {
      const rel = relative(test262Root, file).split("\\").join("/");
      if (classifyTest262File(test262Root, rel) === year) out.add(rel);
    }
  }
  return [...out].sort();
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

/** What a baseline-passing test that has no row in this run is reported as. */
export const MISSING_STATUS = "missing";

export interface EditionDiff {
  /**
   * pass -> not-pass, the gated set — including `compile_timeout` (owner rule:
   * pass -> not-pass is a regression; the runner already retries a timed-out
   * compile). `now` is MISSING_STATUS for a test this run did not report.
   */
  regressions: { file: string; now: string }[];
  improvements: string[];
  /** In the edition now, absent from the baseline (new test262 files, or a baseline that never ran them). */
  unbaselined: number;
  /** Passed in the baseline, absent now, and the test262 revision changed: not comparable, not gated. */
  notComparable: string[];
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

/**
 * Per-test diff restricted to the edition, so a full-corpus baseline serves as
 * well as an edition one. On the same test262 revision a baseline-passing test
 * with no row now is a regression: a run that silently drops tests must not
 * read as clean.
 */
export function compareEditionRuns(
  run: StatusMap,
  baseline: StatusMap,
  paths: ReadonlySet<string>,
  sameTest262Revision: boolean,
): EditionDiff {
  const diff: EditionDiff = { regressions: [], improvements: [], unbaselined: 0, notComparable: [] };
  for (const file of paths) {
    const now = run.get(file);
    const was = baseline.get(file);
    if (now === undefined) {
      if (was !== "pass") continue;
      if (sameTest262Revision) diff.regressions.push({ file, now: MISSING_STATUS });
      else diff.notComparable.push(file);
    } else if (was === undefined) diff.unbaselined++;
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
  baseline: {
    sha: string;
    runId?: number;
    distance?: number;
    /** Present only when the baseline ran a different test262 revision. */
    test262Changed?: { from: string; to: string };
  } | null;
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
  if (b.test262Changed)
    lines.push(`test262 revision changed: \`${b.test262Changed.from}\` → \`${b.test262Changed.to}\`.`);
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
  const timedOut = d.regressions.filter((x) => x.now === "compile_timeout").length;
  if (timedOut > 0)
    lines.push(
      `${timedOut} of the regressions are \`compile_timeout\`. They are gated (the runner already retries a ` +
        "timed-out compile, #1589), but if they are the only ones, check the shard for runner slowness before " +
        "fixing code.",
      "",
    );
  if (d.notComparable.length > 0)
    list("Not comparable (test262 revision changed): passed before, no row now", d.notComparable.map(code));
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
  const from = opts.baseline.meta.test262Sha;
  const to = opts.meta.test262Sha;
  return {
    ...base,
    baseline: {
      sha: opts.baseline.meta.sourceSha,
      runId: opts.baseline.runId,
      distance: opts.baseline.distance,
      ...(from === to ? {} : { test262Changed: { from, to } }),
    },
    diff: compareEditionRuns(opts.run, opts.baseline.statuses, opts.paths, from === to),
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

const gh = (...args: string[]): string => ghWithRetry(args);

/** Both scopes' unexpired artifacts, every page (an expired one cannot be downloaded). */
function listArtifacts(repo: string): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  for (const name of [EDITION_ARTIFACT, FULL_ARTIFACT]) {
    for (let page = 1; ; page++) {
      const { artifacts = [] } = JSON.parse(
        gh("api", `repos/${repo}/actions/artifacts?name=${name}&per_page=100&page=${page}`),
      );
      for (const a of artifacts) {
        if (a.expired || !a.workflow_run?.head_sha) continue;
        out.push({ id: a.id, name, runId: a.workflow_run.id, sha: a.workflow_run.head_sha, createdAt: a.created_at });
      }
      if (artifacts.length < 100) break;
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
    process.exit(REGRESSION_EXIT_CODE);
  }
}

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
