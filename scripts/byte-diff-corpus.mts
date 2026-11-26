// Byte-identity corpus diff between two compiler trees (#2138; regexp corpus #7369).
// Usage:
//   INPUT_ROOT=<dir> npx tsx scripts/byte-diff-corpus.mts <compilerRoot> <outFile> \
//       [--corpus sample|regexp] [--jobs N] [--cache <dir>]
//   INPUT_ROOT=<dir> npx tsx scripts/byte-diff-corpus.mts --compare <base.jsonl> <head.jsonl> \
//       <baseRoot> <headRoot> [--corpus sample|regexp]
// Compiles a fixed corpus with the compiler at <compilerRoot> and writes JSONL of
// {file, mode, status, sha, errors}; run it once per tree (baseline upstream/main,
// then the branch) and `--compare` the two files. `status` is `ok`, `ce`, `throw`
// or `crash:<code|signal>`; `errors` holds every message of a failed compile in
// full, so two failures are equal only when all their messages are.
//
// Exit codes of `--compare`: 0 IDENTICAL; 1 FAILED, some row differs;
// 2 INCONCLUSIVE, no row differs but some crashed or are order-dependent.
// Every mode exits 2 on a usage error or a missing INPUT_ROOT.
//
// Corpora:
//   sample (default)  example files on default + wasi, and a deterministic
//                     test262 sample (every STRIDE-th file) on default.
//   regexp (#7369)    every test262 file whose TS AST holds a
//                     RegularExpressionLiteral or an identifier `RegExp`, on
//                     default, standalone and wasi: the targets that emit the
//                     WasmGC RegExp engine (linear never does).
//
// Memory: compiles run in child processes with a WORKER_HEAP_MB heap, recycled
// every CHUNK_SIZE compiles. A process that dies is restarted on the compiles it
// had not finished, the one it died on first and alone, so heap built up by
// earlier compiles is not charged to it. A compile that kills a fresh process
// alone gets the status `crash:<code|signal>`, which `--compare` reports apart
// from both identical and differing rows.
//
// Order: both trees compile the same sorted corpus in the same chunks, but a
// compile can still depend on what its process compiled before it (#7410:
// TypeScript's process-global symbol ids reach emitted names), and a change
// that compiles one file differently shifts that state for the files after it.
// `--compare` therefore recompiles every differing row alone, in a fresh
// process per tree, and counts it as a difference only if it still differs.
// One that agrees alone is listed as order-dependent and makes the verdict
// INCONCLUSIVE: the chunked runs that should agree did not, so they prove
// nothing about that row.
//
// Cache: `--cache <dir>` stores each run's output under a hash of this script,
// the compiler tree's src/, the corpus and every input file, and replays it on
// a hit, so a head-only change recompiles only the head tree. It caches whole
// runs, not rows, because a row's bytes can depend on its chunk (#7410); a run
// with a crash row is not cached, so a rerun retries it. A change outside src/
// (a dependency bump) is not in the key: use a fresh cache dir.
//
// Env: INPUT_ROOT (required), the tree the inputs are read from; it must hold
// test262/test. It is not derived from <compilerRoot> because both runs must
// read the same sources, and `--compare` has two roots. STRIDE (default 20).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const USAGE =
  "usage: INPUT_ROOT=<dir> byte-diff-corpus.mts <compilerRoot> <outFile> [--corpus sample|regexp] [--jobs N] [--cache <dir>]\n" +
  "       INPUT_ROOT=<dir> byte-diff-corpus.mts --compare <base.jsonl> <head.jsonl> <baseRoot> <headRoot> [--corpus sample|regexp]";

/** The input tree named by INPUT_ROOT; exits 2 unless it holds test262/test. */
function inputRoot(): string {
  const root = process.env.INPUT_ROOT;
  if (root && existsSync(join(root, "test262/test"))) return resolve(root);
  console.error(`INPUT_ROOT must name a tree holding test262/test; got ${JSON.stringify(root ?? null)}\n${USAGE}`);
  process.exit(2);
}

const INPUT_ROOT = inputRoot();
const STRIDE = Number(process.env.STRIDE ?? 20);
const CHUNK_SIZE = 300;
const WORKER_HEAP_MB = 3072;

