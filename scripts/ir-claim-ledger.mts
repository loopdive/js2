// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7002 — IR claim ledger on a test262-scale corpus.
 *
 * `check:ir-only` and `check:ir-fallbacks` measure the playground corpus (five
 * and ~13 files). That population reads READY (38/38 IR bodies) while a
 * test262 stride shows most terminal units still take the legacy body. This
 * script measures the wide population so the number exists and is refreshed:
 *
 *   - corpus: every playground example (`website/playground/examples/**.ts`)
 *     plus a deterministic stride of `test262/test/**.js` (sorted paths, every
 *     Nth file, `_FIXTURE` helpers excluded), compiled raw (no harness);
 *   - compile: default options + `target` + `trackIrOutcomes: true` (telemetry
 *     is observation-only since #7002, so this is the production route);
 *   - tally: terminal units by unit kind × outcome kind, body route (IR /
 *     legacy / both / neither), `unsupported` by `stage:code`, selector
 *     reasons, invariant codes, and files that produced NO telemetry rows.
 *
 * It is a measurement, not a gate: it never exits non-zero on the numbers.
 *
 *   npx tsx scripts/ir-claim-ledger.mts [--stride 40] [--target standalone]
 *                                       [--out benchmarks/results/ir-claim-ledger-standalone.json]
 *                                       [--limit N]   # cap test262 files (smoke runs)
 *                                       [--jobs N]    # worker processes (default: cores - 1)
 *                                       [--wrapped]   # #7240: compile test262 files as the runner does
 *                                       [--files-json <path>]  # #7249: per-file rows (wrapped only)
 *
 * The test262 files are split round-robin over `--jobs` worker processes (one
 * compile per process at a time); the merged tallies do not depend on N.
 *
 * `--wrapped` (#7240, opt-in; raw stays the default and its JSON is unchanged
 * apart from the `mode` label). Raw mode measures a program the runner never
 * compiles: no harness, so `assert`/`$262` are out of scope and the harness's
 * own units and call graph are invisible. Wrapped mode compiles each test262
 * file exactly as `runTest262File` (tests/test262-runner.ts) does for
 * `--target standalone`, reusing its functions, not copies:
 *   - source: `assembleOriginalHarness(source, parseMeta(source)).primary.source`
 *     — the literal upstream harness assembly, which is what the verdict-bearing
 *     runner and the sharded CI worker compile since #3370. `wrapTest` is NOT
 *     used: the runner marks it deprecated, a diagnostic rewrite that is not
 *     the conformance program;
 *   - options: `originalHarnessCompileOptions(meta, target)` + the file path as
 *     `fileName` + `trackIrOutcomes: true`;
 *   - skips: exactly the runner's — a non-negative file that `shouldSkip`
 *     rejects is not compiled; it is counted under `skipped` / `skippedReasons`;
 *   - negative tests are compiled like every other file, through the same
 *     assembly — that is what `runTest262File` does (it does not route through
 *     `buildNegativeCompileSource`, which only the legacy synthetic runner uses);
 *   - NOT modelled: the strict rerun variant (only `primary` is measured), the
 *     Temporal provider prelude and the compileMulti self-import route for
 *     `module-code/namespace/` — those rows are compiled single-file.
 * Each unit is tagged `harness` or `test` by position: a function / class
 * member whose line is past the assembly's `bodyLineOffset` is `test`. The
 * per-file `<module-init>` unit is always `test` — it executes the test body.
 * `byOrigin` reports both totals so the harness units, repeated in every file,
 * do not swamp the test units. The playground corpus has no harness and is
 * measured raw in both modes.
 *
 * With `JS2WASM_IR_SHAPE_DIAG=1` the compiler's `unsupported` rows carry the
 * first refusal as `detail` (e.g. `expr-ident-not-in-scope:Identifier «assert»`);
 * the ledger then also tallies `unsupportedDetails` (both modes, and per
 * origin). Without the variable the key is absent, so default output is unchanged.
 *
 * Wrapped mode also predicts `ir_only_pass` per file (#7249, see
 * scripts/ir-claim-ledger-files.mts): the summary gains `zeroLegacyFiles` and
 * `legacyUnitHistogram`, and `--files-json <path>` (repo-relative) writes one
 * row per compiled test262 file naming its legacy units. Workers return their
 * rows inside the partial population; only the parent writes files.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile, type CompileOptions, type IrObservedOutcome } from "../src/index.js";
import { fileRow, legacySummary, type FileRow, type UnitOrigin } from "./ir-claim-ledger-files.mjs";

