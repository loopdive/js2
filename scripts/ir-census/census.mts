// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * ES5 IR-only census: one JSONL row per test262 file naming its legacy units.
 *
 *   JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1 \
 *   npx tsx scripts/ir-census/census.mts --files .tmp/ir-census/es5-files.txt \
 *     --out .tmp/ir-census/rows.jsonl [--jobs N] [--run all|ir-only] [--tree <dir>] [--timeout-s 180]
 *
 * - Compile: `--target standalone`, the original harness
 *   (`assembleOriginalHarness(...).primary`) and the runner's own
 *   `originalHarnessCompileOptions`, plus `trackIrOutcomes: true`.
 * - Skipped, not compiled: negative tests, `raw` and `module` flags, and
 *   whatever the runner's `shouldSkip` rejects.
 * - A unit is legacy when no IR body was emitted (the worker's
 *   `summarizeIrRoute` rule); a file is IR-only when it compiled and has none.
 *   A legacy unit whose outcome stage is past `select` is a post-claim error.
 * - Each legacy function unit is attributed to the harness part its line falls
 *   in (`harness:assert.js`) or to `test`; `<module-init>` is always `test`.
 * - `--run all` adds `standalone`: the verdict of the runner's `runTest262File`
 *   (its own compile, strict rerun included) for every file that compiled;
 *   `--run ir-only` only for the IR-only files (the ones `ir_only_pass` can
 *   count), which roughly halves the run time.
 * - `--tree <dir>` measures another checkout (e.g. a `git archive` export of an
 *   older main with `node_modules` and `test262` linked in): the compiler,
 *   runner and harness are imported from there.
 *
 * Resumable: files already in `--out` are not measured again. Files run in
 * `--jobs` child processes, one file at a time each; a file that exceeds
 * `--timeout-s` is recorded as `timeout` and its child is replaced.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF), "../..");
const DETAIL_CAP = 6000;
const RECYCLE_AFTER = 250;

type RunMode = "none" | "all" | "ir-only";
const RUN_MODES: readonly RunMode[] = ["none", "all", "ir-only"];

function runMode(raw: string | undefined): RunMode {
  const mode = (raw ?? "none") as RunMode;
  if (!RUN_MODES.includes(mode)) throw new Error(`--run must be one of ${RUN_MODES.join(", ")}, got ${raw}`);
  return mode;
}

interface Args {
  readonly files: string;
  readonly out: string;
  readonly jobs: number;
  readonly run: RunMode;
  readonly tree: string;
  readonly timeoutMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const files = value("--files");
  const out = value("--out");
  if (!files || !out) throw new Error("usage: census.mts --files <list> --out <jsonl> [--jobs N] [--run all|ir-only] [--tree <dir>]");
  return {
    files: resolve(files),
    out: resolve(out),
    jobs: Number(value("--jobs") ?? availableParallelism()),
    run: runMode(value("--run")),
    tree: resolve(value("--tree") ?? REPO_ROOT),
    timeoutMs: Number(value("--timeout-s") ?? 180) * 1000,
  };
}

// ---------------------------------------------------------------- child side

type Runner = typeof import("../../tests/test262-runner.ts");
type Harness = typeof import("../../tests/test262-original-harness.ts");
type Compiler = typeof import("../../src/index.ts");
type Outcome = NonNullable<Awaited<ReturnType<Compiler["compile"]>>["irOutcomes"]>[number];

interface Toolchain {
  readonly tree: string;
  readonly compiler: Compiler;
  readonly runner: Runner;
  readonly harness: Harness;
}

async function loadToolchain(tree: string): Promise<Toolchain> {
  const load = (path: string) => import(pathToFileURL(join(tree, path)).href);
  const [compiler, runner, harness] = await Promise.all([
    load("src/index.ts"),
    load("tests/test262-runner.ts"),
    load("tests/test262-original-harness.ts"),
  ]);
  return { tree, compiler, runner, harness };
}

const newlines = (text: string): number => text.split("\n").length - 1;

/** `[firstLine, name]` per harness part, ascending, 1-based lines of the assembled source. */
function harnessPartStarts(
  harness: Harness,
  meta: ReturnType<Runner["parseMeta"]>,
  strict: boolean,
): [number, string][] {
  const starts: [number, string][] = [];
  let line = 1 + (strict ? 1 : 0);
  for (const part of harness.harnessSourceParts(meta, meta.flags?.includes("async") === true)) {
    starts.push([line, part.name]);
    line += newlines(part.source);
  }
  return starts;
}

function unitOrigin(outcome: Outcome, starts: [number, string][], bodyLine: number): string {
  if (outcome.unitKind === "module-init" || outcome.line > bodyLine) return "test";
  let name = "prefix";
  for (const [first, part] of starts) if (outcome.line >= first) name = part;
  return `harness:${name}`;
}