/** One compile: an input file under one mode (a set of compile options). */
interface Job {
  file: string;
  mode: string;
  opts: Record<string, unknown>;
}
interface Row {
  file: string;
  mode: string;
  status: string;
  sha: string | null;
  errors: string[];
}

const AS_TS = { fileName: "test.ts" };
const AS_JS = { allowJs: true, fileName: "t.js", skipSemanticDiagnostics: true };
/** The compile options of each mode, per corpus. */
const MODES: Record<string, Record<string, Record<string, unknown>>> = {
  sample: { default: AS_TS, wasi: { ...AS_TS, target: "wasi" } },
  regexp: {
    default: AS_JS,
    standalone: { ...AS_JS, target: "standalone" },
    wasi: { ...AS_JS, target: "wasi" },
  },
};

const rel = (file: string) => file.replace(INPUT_ROOT, "");
const keyOf = (row: { file: string; mode: string }) => `${row.mode}\t${rel(row.file)}`;
const jobOf = (corpus: string, file: string, mode: string): Job => ({ file, mode, opts: MODES[corpus]![mode]! });

function walk(root: string, ext: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      const s = lstatSync(p);
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) stack.push(p);
      else if (name.endsWith(ext) && !name.endsWith(".d.ts") && !name.includes("_FIXTURE")) out.push(p);
    }
  }
  return out.sort();
}

function sampleCorpus(): Job[] {
  const examples = [
    ...walk(join(INPUT_ROOT, "website/playground/examples"), ".ts"),
    ...walk(join(INPUT_ROOT, "examples"), ".ts"),
  ];
  const t262 = walk(join(INPUT_ROOT, "test262/test"), ".js").filter((_, i) => i % STRIDE === 0);
  return [
    ...examples.flatMap((file) => [jobOf("sample", file, "default"), jobOf("sample", file, "wasi")]),
    ...t262.map((file) => jobOf("sample", file, "default")),
  ];
}

function regexpCorpus(): Job[] {
  const mentionsRegExp = (node: ts.Node): boolean =>
    node.kind === ts.SyntaxKind.RegularExpressionLiteral ||
    (ts.isIdentifier(node) && node.text === "RegExp") ||
    ts.forEachChild(node, mentionsRegExp) === true;
  return walk(join(INPUT_ROOT, "test262/test"), ".js")
    .filter((file) =>
      mentionsRegExp(
        ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS),
      ),
    )
    .flatMap((file) => Object.keys(MODES.regexp!).map((mode) => jobOf("regexp", file, mode)));
}

const CORPORA: Record<string, () => Job[]> = { sample: sampleCorpus, regexp: regexpCorpus };

// ── Worker: run one chunk of jobs; each row is appended as soon as its compile
// finishes, so a process that dies leaves exactly the jobs it finished. ──

async function runWorker(compilerRoot: string, chunkPath: string, outPath: string) {
  const { compile } = await import(pathToFileURL(join(compilerRoot, "src/index.ts")).href);
  for (const { file, mode, opts } of JSON.parse(readFileSync(chunkPath, "utf-8")) as Job[]) {
    let status: string;
    let sha: string | null = null;
    let errors: string[] = [];
    try {
      const r = await compile(readFileSync(file, "utf-8"), opts);
      if (r.success && r.binary) {
        status = "ok";
        sha = createHash("sha256").update(r.binary).digest("hex");
      } else {
        status = "ce";
        errors = (r.errors ?? []).map((e: { message: string }) => e.message);
      }
    } catch (e) {
      status = "throw";
      errors = [String(e instanceof Error ? e.message : e)];
    }
    // A message may quote a path inside the compiler tree; that is not a difference.
    errors = errors.map((message) => message.split(compilerRoot).join("<root>"));
    appendFileSync(outPath, JSON.stringify({ file: rel(file), mode, status, sha, errors }) + "\n");
  }
}

// ── Parent: chunking, recycling, crash outcomes ──

function readRows(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Row);
}

/** Resolves to how the process ended: `0`, another exit code, or the signal name. */
function runProcess(compilerRoot: string, jobs: Job[], chunkPath: string, outPath: string) {
  writeFileSync(chunkPath, JSON.stringify(jobs));
  const self = fileURLToPath(import.meta.url);
  const args = [`--max-old-space-size=${WORKER_HEAP_MB}`, "--import", "tsx", self, "--worker"];
  return new Promise<number | string>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [...args, compilerRoot, chunkPath, outPath], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => resolveRun(code ?? signal ?? "unknown"));
  });
}