/** Loaded only under `--wrapped`, so raw mode never imports the runner. */
type Runner = typeof import("../tests/test262-runner.js");
type Harness = typeof import("../tests/test262-original-harness.js");
interface WrappedCompiler {
  readonly runner: Runner;
  readonly harness: Harness;
}
export async function loadWrappedCompiler(): Promise<WrappedCompiler> {
  const [runner, harness] = await Promise.all([
    import("../tests/test262-runner.js"),
    import("../tests/test262-original-harness.js"),
  ]);
  return { runner, harness };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYGROUND_ROOT = "website/playground/examples";
const TEST262_ROOT = "test262/test";
const SCHEMA_VERSION = 1;
const SHAPE_DIAG = process.env.JS2WASM_IR_SHAPE_DIAG === "1";

interface Args {
  readonly stride: number;
  readonly target: NonNullable<CompileOptions["target"]>;
  readonly out: string;
  readonly limit: number | undefined;
  readonly jobs: number;
  readonly wrapped: boolean;
  readonly filesJson: string | undefined;
  /** Internal: `i/N` — measure only test262 files with index % N === i and write the partial to `workerOut`. */
  readonly worker: { readonly index: number; readonly count: number } | undefined;
  readonly workerOut: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const stride = Number(value("--stride") ?? 40);
  if (!Number.isInteger(stride) || stride < 1) throw new Error(`--stride must be a positive integer, got ${stride}`);
  const target = (value("--target") ?? "standalone") as Args["target"];
  const limitRaw = value("--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  const jobs = Number(value("--jobs") ?? Math.max(1, availableParallelism() - 1));
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs must be a positive integer, got ${jobs}`);
  const workerRaw = value("--worker");
  const workerMatch = workerRaw === undefined ? undefined : /^(\d+)\/(\d+)$/.exec(workerRaw);
  if (workerRaw !== undefined && !workerMatch) throw new Error(`--worker must be i/N, got ${workerRaw}`);
  if (argv.includes("--wrapped") && target !== "standalone") {
    throw new Error(`--wrapped models the runner's --target standalone compile only, got --target ${target}`);
  }
  if (argv.includes("--files-json") && !argv.includes("--wrapped")) throw new Error("--files-json requires --wrapped");
  return {
    stride,
    target,
    out: value("--out") ?? `benchmarks/results/ir-claim-ledger-${target}.json`,
    limit,
    jobs,
    wrapped: argv.includes("--wrapped"),
    filesJson: value("--files-json"),
    worker: workerMatch ? { index: Number(workerMatch[1]), count: Number(workerMatch[2]) } : undefined,
    workerOut: value("--worker-out"),
  };
}

/** Sorted recursive file list; symlinks are skipped so the walk is stable across checkouts. */
function walk(root: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) stack.push(path);
      else if (accept(name)) out.push(relative(REPO_ROOT, path));
    }
  }
  return out.sort();
}

