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
 *   paths   --test262 <root> --out <file> [--editions current|completed]   write the scope's file list
 *   fetch-baseline --from <sha> --meta <scope.json> --dest <dir>
 *           [--artifact <name>] [--wait-minutes <n>]   download the nearest COMPARABLE earlier measurement
 *   report  --results <jsonl> --meta <scope.json> --test262 <root> [--editions current|completed]
 *           [--baseline-dir <dir>] [--prs <json>] [--watch-out <json>] --summary <md> --json <out>
 *   meta    --scope edition|full [--editions current|completed] --source-sha <sha> --test262-sha <sha>
 *           --eval-engine <name> --out <scope.json>    record what a measurement is (#7537)
 *   candidates --report <json> --watched <out> --other <out>   rows the re-check runs (#7537)
 *   override --results <jsonl> [--recheck <jsonl>] [--recheck-watched <jsonl>]   re-checked rows replace shard rows (#7537)
 *
 * #7537: the same machinery serves the legacy lane's COMPLETED editions
 * (`--editions completed`, artifact test262-legacy-completed-measurement), and
 * a pass -> compile_timeout is listed and watched, not gated, until it repeats
 * (scripts/lib/test262-timeout-watch.mjs).
 *
 * Exit codes: 0 ok (including "no baseline") · 2 usage · 3 REGRESSION FOUND
 * (the JSON report is written first) · anything else (1 = an uncaught throw)
 * is a crash: the workflow treats it as infrastructure, never as a regression.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { findCategoryTestFiles, TEST_CATEGORIES } from "../tests/test262-categories.ts";
import { classifyTest262File, editionStringToYear } from "./generate-editions.ts";
import { ghWithRetry } from "./lib/gh-api-retry.mjs";
import {
  type NonPassReasons,
  buildNonPassReasons,
  propertyHelperReader,
  renderNonPassReasons,
} from "./lib/test262-nonpass-reasons.ts";
import { REGRESSION_ANNOTATION_TITLE } from "./lib/regression-annotation.mjs";
import {
  type Outcome,
  type WatchEntry,
  RECHECK_COMPILE_TIMEOUT_MS,
  RECHECK_MAX_ROWS,
  classifyRow,
  nextWatch,
  readWatch,
} from "./lib/test262-timeout-watch.mjs";

/** `report` exit code for "a test of the edition regressed" — distinct from a crash (1). */
export const REGRESSION_EXIT_CODE = 3;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_EDITION_CONFIG = join(ROOT, "scripts", "test262-current-edition.json");
const RECLASSIFIED_CONFIG = join(ROOT, "scripts", "test262-edition-reclassified.json");
const RATCHET_BASELINE = join(ROOT, "scripts", "test262-edition-ratchet-baseline.json");

/** Artifact names of the two IR measurement scopes; consumers tell them apart by name. */
const EDITION_ARTIFACT = "test262-ir-standalone-edition-measurement";
const FULL_ARTIFACT = "test262-ir-standalone-measurement";
/** #7537: the legacy lane's completed editions, measured on every push and in the full run. */
export const LEGACY_ARTIFACT = "test262-legacy-completed-measurement";
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

/**
 * The editions the legacy lane has finished (`completed` and still ratcheted in
 * the edition ratchet's baseline), as years. Read only: main is that file's
 * sole writer.
 */
type RatchetEntry = { completed?: boolean; ratcheted?: boolean; exceptions?: { file: string }[] };

function completedEntries(path: string): [number, RatchetEntry][] {
  const { editions } = JSON.parse(readFileSync(path, "utf-8")) as { editions: Record<string, RatchetEntry> };
  const entries = Object.entries(editions)
    .filter(([, e]) => e.completed && e.ratcheted)
    .map(([key, e]): [number, RatchetEntry] => [Number(key), e])
    .sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) throw new Error(`${path}: no completed edition`);
  return entries;
}

export function readCompletedYears(path = RATCHET_BASELINE): number[] {
  return completedEntries(path).map(([year]) => year);
}

/** The completed editions' reviewed `exceptions`: rows that may not pass, each with its reason. */
export function readCompletedExceptions(path = RATCHET_BASELINE): Set<string> {
  return new Set(completedEntries(path).flatMap(([, e]) => (e.exceptions ?? []).map((x) => x.file)));
}

/**
 * #7537: the completed-edition rule as a baseline. Every row of a completed
 * edition passes, except its reviewed exceptions, so a row the earlier
 * measurement lacks — or no earlier measurement at all (the first run, an
 * expired artifact, an eval-engine switch) — is still compared, re-checked and
 * alarmed instead of only turning the ratchet red. An earlier measurement's
 * own verdicts win where it has them.
 */
export function completedRuleStatuses(
  paths: ReadonlySet<string>,
  exceptions: ReadonlySet<string>,
  measured: StatusMap = new Map(),
): StatusMap {
  const out: StatusMap = new Map();
  for (const file of paths) if (!exceptions.has(file)) out.set(file, "pass");
  for (const [file, status] of measured) out.set(file, status);
  return out;
}

/** The `sourceSha` a baseline built from the completed rule alone carries. */
export const COMPLETED_RULE_SHA = "completed-rule";

/** The scope a command measures: the IR's current edition, or the legacy lane's completed ones. */
export interface Scope {
  label: string;
  years: number[];
}

export function readScope(editions: string | undefined): Scope {
  if (editions === undefined || editions === "current") {
    const { edition, year } = readCurrentEdition();
    return { label: edition, years: [year] };
  }
  if (editions !== "completed") usage(`--editions must be current or completed, not ${editions}`);
  const years = readCompletedYears();
  return { label: years.map((y) => (y === 5 ? "ES5" : `ES${y}`)).join("+"), years };
}

export function scopePaths(test262Root: string, scope: Scope): string[] {
  return [...new Set(scope.years.flatMap((year) => editionPaths(test262Root, year)))].sort();
}

/**
 * Tests deliberately moved out of the current edition, each with a reason
 * (a reviewed file, so the escape hatch is visible in the diff that uses it).
 */
export function readReclassified(path = RECLASSIFIED_CONFIG): Set<string> {
  const { files } = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(files)) throw new Error(`${path}: "files" must be an array`);
  const out = new Set<string>();
  for (const entry of files) {
    if (typeof entry?.file !== "string" || typeof entry?.reason !== "string" || !entry.reason.trim())
      throw new Error(`${path}: every entry needs a file and a reason: ${JSON.stringify(entry)}`);
    out.add(entry.file);
  }
  return out;
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

function readRows(path: string): unknown[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function statusesOf(rows: readonly unknown[]): StatusMap {
  const out: StatusMap = new Map();
  for (const row of rows as { file?: unknown; status?: unknown }[]) {
    if (typeof row.file === "string" && typeof row.status === "string") out.set(row.file, row.status);
  }
  return out;
}

/** Rows whose status comes from the re-check (`override` marks them). */
function recheckedOf(rows: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows as { file?: unknown; recheck?: unknown }[]) {
    if (typeof row.file === "string" && row.recheck === true) out.add(row.file);
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
   * pass -> not-pass, the gated set. A first pass -> compile_timeout is not in
   * it (#7537, owner 2026-11-27): see `timeouts`. `now` is MISSING_STATUS for a
   * test this run did not report.
   */
  regressions: { file: string; now: string }[];
  /** First pass -> compile_timeout: listed and watched, not gated. */
  timeouts: string[];
  /** Watched rows that timed out again and still await their raised-timeout re-check. */
  recheck: string[];
  /** Re-checked rows that passed: the shard run's verdict was a flake. */
  flakes: string[];
  /** Watched rows that repeated: charged to the PRs where the timeout first appeared, never gated here. */
  confirmedRepeats: { file: string; now: string; origin: WatchEntry }[];
  /** Every compared row's outcome, which `nextWatch` turns into the next watch list. */
  outcomes: Map<string, Outcome>;
  improvements: string[];
  /** In the edition now, absent from the baseline (new test262 files, or a baseline that never ran them). */
  unbaselined: number;
  /** Passed in the baseline, absent now, and the test262 revision changed: not comparable, not gated. */
  notComparable: string[];
  /** Dropped from the edition on purpose (scripts/test262-edition-reclassified.json): listed, not gated. */
  reclassified: string[];
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
 *
 * `baselineCoversEdition` (the baseline measured this same edition) widens the
 * check to every baseline row, not just today's path list: a change that
 * narrows the classifier or the runner's categories shrinks today's list and
 * the expected set together, and only the baseline still remembers the tests
 * that fell out.
 */
export function compareEditionRuns(
  run: StatusMap,
  baseline: StatusMap,
  paths: ReadonlySet<string>,
  {
    sameTest262Revision,
    baselineCoversEdition,
    reclassified = new Set<string>(),
    watch = new Map<string, WatchEntry>(),
    rechecked = new Set<string>(),
  }: {
    sameTest262Revision: boolean;
    baselineCoversEdition: boolean;
    reclassified?: ReadonlySet<string>;
    watch?: ReadonlyMap<string, WatchEntry>;
    rechecked?: ReadonlySet<string>;
  },
): EditionDiff {
  const diff: EditionDiff = {
    regressions: [],
    timeouts: [],
    recheck: [],
    flakes: [],
    confirmedRepeats: [],
    outcomes: new Map(),
    improvements: [],
    unbaselined: 0,
    notComparable: [],
    reclassified: [],
  };
  const files = baselineCoversEdition ? new Set([...paths, ...baseline.keys()]) : paths;
  for (const file of files) {
    const now = run.get(file);
    const watched = watch.has(file);
    // A watched row keeps its pre-timeout `pass` for one more measurement.
    const was = watched ? "pass" : baseline.get(file);
    if (now === undefined) {
      if (was !== "pass") continue;
      if (reclassified.has(file)) diff.reclassified.push(file);
      else if (sameTest262Revision) diff.regressions.push({ file, now: MISSING_STATUS });
      else diff.notComparable.push(file);
      continue;
    }
    if (was === undefined) {
      diff.unbaselined++;
      continue;
    }
    const outcome = classifyRow(was, watched, now, rechecked.has(file));
    diff.outcomes.set(file, outcome);
    if (outcome === "regression") diff.regressions.push({ file, now });
    else if (outcome === "listed") diff.timeouts.push(file);
    else if (outcome === "recheck") diff.recheck.push(file);
    else if (outcome === "flake") diff.flakes.push(file);
    else if (outcome === "confirmedRepeat") diff.confirmedRepeats.push({ file, now, origin: watch.get(file)! });
    else if (outcome === "improvement") diff.improvements.push(file);
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
 * Every measurement on `lineage`, EDITION measurements first, each group
 * nearest first (first-parent order) and, within one commit, newest first so
 * a re-run supersedes. The caller takes the first one that turns out
 * comparable.
 *
 * Edition before full: only an edition baseline lets `compareEditionRuns`
 * catch tests a narrowed classifier dropped. The daily full run lands on a
 * main commit AFTER that commit's own edition measurement, so newest-first
 * alone would hand the next queue group the full one, the narrowing would
 * pass, and the group's own edition artifact would then lack the dropped
 * tests for good. A full measurement is used only when no edition one is in
 * the window (the first run after #7551, or after an edition switch).
 */
export function baselineCandidates(
  lineage: readonly string[],
  artifacts: readonly ArtifactRef[],
  names: readonly string[] = [EDITION_ARTIFACT, FULL_ARTIFACT],
): { artifact: ArtifactRef; distance: number }[] {
  const ranked = (name: string) =>
    lineage.flatMap((sha, distance) =>
      artifacts
        .filter((a) => a.sha === sha && a.name === name)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((artifact) => ({ artifact, distance })),
    );
  return names.flatMap(ranked);
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
  /** #7537: the watch list the next measurement reads (`timeout-watch.json`). */
  timeoutWatch: WatchEntry[];
  /** #7568: why the edition's rows do not pass; absent when building it failed. */
  nonPassReasons?: NonPassReasons;
}

const LIST_LIMIT = 200;

export function renderSummary(r: Report): string {
  const c = r.counts;
  const lines = [
    `## test262 — ${r.edition} (#7551, #7537)`,
    "",
    `Commit \`${r.sourceSha}\`. This is the edition scope only, not the full corpus (that runs daily).`,
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
  if (b.sha === COMPLETED_RULE_SHA)
    lines.push(
      "No earlier measurement: compared with the completed-edition rule (every row passes but its exceptions).",
    );
  else lines.push(`Compared with the measurement of \`${b.sha}\`${b.runId ? ` (run ${b.runId})` : ""}${distance}.`);
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
  if (d.timeouts.length > 0) list("Not gated: first pass → compile_timeout, now watched (#7537)", d.timeouts.map(code));
  if (d.recheck.length > 0) list("Watched rows that timed out again: awaiting re-check", d.recheck.map(code));
  if (d.flakes.length > 0) list("Not gated: failed in the shard run, passed on re-check", d.flakes.map(code));
  if (d.confirmedRepeats.length > 0)
    list(
      "Confirmed repeated timeouts: alarmed against the PRs where they first appeared, not gated",
      d.confirmedRepeats.map(
        (x) =>
          `${code(x.file)} → ${x.now} (first at \`${x.origin.firstSeenSha}\`, ${x.origin.prs.map((n) => `#${n}`).join(", ") || "PR unknown"})`,
      ),
    );
  if (d.notComparable.length > 0)
    list("Not comparable (test262 revision changed): passed before, no row now", d.notComparable.map(code));
  if (d.reclassified.length > 0)
    list(
      "Not gated: deliberately reclassified out of the edition (test262-edition-reclassified.json)",
      d.reclassified.map(code),
    );
  if (d.unbaselined > 0) lines.push(`${d.unbaselined} test(s) of the edition have no row in the baseline.`, "");
  return lines.join("\n") + "\n";
}

/** Build the report; the caller decides the exit code from `diff.regressions`. */
export function buildReport(opts: {
  run: StatusMap;
  meta: ScopeMeta;
  paths: ReadonlySet<string>;
  baseline?: {
    statuses: StatusMap;
    meta: ScopeMeta;
    runId?: number;
    distance?: number;
    watch?: ReadonlyMap<string, WatchEntry>;
  };
  reclassified?: ReadonlySet<string>;
  rechecked?: ReadonlySet<string>;
  /** The PRs this measurement covers: the origin of a timeout first seen here. */
  prs?: number[];
}): Report {
  const base: Report = {
    edition: opts.meta.edition ?? "",
    sourceSha: opts.meta.sourceSha,
    counts: countStatuses(opts.run, opts.paths),
    baseline: null,
    timeoutWatch: [],
  };
  if (!opts.baseline) {
    return {
      ...base,
      noBaselineReason:
        `No comparable earlier measurement within ${MAX_BASELINE_DISTANCE} first-parent commits ` +
        "(the download step logs each one it skipped, and why).",
    };
  }
  const mismatch = baselineMismatch(opts.baseline.meta, opts.meta);
  if (mismatch) return { ...base, noBaselineReason: `The nearest earlier measurement is not comparable: ${mismatch}.` };
  const from = opts.baseline.meta.test262Sha;
  const to = opts.meta.test262Sha;
  const watch = opts.baseline.watch ?? new Map<string, WatchEntry>();
  const diff = compareEditionRuns(opts.run, opts.baseline.statuses, opts.paths, {
    sameTest262Revision: from === to,
    baselineCoversEdition: opts.baseline.meta.scope === "edition",
    reclassified: opts.reclassified,
    watch,
    rechecked: opts.rechecked,
  });
  return {
    ...base,
    baseline: {
      sha: opts.baseline.meta.sourceSha,
      runId: opts.baseline.runId,
      distance: opts.baseline.distance,
      ...(from === to ? {} : { test262Changed: { from, to } }),
    },
    diff,
    timeoutWatch: nextWatch(watch, diff.outcomes, { sha: opts.meta.sourceSha, prs: opts.prs ?? [] }),
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
  const scope = readScope(arg(args, "--editions"));
  const paths = scopePaths(required(args, "--test262"), scope);
  if (paths.length === 0) usage(`no ${scope.label} files under ${arg(args, "--test262")} — is test262 checked out?`);
  writeFileSync(required(args, "--out"), paths.join("\n") + "\n");
  console.log(`${scope.label}: ${paths.length} test files`);
}

const gh = (...args: string[]): string => ghWithRetry(args);

/** The named artifacts' unexpired copies, every page (an expired one cannot be downloaded). */
function listArtifacts(repo: string, names: readonly string[]): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  for (const name of names) {
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

/** Downloads tried before giving up: each candidate is a full artifact. */
const MAX_BASELINE_DOWNLOADS = 5;

/** Why a downloaded measurement cannot serve as the baseline, or null when it can. */
export function candidateRejection(dir: string, current: ScopeMeta): string | null {
  if (!existsSync(join(dir, "results.jsonl"))) return "it has no results.jsonl";
  // Measurements from before #7551 do not record their eval engine or test262 revision.
  if (!existsSync(join(dir, "scope.json"))) return "it predates scope.json, so its comparability is unknown";
  return baselineMismatch(JSON.parse(readFileSync(join(dir, "scope.json"), "utf-8")), current);
}

/** Head shas of this workflow's runs that have not finished yet. */
function unfinishedRunShas(repo: string): Set<string> {
  const out = new Set<string>();
  for (const status of ["queued", "in_progress"]) {
    const { workflow_runs = [] } = JSON.parse(
      gh("api", `repos/${repo}/actions/workflows/test262-sharded.yml/runs?status=${status}&per_page=100`),
    );
    for (const r of workflow_runs) if (r.event !== "merge_group" && r.head_sha) out.add(r.head_sha);
  }
  return out;
}

const WAIT_POLL_MS = 120_000;

/**
 * The commit to wait for: one nearer on the lineage than the nearest measured
 * commit whose run has not finished. Undefined when there is none.
 */
export function nearerUnfinished(
  lineage: readonly string[],
  measured: ReadonlySet<string>,
  pending: ReadonlySet<string>,
): string | undefined {
  const nearest = lineage.findIndex((sha) => measured.has(sha));
  return (nearest < 0 ? lineage : lineage.slice(0, nearest)).find((sha) => pending.has(sha));
}

/**
 * #7537: never compare against a predecessor whose run has not finished. Waits
 * while a commit nearer than the nearest measured one still has a run in
 * flight, up to the deadline; after that the caller falls back to the nearest
 * measured commit, which widens the commit range the comparison covers.
 */
function waitForNearerRuns(repo: string, lineage: readonly string[], names: readonly string[], minutes: number): void {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const measured = new Set(listArtifacts(repo, names).map((a) => a.sha));
    const waitingOn = nearerUnfinished(lineage, measured, unfinishedRunShas(repo));
    if (!waitingOn) return;
    if (Date.now() >= deadline) {
      console.log(
        `stopped waiting for the run of ${waitingOn} after ${minutes} min; using the nearest measured commit`,
      );
      return;
    }
    console.log(`waiting for the run of ${waitingOn} (nearer than any finished measurement) to finish`);
    execFileSync("sleep", [String(WAIT_POLL_MS / 1000)]);
  }
}

function cmdFetchBaseline(args: string[]): void {
  const from = required(args, "--from");
  const dest = required(args, "--dest");
  const current: ScopeMeta = JSON.parse(readFileSync(required(args, "--meta"), "utf-8"));
  const repo = process.env.GITHUB_REPOSITORY ?? usage("GITHUB_REPOSITORY is not set");
  const artifact = arg(args, "--artifact");
  const names = artifact ? [artifact] : [EDITION_ARTIFACT, FULL_ARTIFACT];
  const lineage = execFileSync(
    "git",
    ["rev-list", "--first-parent", `--max-count=${MAX_BASELINE_DISTANCE + 1}`, from],
    { encoding: "utf-8" },
  )
    .split("\n")
    .filter(Boolean);
  const wait = arg(args, "--wait-minutes");
  if (wait) waitForNearerRuns(repo, lineage, names, Number(wait));
  const candidates = baselineCandidates(lineage, listArtifacts(repo, names), names).slice(0, MAX_BASELINE_DOWNLOADS);
  for (const { artifact, distance } of candidates) {
    rmSync(dest, { recursive: true, force: true });
    gh("run", "download", String(artifact.runId), "--repo", repo, "--name", artifact.name, "--dir", dest);
    const rejection = candidateRejection(dest, current);
    if (rejection) {
      console.log(`skipped ${artifact.name} of ${artifact.sha} (run ${artifact.runId}): ${rejection}`);
      continue;
    }
    writeFileSync(join(dest, "baseline-ref.json"), JSON.stringify({ ...artifact, distance }) + "\n");
    console.log(`baseline: ${artifact.name} of ${artifact.sha} (run ${artifact.runId}, distance ${distance})`);
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  console.log(
    `no comparable measurement among ${candidates.length} candidate(s) on the ${lineage.length} first-parent commit(s) from ${from}`,
  );
}

function readJsonIfPresent(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : undefined;
}

function cmdReport(args: string[]): void {
  const meta: ScopeMeta = JSON.parse(readFileSync(required(args, "--meta"), "utf-8"));
  const test262 = required(args, "--test262");
  const editions = arg(args, "--editions");
  const paths = new Set(scopePaths(test262, readScope(editions)));
  const dir = arg(args, "--baseline-dir");
  let baseline: Parameters<typeof buildReport>[0]["baseline"];
  if (dir && existsSync(join(dir, "results.jsonl")) && existsSync(join(dir, "scope.json"))) {
    const ref = (readJsonIfPresent(join(dir, "baseline-ref.json")) ?? {}) as { runId?: number; distance?: number };
    baseline = {
      statuses: statusesOf(readRows(join(dir, "results.jsonl"))),
      meta: JSON.parse(readFileSync(join(dir, "scope.json"), "utf-8")),
      runId: ref.runId,
      distance: ref.distance,
      watch: readWatch(readJsonIfPresent(join(dir, "timeout-watch.json"))),
    };
  }
  if (editions === "completed") {
    const exceptions = readCompletedExceptions();
    baseline = baseline
      ? { ...baseline, statuses: completedRuleStatuses(paths, exceptions, baseline.statuses) }
      : { statuses: completedRuleStatuses(paths, exceptions), meta: { ...meta, sourceSha: COMPLETED_RULE_SHA } };
  }
  const rows = readRows(required(args, "--results"));
  const prsPath = arg(args, "--prs");
  const report = buildReport({
    run: statusesOf(rows),
    meta,
    paths,
    baseline,
    reclassified: readReclassified(),
    rechecked: recheckedOf(rows),
    prs: prsPath ? (JSON.parse(readFileSync(prsPath, "utf-8")) as number[]) : [],
  });
  const watchOut = arg(args, "--watch-out");
  // `alarmed`: the confirmed repeats this measurement charged to their origin; they leave the watch list.
  if (watchOut)
    writeFileSync(
      watchOut,
      JSON.stringify({ watch: report.timeoutWatch, alarmed: report.diff?.confirmedRepeats ?? [] }, null, 2) + "\n",
    );
  let summary = renderSummary(report);
  // Informational only: building it must never change the verdict or the exit code.
  try {
    report.nonPassReasons = buildNonPassReasons(rows, paths, propertyHelperReader(test262));
    summary += "\n" + renderNonPassReasons(report.nonPassReasons).join("\n");
  } catch (err) {
    console.log(`non-pass reasons section skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  writeFileSync(required(args, "--summary"), summary);
  // `outcomes` is a working map, not part of the published report.
  const published = report.diff ? { ...report, diff: { ...report.diff, outcomes: undefined } } : report;
  writeFileSync(required(args, "--json"), JSON.stringify(published, null, 2) + "\n");
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

/**
 * #7537: the rows the re-check runs, from a report: watched rows that timed out
 * again (run under the raised compile timeout) and every other regression
 * still present in the run (a row the run dropped cannot be re-checked).
 * Above `max` rows nothing is re-checked: that many is a real break, and a
 * serial re-check of it would hold the merge-queue head for hours.
 */
export function recheckCandidates(
  r: Pick<Report, "diff">,
  max = RECHECK_MAX_ROWS,
): { watched: string[]; other: string[]; overLimit?: number } {
  const watched = r.diff?.recheck ?? [];
  const other = (r.diff?.regressions ?? []).filter((x) => x.now !== MISSING_STATUS).map((x) => x.file);
  const total = watched.length + other.length;
  return total > max ? { watched: [], other: [], overLimit: total } : { watched, other };
}

function cmdCandidates(args: string[]): void {
  const report = JSON.parse(readFileSync(required(args, "--report"), "utf-8")) as Report;
  const { watched, other, overLimit } = recheckCandidates(report);
  writeFileSync(required(args, "--watched"), watched.map((f) => f + "\n").join(""));
  writeFileSync(required(args, "--other"), other.map((f) => f + "\n").join(""));
  if (overLimit !== undefined)
    console.log(`re-check skipped: ${overLimit} candidates exceed ${RECHECK_MAX_ROWS}; the verdict stands as measured`);
  else console.log(`re-check candidates: ${watched.length} watched timeout(s), ${other.length} other regression(s)`);
}

/**
 * #7537: each re-checked row replaces the shard's row for the same file, marked
 * so every later reader (report, ratchet, promotion) knows its verdict came
 * from the single-worker re-check and under which compile timeout.
 */
export function overrideRows(shardRows: readonly unknown[], recheckRows: readonly unknown[]): unknown[] {
  const byFile = new Map<string, Record<string, unknown>>();
  for (const row of recheckRows as Record<string, unknown>[]) {
    if (typeof row.file === "string") byFile.set(row.file, { ...row, recheck: true });
  }
  return (shardRows as Record<string, unknown>[]).map((row) =>
    typeof row.file === "string" && byFile.has(row.file) ? byFile.get(row.file)! : row,
  );
}

function cmdOverride(args: string[]): void {
  const results = required(args, "--results");
  // Promotion keeps these marks: a promoted row measured by the single-worker
  // re-check, and under which compile timeout, stays identifiable.
  const marked = (flag: string, marks: Record<string, number>) =>
    args.flatMap((a, i) => (args[i - 1] === flag ? readRows(a).map((r) => ({ ...(r as object), ...marks })) : []));
  const recheck = [
    ...marked("--recheck", { recheck_pool: 1 }),
    ...marked("--recheck-watched", { recheck_pool: 1, recheck_compile_timeout_ms: RECHECK_COMPILE_TIMEOUT_MS }),
  ];
  const rows = overrideRows(readRows(results), recheck);
  writeFileSync(results, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`override: ${recheck.length} re-checked row(s) replaced in ${results}`);
}

function cmdMeta(args: string[]): void {
  const scope = required(args, "--scope");
  if (scope !== "edition" && scope !== "full") usage(`--scope must be edition or full, not ${scope}`);
  const meta: ScopeMeta = {
    scope,
    // A full measurement has no edition; an edition one names the scope it measured.
    ...(scope === "edition" || arg(args, "--editions") ? { edition: readScope(arg(args, "--editions")).label } : {}),
    sourceSha: required(args, "--source-sha"),
    test262Sha: required(args, "--test262-sha"),
    evalEngine: required(args, "--eval-engine"),
  };
  writeFileSync(required(args, "--out"), JSON.stringify(meta, null, 2) + "\n");
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "paths") cmdPaths(args);
  else if (command === "meta") cmdMeta(args);
  else if (command === "fetch-baseline") cmdFetchBaseline(args);
  else if (command === "report") cmdReport(args);
  else if (command === "candidates") cmdCandidates(args);
  else if (command === "override") cmdOverride(args);
  else usage("usage: test262-edition-scope.ts paths|meta|fetch-baseline|report|candidates|override …");
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