async function runChunk(compilerRoot: string, jobs: Job[], chunkPath: string, outPath: string) {
  let remaining = jobs;
  let alone = false;
  while (remaining.length > 0) {
    const first = remaining[0]!;
    const ended = await runProcess(compilerRoot, alone ? [first] : remaining, chunkPath, outPath);
    const finished = new Set(readRows(outPath).map(keyOf));
    remaining = remaining.filter((job) => !finished.has(keyOf(job)));
    if (ended !== 0 && alone && remaining[0] === first) {
      remaining.shift();
      const row = { file: rel(first.file), mode: first.mode, status: `crash:${ended}`, sha: null, errors: [] };
      appendFileSync(outPath, JSON.stringify(row) + "\n");
    }
    alone = ended !== 0 && !alone;
  }
}

/** Keys a run for `--cache`: this script, the compiler tree's src/, the corpus and every input. */
function runKey(compilerRoot: string, corpus: string, jobs: Job[]): string {
  const hash = createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .update(`\0${corpus}`);
  const src = join(compilerRoot, "src");
  for (const name of readdirSync(src, { recursive: true, encoding: "utf-8" }).sort())
    if (lstatSync(join(src, name)).isFile()) hash.update(`\0${name}\0`).update(readFileSync(join(src, name)));
  for (const job of jobs) hash.update(`\0${keyOf(job)}\0`).update(readFileSync(job.file));
  return hash.digest("hex");
}