function ledgerCorpus(stride: number, limit?: number): { playground: string[]; test262: string[] } {
  const playground = walk(join(REPO_ROOT, PLAYGROUND_ROOT), (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
  const test262All = walk(join(REPO_ROOT, TEST262_ROOT), (name) => name.endsWith(".js") && !name.includes("_FIXTURE"));
  const strided = test262All.filter((_, index) => index % stride === 0);
  return { playground, test262: limit === undefined ? strided : strided.slice(0, limit) };
}

type Counts = Record<string, number>;
const inc = (counts: Counts, key: string, by = 1): void => {
  counts[key] = (counts[key] ?? 0) + by;
};
const sorted = (counts: Counts): Counts =>
  Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

type BodyRoute = "ir" | "legacy" | "both" | "neither";
function bodyRoute(outcome: IrObservedOutcome): BodyRoute {
  if (outcome.irBodyEmitted && outcome.legacyBodyEmitted) return "both";
  if (outcome.irBodyEmitted) return "ir";
  if (outcome.legacyBodyEmitted) return "legacy";
  return "neither";
}

interface Population {
  files: number;
  compileOk: number;
  compileFail: number;
  threw: number;
  noTelemetry: number;
  units: number;
  byOutcomeKind: Counts;
  byBodyRoute: Counts;
  byUnitKind: Record<string, { units: number; byOutcomeKind: Counts; byBodyRoute: Counts }>;
  unsupportedByStageCode: Counts;
  selectReasons: Counts;
  invariantCodes: Counts;
  noTelemetryFiles: string[];
  threwFiles: string[];
  /** The slowest compiles (ms), so a runtime blow-up has a name. */
  slowestFiles: { path: string; ms: number }[];
  /** `JS2WASM_IR_SHAPE_DIAG=1` only: `unsupported` rows by first-refusal detail. */
  unsupportedDetails?: Counts;
  /** Wrapped mode only: files the runner's `shouldSkip` rejects (not compiled, not in `files`). */
  skipped?: number;
  skippedReasons?: Counts;
  /** Wrapped mode only: the same tallies split by unit origin. */
  byOrigin?: Record<UnitOrigin, OriginTally>;
  /** Wrapped mode only (#7249): one row per compiled file; the parent moves them to `--files-json`. */
  fileRows?: FileRow[];
  zeroLegacyFiles?: number;
  legacyUnitHistogram?: ReturnType<typeof legacySummary>["legacyUnitHistogram"];
}

interface OriginTally {
  units: number;
  byOutcomeKind: Counts;
  byBodyRoute: Counts;
  byUnitKind: Counts;
  unsupportedByStageCode: Counts;
  selectReasons: Counts;
  invariantCodes: Counts;
  unsupportedDetails?: Counts;
}

function emptyOriginTally(): OriginTally {
  return {
    units: 0,
    byOutcomeKind: {},
    byBodyRoute: {},
    byUnitKind: {},
    unsupportedByStageCode: {},
    selectReasons: {},
    invariantCodes: {},
    ...(SHAPE_DIAG ? { unsupportedDetails: {} } : {}),
  };
}

function emptyWrappedFields(): Required<Pick<Population, "skipped" | "skippedReasons" | "byOrigin" | "fileRows">> {
  return {
    skipped: 0,
    skippedReasons: {},
    byOrigin: { harness: emptyOriginTally(), test: emptyOriginTally() },
    fileRows: [],
  };
}

/** #7240: `<module-init>` runs the test body; any other unit is `test` iff it starts past the harness prefix. */
function unitOrigin(outcome: Pick<IrObservedOutcome, "unitKind" | "line">, bodyLineOffset: number): UnitOrigin {
  if (outcome.unitKind === "module-init") return "test";
  return outcome.line > bodyLineOffset ? "test" : "harness";
}

function recordOrigin(tally: OriginTally, outcome: IrObservedOutcome): void {
  tally.units += 1;
  inc(tally.byOutcomeKind, outcome.kind);
  inc(tally.byBodyRoute, bodyRoute(outcome));
  inc(tally.byUnitKind, outcome.unitKind);
  if (outcome.kind === "unsupported") {
    inc(tally.unsupportedByStageCode, `${outcome.stage}:${outcome.code}`);
    if (outcome.stage === "select" && outcome.reason) inc(tally.selectReasons, outcome.reason);
    if (tally.unsupportedDetails && outcome.detail) inc(tally.unsupportedDetails, outcome.detail);
  } else if (outcome.kind === "invariant") {
    inc(tally.invariantCodes, `${outcome.stage}:${outcome.code}`);
  }
}

function emptyPopulation(wrapped = false): Population {
  const population: Population = {
    files: 0,
    compileOk: 0,
    compileFail: 0,
    threw: 0,
    noTelemetry: 0,
    units: 0,
    byOutcomeKind: {},
    byBodyRoute: {},
    byUnitKind: {},
    unsupportedByStageCode: {},
    selectReasons: {},
    invariantCodes: {},
    noTelemetryFiles: [],
    threwFiles: [],
    slowestFiles: [],
    ...(SHAPE_DIAG ? { unsupportedDetails: {} } : {}),
  };
  return wrapped ? Object.assign(population, emptyWrappedFields()) : population;
}

function recordOutcome(population: Population, outcome: IrObservedOutcome, origin?: UnitOrigin): void {
  if (origin && population.byOrigin) recordOrigin(population.byOrigin[origin], outcome);
  population.units += 1;
  const route = bodyRoute(outcome);
  inc(population.byOutcomeKind, outcome.kind);
  inc(population.byBodyRoute, route);
  const unit = (population.byUnitKind[outcome.unitKind] ??= { units: 0, byOutcomeKind: {}, byBodyRoute: {} });
  unit.units += 1;
  inc(unit.byOutcomeKind, outcome.kind);
  inc(unit.byBodyRoute, route);
  if (outcome.kind === "unsupported") {
    inc(population.unsupportedByStageCode, `${outcome.stage}:${outcome.code}`);
    if (outcome.stage === "select" && outcome.reason) inc(population.selectReasons, outcome.reason);
    if (population.unsupportedDetails && outcome.detail) inc(population.unsupportedDetails, outcome.detail);
  } else if (outcome.kind === "invariant") {
    inc(population.invariantCodes, `${outcome.stage}:${outcome.code}`);
  }
}

const SLOWEST_KEPT = 15;
function keepSlowest(population: Population, path: string, ms: number): void {
  population.slowestFiles.push({ path, ms });
  population.slowestFiles.sort((a, b) => b.ms - a.ms || a.path.localeCompare(b.path));
  population.slowestFiles.length = Math.min(population.slowestFiles.length, SLOWEST_KEPT);
}

async function measure(
  path: string,
  target: Args["target"],
  population: Population,
  wrapped?: WrappedCompiler,
): Promise<void> {
  const started = Date.now();
  try {
    const source = readFileSync(join(REPO_ROOT, path), "utf8");
    if (wrapped) await measureWrapped(path, source, wrapped, population);
    else await measureOnce(path, source, target, population);
  } finally {
    keepSlowest(population, path, Date.now() - started);
  }
}

async function measureOnce(
  path: string,
  source: string,
  target: Args["target"],
  population: Population,
): Promise<void> {
  const options = { fileName: path.endsWith(".ts") ? "test.ts" : "test.js", target, trackIrOutcomes: true };
  await tallyCompile(path, population, () => compile(source, options));
}

/**
 * #7240 — compile one test262 file the way `runTest262File` does for
 * `--target standalone` (see the header). `path` is repo-relative.
 */
async function measureWrapped(
  path: string,
  source: string,
  wrapped: WrappedCompiler,
  population: Population,
): Promise<void> {
  const { runner, harness } = wrapped;
  const absolute = join(REPO_ROOT, path);
  const meta = runner.parseMeta(source);
  const filter = meta.negative ? undefined : runner.shouldSkip(source, meta, absolute);
  if (filter?.skip) {
    population.skipped = (population.skipped ?? 0) + 1;
    inc((population.skippedReasons ??= {}), filter.reason);
    return;
  }
  const variant = harness.assembleOriginalHarness(source, meta).primary;
  const options = { ...runner.originalHarnessCompileOptions(meta, "standalone"), fileName: absolute };
  await tallyCompile(
    path,
    population,
    () => compile(variant.source, { ...options, trackIrOutcomes: true }),
    variant.bodyLineOffset,
  );
}

/** One file → its finished tallies (the #7240 test's seam; `wrapped` absent = raw mode). */
export async function measureSource(
  path: string,
  source: string,
  target: Args["target"],
  wrapped?: WrappedCompiler,
): Promise<Population> {
  const population = emptyPopulation(wrapped !== undefined);
  if (wrapped) await measureWrapped(path, source, wrapped, population);
  else await measureOnce(path, source, target, population);
  return finish(population);
}

async function tallyCompile(
  path: string,
  population: Population,
  run: () => ReturnType<typeof compile>,
  bodyLineOffset?: number,
): Promise<void> {
  population.files += 1;
  let result: Awaited<ReturnType<typeof compile>>;
  try {
    result = await run();
  } catch {
    population.threw += 1;
    population.threwFiles.push(path);
    population.fileRows?.push(fileRow(path, false, [], () => "test"));
    return;
  }
  if (result.success) population.compileOk += 1;
  else population.compileFail += 1;
  const outcomes = result.irOutcomes ?? [];
  if (bodyLineOffset !== undefined) {
    population.fileRows?.push(
      fileRow(path, result.success, outcomes, (outcome) => unitOrigin(outcome, bodyLineOffset)),
    );
  }
  if (outcomes.length === 0) {
    population.noTelemetry += 1;
    population.noTelemetryFiles.push(path);
    return;
  }
  for (const outcome of outcomes) {
    recordOutcome(population, outcome, bodyLineOffset === undefined ? undefined : unitOrigin(outcome, bodyLineOffset));
  }
}

function finish(population: Population): Population {
  const byUnitKind = Object.fromEntries(
    Object.entries(population.byUnitKind)
      .sort((a, b) => b[1].units - a[1].units || a[0].localeCompare(b[0]))
      .map(([kind, unit]) => [
        kind,
        { units: unit.units, byOutcomeKind: sorted(unit.byOutcomeKind), byBodyRoute: sorted(unit.byBodyRoute) },
      ]),
  );
  return {
    ...population,
    byOutcomeKind: sorted(population.byOutcomeKind),
    byBodyRoute: sorted(population.byBodyRoute),
    byUnitKind,
    unsupportedByStageCode: sorted(population.unsupportedByStageCode),
    selectReasons: sorted(population.selectReasons),
    invariantCodes: sorted(population.invariantCodes),
    ...(population.unsupportedDetails ? { unsupportedDetails: sorted(population.unsupportedDetails) } : {}),
    ...(population.byOrigin ? finishWrapped(population) : {}),
  };
}

function finishOrigin(tally: OriginTally): OriginTally {
  return {
    units: tally.units,
    byOutcomeKind: sorted(tally.byOutcomeKind),
    byBodyRoute: sorted(tally.byBodyRoute),
    byUnitKind: sorted(tally.byUnitKind),
    unsupportedByStageCode: sorted(tally.unsupportedByStageCode),
    selectReasons: sorted(tally.selectReasons),
    invariantCodes: sorted(tally.invariantCodes),
    ...(tally.unsupportedDetails ? { unsupportedDetails: sorted(tally.unsupportedDetails) } : {}),
  };
}

function finishWrapped(
  population: Population,
): Pick<Population, "skipped" | "skippedReasons" | "byOrigin" | "fileRows" | "zeroLegacyFiles" | "legacyUnitHistogram"> {
  const { harness, test } = population.byOrigin!;
  const fileRows = [...population.fileRows!].sort((a, b) => a.file.localeCompare(b.file));
  return {
    skipped: population.skipped,
    skippedReasons: sorted(population.skippedReasons ?? {}),
    byOrigin: { harness: finishOrigin(harness), test: finishOrigin(test) },
    ...legacySummary(fileRows),
    fileRows,
  };
}

function mergeCounts(into: Counts, from: Counts): void {
  for (const [key, count] of Object.entries(from)) inc(into, key, count);
}

function mergePopulation(into: Population, from: Population): void {
  into.files += from.files;
  into.compileOk += from.compileOk;
  into.compileFail += from.compileFail;
  into.threw += from.threw;
  into.noTelemetry += from.noTelemetry;
  into.units += from.units;
  mergeCounts(into.byOutcomeKind, from.byOutcomeKind);
  mergeCounts(into.byBodyRoute, from.byBodyRoute);
  for (const [kind, unit] of Object.entries(from.byUnitKind)) {
    const target = (into.byUnitKind[kind] ??= { units: 0, byOutcomeKind: {}, byBodyRoute: {} });
    target.units += unit.units;
    mergeCounts(target.byOutcomeKind, unit.byOutcomeKind);
    mergeCounts(target.byBodyRoute, unit.byBodyRoute);
  }
  mergeCounts(into.unsupportedByStageCode, from.unsupportedByStageCode);
  mergeCounts(into.selectReasons, from.selectReasons);
  mergeCounts(into.invariantCodes, from.invariantCodes);
  into.noTelemetryFiles.push(...from.noTelemetryFiles);
  into.threwFiles.push(...from.threwFiles);
  for (const slow of from.slowestFiles) keepSlowest(into, slow.path, slow.ms);
  if (from.unsupportedDetails) mergeCounts((into.unsupportedDetails ??= {}), from.unsupportedDetails);
  if (from.byOrigin) mergeWrapped(into, from);
}

function mergeWrapped(into: Population, from: Population): void {
  if (!into.byOrigin) Object.assign(into, emptyWrappedFields());
  into.skipped! += from.skipped ?? 0;
  mergeCounts(into.skippedReasons!, from.skippedReasons ?? {});
  into.fileRows!.push(...from.fileRows!);
  for (const origin of ["harness", "test"] as const) {
    const target = into.byOrigin![origin];
    const source = from.byOrigin![origin];
    target.units += source.units;
    for (const key of ["byOutcomeKind", "byBodyRoute", "byUnitKind", "unsupportedByStageCode"] as const) {
      mergeCounts(target[key], source[key]);
    }
    mergeCounts(target.selectReasons, source.selectReasons);
    mergeCounts(target.invariantCodes, source.invariantCodes);
    if (source.unsupportedDetails) mergeCounts((target.unsupportedDetails ??= {}), source.unsupportedDetails);
  }
}

/** Run one worker process over its round-robin share of the test262 stride. */
function runWorker(args: Args, index: number, count: number, outPath: string): Promise<void> {
  const argv = [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "--stride",
    String(args.stride),
    "--target",
    args.target,
    "--worker",
    `${index}/${count}`,
    "--worker-out",
    outPath,
    ...(args.limit === undefined ? [] : ["--limit", String(args.limit)]),
    ...(args.wrapped ? ["--wrapped"] : []),
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, { cwd: REPO_ROOT, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolvePromise() : reject(new Error(`worker ${index}/${count} exited ${code ?? signal}`)),
    );
  });
}

async function measureTest262(args: Args, files: readonly string[]): Promise<Population> {
  const population = emptyPopulation(args.wrapped);
  if (args.jobs === 1) {
    const wrapped = args.wrapped ? await loadWrappedCompiler() : undefined;
    for (const path of files) await measure(path, args.target, population, wrapped);
    return population;
  }
  const dir = mkdtempSync(join(tmpdir(), "ir-claim-ledger-"));
  try {
    const outs = Array.from({ length: args.jobs }, (_, index) => join(dir, `worker-${index}.json`));
    await Promise.all(outs.map((out, index) => runWorker(args, index, args.jobs, out)));
    for (const out of outs) mergePopulation(population, JSON.parse(readFileSync(out, "utf8")) as Population);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  population.noTelemetryFiles.sort();
  population.threwFiles.sort();
  return population;
}

function gitHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(join(REPO_ROOT, TEST262_ROOT))) {
    process.stderr.write(`ir-claim-ledger: ${TEST262_ROOT} is missing — run: git submodule update --init test262\n`);
    process.exit(2);
  }
  const corpus = ledgerCorpus(args.stride, args.limit);
  if (args.worker) {
    const share = emptyPopulation(args.wrapped);
    const wrapped = args.wrapped ? await loadWrappedCompiler() : undefined;
    const { index, count } = args.worker;
    for (const [position, path] of corpus.test262.entries()) {
      if (position % count === index) await measure(path, args.target, share, wrapped);
    }
    writeFileSync(args.workerOut!, JSON.stringify(share));
    return;
  }
  if (corpus.test262.length === 0) {
    process.stderr.write("ir-claim-ledger: the test262 stride is empty — refusing to write a vacuous ledger\n");
    process.exit(2);
  }
  const started = Date.now();
  const playground = emptyPopulation();
  // Workers start first; the playground compiles in this process meanwhile.
  const test262Pending = measureTest262(args, corpus.test262);
  for (const path of corpus.playground) await measure(path, args.target, playground);
  const { fileRows, ...test262 } = finish(await test262Pending);
  if (args.filesJson) writeFileSync(join(REPO_ROOT, args.filesJson), `${JSON.stringify(fileRows, null, 2)}\n`);
  const ledger = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    commit: gitHead(),
    target: args.target,
    mode: args.wrapped ? "wrapped" : "raw",
    corpus: {
      description:
        `all ${PLAYGROUND_ROOT} .ts files + every ${args.stride}th file of the sorted ${TEST262_ROOT} .js list ` +
        (args.wrapped
          ? "(_FIXTURE excluded; test262 files compiled as runTest262File does: assembleOriginalHarness primary " +
            "variant + originalHarnessCompileOptions, shouldSkip honoured for non-negative files; playground raw)"
          : "(_FIXTURE excluded, compiled raw without the harness)"),
      stride: args.stride,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      playgroundFiles: corpus.playground.length,
      test262Files: corpus.test262.length,
    },
    jobs: args.jobs,
    seconds: Math.round((Date.now() - started) / 1000),
    playground: finish(playground),
    test262,
  };
  writeFileSync(join(REPO_ROOT, args.out), `${JSON.stringify(ledger, null, 2)}\n`);
  const route = ledger.test262.byBodyRoute;
  process.stdout.write(
    `ir-claim-ledger (${args.target}, ${ledger.mode}, stride ${args.stride}): ${ledger.test262.files} test262 files, ` +
      `${ledger.test262.units} units — ir ${route.ir ?? 0}, both ${route.both ?? 0}, legacy ${route.legacy ?? 0}, ` +
      `neither ${route.neither ?? 0}; invariant ${ledger.test262.byOutcomeKind.invariant ?? 0}; ` +
      `no telemetry ${ledger.test262.noTelemetry} files` +
      (ledger.test262.byOrigin
        ? `; harness units ${ledger.test262.byOrigin.harness.units}, test units ${ledger.test262.byOrigin.test.units}` +
          `, skipped ${ledger.test262.skipped} files; zero-legacy ${ledger.test262.zeroLegacyFiles} files ` +
          JSON.stringify(ledger.test262.legacyUnitHistogram)
        : "") +
      `; ${ledger.seconds}s → ${args.out}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