function legacyUnit(outcome: Outcome, origin: string) {
  const failure = outcome as Outcome & { code?: string; detail?: string };
  return {
    name: outcome.displayName,
    kind: outcome.unitKind,
    origin,
    stage: outcome.stage,
    code: failure.code,
    detail: failure.detail?.slice(0, DETAIL_CAP),
    ...(outcome.moduleBindingRefusals?.length ? { moduleBindingRefusals: outcome.moduleBindingRefusals } : {}),
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function measureFile(tools: Toolchain, file: string, run: RunMode): Promise<object> {
  const { compiler, runner, harness } = tools;
  const abs = join(tools.tree, "test262/test", file);
  const source = readFileSync(abs, "utf8");
  const meta = runner.parseMeta(source);
  const flags = meta.flags ?? [];
  if (meta.negative) return { file, status: "skip", skipReason: "negative" };
  if (flags.includes("raw") || flags.includes("module")) {
    return { file, status: "skip", skipReason: flags.includes("raw") ? "raw" : "module" };
  }
  const filter = runner.shouldSkip(source, meta, abs);
  if (filter.skip) return { file, status: "skip", skipReason: filter.reason };

  const variant = harness.assembleOriginalHarness(source, meta).primary;
  const options = { ...runner.originalHarnessCompileOptions(meta, "standalone"), fileName: abs, trackIrOutcomes: true };
  let result: Awaited<ReturnType<Compiler["compile"]>>;
  try {
    result = await compiler.compile(variant.source, options);
  } catch (error) {
    return { file, status: "threw", error: errorText(error) };
  }
  if (!result.success) {
    return { file, status: "compile_error", error: result.errors.map((e) => e.message).join("; ").slice(0, 300) };
  }
  const starts = harnessPartStarts(harness, meta, variant.strict);
  const executable = (result.irOutcomes ?? []).filter((outcome) => outcome.kind !== "non-executable");
  const legacy = executable
    .filter((outcome) => !outcome.irBodyEmitted)
    .map((outcome) => legacyUnit(outcome, unitOrigin(outcome, starts, variant.bodyLineOffset)));
  const row = {
    file,
    status: "compiled",
    units: executable.length,
    irOnly: legacy.length === 0,
    postClaim: legacy.filter((unit) => unit.stage !== "select").length,
    legacy,
  };
  if (run === "none" || (run === "ir-only" && !row.irOnly)) return row;
  const verdict = await runner.runTest262File(abs, file.split("/")[0]!, undefined, "standalone");
  return { ...row, standalone: { status: verdict.status, ...(verdict.error ? { error: errorText(verdict.error) } : {}) } };
}

async function childMain(tree: string, run: RunMode): Promise<void> {
  const tools = await loadToolchain(tree);
  const sink = (row: object) => appendFileSync(3, `${JSON.stringify(row)}\n`);
  for await (const file of createInterface({ input: process.stdin })) {
    if (!file) continue;
    try {
      sink(await measureFile(tools, file, run));
    } catch (error) {
      sink({ file, status: "threw", error: errorText(error) });
    }
  }
}

// --------------------------------------------------------------- parent side

function doneFiles(out: string): Set<string> {
  if (!existsSync(out)) return new Set();
  const done = new Set<string>();
  for (const line of readFileSync(out, "utf8").split("\n")) {
    if (line.trim()) done.add((JSON.parse(line) as { file: string }).file);
  }
  return done;
}

async function parentMain(args: Args): Promise<void> {
  const all = readFileSync(args.files, "utf8").split("\n").filter(Boolean);
  const done = doneFiles(args.out);
  const queue = all.filter((file) => !done.has(file));
  mkdirSync(dirname(args.out), { recursive: true });
  const log = openSync(`${args.out}.log`, "a");
  const total = queue.length;
  let finished = 0;
  const started = Date.now();
  console.error(`census: ${done.size} done, ${total} to go, ${args.jobs} jobs, tree ${args.tree}`);

  const record = (row: object): void => {
    appendFileSync(args.out, `${JSON.stringify(row)}\n`);
    finished += 1;
    if (finished % 100 === 0 || finished === total) {
      const rate = finished / ((Date.now() - started) / 1000);
      console.error(`census: ${finished}/${total}, ${rate.toFixed(2)} files/s, eta ${Math.round((total - finished) / rate / 60)} min`);
    }
  };

  const lane = async (): Promise<void> => {
    let child: ChildProcess | undefined;
    let rows: AsyncIterator<string> | undefined;
    let served = 0;
    const stop = () => {
      child?.kill("SIGKILL");
      child = undefined;
    };
    while (queue.length > 0) {
      if (!child || served >= RECYCLE_AFTER) {
        stop();
        child = spawn(process.execPath, [...process.execArgv, SELF, "--child", args.tree, args.run], {
          cwd: REPO_ROOT,
          stdio: ["pipe", "ignore", log, "pipe"],
        });
        rows = createInterface({ input: child.stdio[3] as Readable })[Symbol.asyncIterator]();
        served = 0;
      }
      const file = queue.shift()!;
      child.stdin!.write(`${file}\n`);
      served += 1;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), args.timeoutMs);
      });
      const next = await Promise.race([rows!.next(), timeout]);
      clearTimeout(timer);
      if (next === "timeout" || next.done) {
        record({ file, status: next === "timeout" ? "timeout" : "threw", error: next === "timeout" ? "census timeout" : "child exited" });
        stop();
        continue;
      }
      record(JSON.parse(next.value) as object);
    }
    stop();
  };
  await Promise.all(Array.from({ length: Math.max(1, args.jobs) }, lane));
}

const argv = process.argv.slice(2);
if (argv[0] === "--child") await childMain(argv[1]!, runMode(argv[2]));
else await parentMain(parseArgs(argv));