async function run(compilerRoot: string, outFile: string, corpus: string, lanes: number, cacheDir?: string) {
  const jobs = CORPORA[corpus]!();
  const cached = cacheDir && join(cacheDir, `${runKey(compilerRoot, corpus, jobs)}.jsonl`);
  if (cached && existsSync(cached)) {
    copyFileSync(cached, outFile);
    process.stderr.write(`${corpus}: ${jobs.length} compiles replayed from ${cached} → ${outFile}\n`);
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), "byte-diff-corpus-"));
  const chunks: string[] = [];
  for (let start = 0; start < jobs.length; start += CHUNK_SIZE) chunks.push(join(scratch, `${chunks.length}`));
  process.stderr.write(`${corpus}: ${jobs.length} compiles in ${chunks.length} chunks\n`);
  let next = 0;
  let done = 0;
  const lane = async () => {
    while (next < chunks.length) {
      const i = next++;
      const chunk = jobs.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      await runChunk(compilerRoot, chunk, `${chunks[i]}.json`, `${chunks[i]}.jsonl`);
      process.stderr.write(`  ${++done}/${chunks.length} chunks\n`);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  const rows = chunks.flatMap((chunk) => readRows(`${chunk}.jsonl`));
  writeFileSync(outFile, rows.map((row) => JSON.stringify(row) + "\n").join(""));
  rmSync(scratch, { recursive: true, force: true });
  if (cached && !rows.some((row) => row.status.startsWith("crash:"))) {
    mkdirSync(dirname(cached), { recursive: true });
    copyFileSync(outFile, cached);
  }
  process.stderr.write(`done: ${jobs.length} compiles → ${outFile}\n`);
}

/** Compiles one job alone in a fresh process (with the usual crash handling). */
async function compileAlone(compilerRoot: string, job: Job, scratch: string): Promise<Row> {
  const out = join(
    scratch,
    createHash("sha1")
      .update(`${compilerRoot}\t${keyOf(job)}`)
      .digest("hex"),
  );
  await runChunk(compilerRoot, [job], `${out}.json`, `${out}.jsonl`);
  return readRows(`${out}.jsonl`)[0]!;
}

// ── Compare: a row is identical only when both trees emit the same binary.
// A row that fails on both trees proves nothing about bytes, so it is counted
// apart (and still differs when the failure itself changed); a crash on
// either side is not comparable at all. ──

const sameOutput = (a: Row, b: Row | undefined) =>
  b !== undefined && a.status === b.status && a.sha === b.sha && JSON.stringify(a.errors) === JSON.stringify(b.errors);
const show = (row: Row | undefined) => (row ? `${row.status} ${row.sha ?? JSON.stringify(row.errors)}` : "missing");

interface Trees {
  corpus: string;
  baseRoot: string;
  headRoot: string;
}

async function compare(baseFile: string, headFile: string, trees: Trees): Promise<number> {
  const head = new Map(readRows(headFile).map((row) => [keyOf(row), row]));
  const unseen = new Set(head.keys());
  const perMode = new Map<string, { compiled: number; failed: number; bothFailed: number; differ: number }>();
  const crashes: string[] = [];
  const orderDependent: string[] = [];
  const scratch = mkdtempSync(join(tmpdir(), "byte-diff-recheck-"));
  let identical = 0;
  let differ = 0;
  for (const base of readRows(baseFile)) {
    const after = head.get(keyOf(base));
    unseen.delete(keyOf(base));
    let counts = perMode.get(base.mode);
    if (!counts) perMode.set(base.mode, (counts = { compiled: 0, failed: 0, bothFailed: 0, differ: 0 }));
    if (base.status.startsWith("crash:") || after?.status.startsWith("crash:")) {
      crashes.push(`CRASH [${base.mode}] ${base.file}\n  base: ${base.status}\n  head: ${after?.status}`);
      continue;
    }
    if (base.status === "ok") counts.compiled++;
    else counts.failed++;
    if (base.status !== "ok" && after !== undefined && after.status !== "ok") counts.bothFailed++;
    if (sameOutput(base, after)) {
      if (base.status === "ok") identical++;
      continue;
    }
    let detail = `\n  base: ${show(base)}\n  head: ${show(after)}`;
    if (after) {
      const job = jobOf(trees.corpus, join(INPUT_ROOT, base.file), base.mode);
      const baseAlone = await compileAlone(trees.baseRoot, job, scratch);
      const headAlone = await compileAlone(trees.headRoot, job, scratch);
      if (sameOutput(baseAlone, headAlone)) {
        orderDependent.push(`ORDER-DEPENDENT [${base.mode}] ${base.file}${detail}\n  alone: ${show(baseAlone)}`);
        continue;
      }
      detail += `\n  alone: base ${show(baseAlone)}, head ${show(headAlone)}`;
    }
    counts.differ++;
    differ++;
    console.log(`DIFF [${base.mode}] ${base.file}${detail}`);
  }
  rmSync(scratch, { recursive: true, force: true });
  for (const key of unseen) console.log(`DIFF [${key.replace("\t", "] ")} only in head`);
  differ += unseen.size;
  for (const line of [...crashes, ...orderDependent]) console.log(line);
  for (const [mode, c] of perMode)
    console.log(
      `  ${mode}: ${c.compiled} compiled + ${c.failed} failed on base, ${c.bothFailed} failed on both, ${c.differ} differ on head`,
    );
  const tail = `${identical} identical binaries, ${crashes.length} crash rows, ${orderDependent.length} order-dependent rows`;
  const inconclusive = crashes.length + orderDependent.length;
  const verdict = differ > 0 ? "FAILED" : inconclusive > 0 ? "INCONCLUSIVE" : "IDENTICAL";
  console.log(`${verdict} — ${differ} rows differ; ${tail}`);
  return differ > 0 ? 1 : inconclusive > 0 ? 2 : 0;
}

const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const corpus = flag("--corpus") ?? "sample";
const lanes = Number(flag("--jobs") ?? 1);
const positional = argv.filter((arg, i) => !arg.startsWith("--") && !argv[i - 1]?.match(/^--(corpus|jobs|cache)$/));
if (argv[0] === "--worker") {
  await runWorker(argv[1]!, argv[2]!, argv[3]!);
} else if (
  !CORPORA[corpus] ||
  !Number.isInteger(lanes) ||
  lanes < 1 ||
  positional.length !== (argv[0] === "--compare" ? 4 : 2)
) {
  console.error(USAGE);
  process.exit(2);
} else if (argv[0] === "--compare") {
  const [baseFile, headFile, baseRoot, headRoot] = positional as [string, string, string, string];
  process.exit(await compare(baseFile, headFile, { corpus, baseRoot, headRoot }));
} else {
  await run(positional[0]!, positional[1]!, corpus, lanes, flag("--cache"));
}
