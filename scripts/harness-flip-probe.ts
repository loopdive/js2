/**
 * harness-flip-probe — measure whether a candidate fix actually FLIPS real
 * test262 tests, through the REAL assembled harness (#3668).
 *
 * Why this exists
 * ---------------
 * Every probe written against the detached-builtin defect family (#3667 and
 * relatives) was a bare `compile()` of a hand-written snippet. That is not the
 * path conformance is scored on, and it measurably disagrees with it: the same
 * 2x2 writer/reader grid returns different answers under `compile()` than under
 * `assembleOriginalHarness`. So "does this fix flip anything?" was unanswerable
 * and got argued instead of measured.
 *
 * This driver runs a LIST of test262 files through `runTest262File`, i.e.
 * `assembleOriginalHarness` with the upstream harness (propertyHelper.js et al.)
 * inlined verbatim — and records pass/fail per file.
 *
 * Method rules baked in (each of these has burned this project)
 * ------------------------------------------------------------
 *  1. POSITIVE CONTROL IS MANDATORY AND STRUCTURAL. Every run first executes an
 *     always-pass and an always-fail fixture. If the instrument does not report
 *     one of each, it ABORTS instead of emitting numbers. A detector that cannot
 *     report the opposite outcome cannot be trusted to report this one — and a
 *     "validation harness that reported exit 0 for cases that must fail" is a
 *     real failure from this codebase's history.
 *  2. LOCAL-VS-LOCAL A/B ONLY. `--diff` compares two runs of THIS tool. It
 *     refuses to be pointed at the committed CI baseline jsonl, because diffing
 *     a local sweep against a committed baseline manufactures phantom deltas
 *     (see reference_never_diff_local_sweep_against_committed_ci_baseline).
 *  3. THE PARTITION MUST SUM. `--diff` asserts
 *     pass->fail + fail->pass + unchanged + entered + left == the union of both
 *     runs, and prints every bucket. A complement is not a category.
 *  4. `skip` IS ITS OWN OUTCOME, never folded into pass or fail.
 *  5. Only STATUS is reported. `runTest262File`'s error *category* and *source
 *     location* are known artifacts (see
 *     reference_runtest262file_not_ci_path_status_only); this tool therefore
 *     never aggregates or classifies by them. Raw text is kept per-file for
 *     human reading only.
 *
 * Usage
 * -----
 *   # record an arm (run once per side of the A/B)
 *   npx tsx scripts/harness-flip-probe.ts --files list.txt --out before.jsonl
 *   #   ... apply the candidate fix, then ...
 *   npx tsx scripts/harness-flip-probe.ts --files list.txt --out after.jsonl
 *
 *   # compare the two arms
 *   npx tsx scripts/harness-flip-probe.ts --diff before.jsonl after.jsonl
 *
 *   # prove the instrument works, and nothing else
 *   npx tsx scripts/harness-flip-probe.ts --self-test
 *
 *   # is a reading stable? runs each file twice and reports disagreement
 *   npx tsx scripts/harness-flip-probe.ts --files list.txt --check-determinism
 *
 *   # measure the host-free lane with the same authentic harness
 *   npx tsx scripts/harness-flip-probe.ts --files list.txt --target standalone
 *
 * `--files` takes one test262 path per line, relative to `test262/` or
 * `test262/test/`; `#` comments and blank lines are ignored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { runTest262File } from "../tests/test262-runner.js";

const TEST262_ROOT = resolve("test262");
const CONTROL_DIR = resolve("scripts/fixtures/harness-flip-control");
const CONTROL_PASS = join(CONTROL_DIR, "control-must-pass.js");
const CONTROL_FAIL = join(CONTROL_DIR, "control-must-fail.js");

/** Outcome buckets. `skip` is deliberately NOT folded into pass or fail. */
type Status = "pass" | "fail" | "compile_error" | "compile_timeout" | "skip" | "error";
type Target = "host" | "standalone";

interface Row {
  file: string;
  status: Status;
  target?: Target;
  detail?: string;
}

const PASS_LIKE: ReadonlySet<Status> = new Set<Status>(["pass"]);
/** Everything a conformance run counts AGAINST us. `skip` is not in here. */
const FAIL_LIKE: ReadonlySet<Status> = new Set<Status>(["fail", "compile_error", "compile_timeout", "error"]);

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      "harness-flip-probe — flip measurement through the real assembled test262 harness",
      "",
      "  --files <path|->          file with one test262 path per line (`-` = stdin)",
      "  --paths a,b,c             inline comma-separated paths",
      "  --out <path.jsonl>        write results (default: stdout summary only)",
      "  --diff <a.jsonl> <b.jsonl>  compare two runs of THIS tool",
      "  --self-test               verify the instrument can report both outcomes",
      "  --check-determinism       run each file twice, report disagreement",
      "  --target host|standalone  compiler lane (default: host)",
      "  --timeout <ms>            per-file timeout (default 60000)",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

/** Resolve a corpus-relative path (accepts `test/foo.js` or `foo.js`). */
function resolveTestPath(p: string): string {
  if (isAbsolute(p)) return p;
  const direct = join(TEST262_ROOT, p);
  if (existsSync(direct)) return direct;
  const underTest = join(TEST262_ROOT, "test", p);
  if (existsSync(underTest)) return underTest;
  return direct; // let the runner report the miss
}

function categoryOf(rel: string): string {
  const parts = rel.replace(/^test\//, "").split("/");
  return parts[0] ?? "unknown";
}

async function runOne(absPath: string, timeoutMs: number, target: Target): Promise<Row> {
  const rel = absPath.startsWith(TEST262_ROOT) ? absPath.slice(TEST262_ROOT.length + 1) : absPath;
  try {
    const r = await runTest262File(absPath, categoryOf(rel), timeoutMs, target === "standalone" ? target : undefined);
    return {
      file: rel,
      status: r.status as Status,
      target,
      // Kept for humans only — never aggregated (see method rule 5).
      ...(r.reason ? { detail: String(r.reason) } : r.error ? { detail: String(r.error).slice(0, 400) } : {}),
    };
  } catch (e) {
    return { file: rel, status: "error", target, detail: (e as Error)?.message?.slice(0, 400) ?? "threw" };
  }
}

/**
 * METHOD RULE 1 — structural positive control.
 *
 * Runs a fixture that must pass and one that must fail. Returns only if BOTH
 * directions were observed. This is not decoration: an instrument stuck on one
 * verdict (always-fail, always-skip, silently-vacuous) looks exactly like a real
 * measurement in the output, and has previously been mistaken for one here.
 */
async function assertInstrumentWorks(timeoutMs: number, target: Target): Promise<void> {
  if (!existsSync(CONTROL_PASS) || !existsSync(CONTROL_FAIL)) {
    console.error(`FATAL: control fixtures missing under ${CONTROL_DIR}`);
    console.error("Refusing to report numbers without a positive control.");
    process.exit(3);
  }
  const good = await runOne(CONTROL_PASS, timeoutMs, target);
  const bad = await runOne(CONTROL_FAIL, timeoutMs, target);
  const ok = good.status === "pass" && FAIL_LIKE.has(bad.status);
  console.error(
    `control: must-pass -> ${good.status}${good.detail ? ` (${good.detail.slice(0, 120)})` : ""}\n` +
      `control: must-fail -> ${bad.status}${bad.detail ? ` (${bad.detail.slice(0, 120)})` : ""}`,
  );
  if (!ok) {
    console.error(
      "\nFATAL: the instrument did not demonstrate BOTH outcomes.\n" +
        "  A detector that cannot report the opposite result cannot be trusted\n" +
        "  to report this one. Aborting WITHOUT emitting a flip count.",
    );
    process.exit(3);
  }
  console.error("control: OK — instrument reports both directions.\n");
}

function readList(p: string): string[] {
  return readFileSync(p === "-" ? 0 : p, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function loadRows(p: string): Map<string, Row> {
  const raw = readFileSync(p, "utf-8");
  // METHOD RULE 2 — refuse the committed CI baseline as a diff arm.
  const firstLine = raw.split("\n", 1)[0] ?? "";
  if (firstLine.includes("oracle_lane") || firstLine.includes("oracle_version")) {
    console.error(
      `FATAL: ${p} looks like the committed CI baseline jsonl, not a run of this tool.\n` +
        "  Diffing a local sweep against a committed baseline manufactures phantom\n" +
        "  deltas. Record BOTH arms locally with --out and diff those.",
    );
    process.exit(3);
  }
  const m = new Map<string, Row>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as Row;
    m.set(o.file, o);
  }
  return m;
}

function summarise(rows: Row[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}

function doDiff(beforePath: string, afterPath: string): void {
  const before = loadRows(beforePath);
  const after = loadRows(afterPath);
  const targetOf = (rows: Map<string, Row>): Target | undefined => {
    const targets = new Set([...rows.values()].map((row) => row.target).filter((target) => target !== undefined));
    if (targets.size > 1) {
      console.error("FATAL: a diff arm mixes compiler targets. Refusing to report a flip count.");
      process.exit(3);
    }
    return targets.values().next().value;
  };
  const beforeTarget = targetOf(before);
  const afterTarget = targetOf(after);
  if (beforeTarget !== undefined && afterTarget !== undefined && beforeTarget !== afterTarget) {
    console.error(
      `FATAL: compiler targets differ (${beforeTarget} vs ${afterTarget}). ` +
        "Record both A/B arms with the same --target.",
    );
    process.exit(3);
  }

  const union = new Set<string>([...before.keys(), ...after.keys()]);
  const flipsToPass: string[] = [];
  const flipsToFail: string[] = [];
  const otherChange: string[] = [];
  const unchanged: string[] = [];
  const onlyBefore: string[] = [];
  const onlyAfter: string[] = [];

  for (const f of union) {
    const b = before.get(f);
    const a = after.get(f);
    if (!a) {
      onlyBefore.push(f);
      continue;
    }
    if (!b) {
      onlyAfter.push(f);
      continue;
    }
    if (a.status === b.status) {
      unchanged.push(f);
    } else if (FAIL_LIKE.has(b.status) && PASS_LIKE.has(a.status)) {
      flipsToPass.push(f);
    } else if (PASS_LIKE.has(b.status) && FAIL_LIKE.has(a.status)) {
      flipsToFail.push(f);
    } else {
      // e.g. fail->skip, compile_error->fail. Real changes, but NOT flips.
      otherChange.push(f);
    }
  }

  // METHOD RULE 3 — the partition must sum to the whole before any part is read.
  const parts =
    flipsToPass.length +
    flipsToFail.length +
    otherChange.length +
    unchanged.length +
    onlyBefore.length +
    onlyAfter.length;
  console.log(`before : ${beforePath}  (${before.size} files)  ${JSON.stringify(summarise([...before.values()]))}`);
  console.log(`after  : ${afterPath}  (${after.size} files)  ${JSON.stringify(summarise([...after.values()]))}`);
  console.log(`union  : ${union.size} files`);
  if (parts !== union.size) {
    console.error(`\nFATAL: partition does not sum (${parts} != ${union.size}). Refusing to report a flip count.`);
    process.exit(3);
  }
  console.log(`partition verified: ${parts} == ${union.size}\n`);

  console.log(`fail -> pass (GAINED) : ${flipsToPass.length}`);
  console.log(`pass -> fail (LOST)   : ${flipsToFail.length}`);
  console.log(`other status change   : ${otherChange.length}`);
  console.log(`unchanged             : ${unchanged.length}`);
  console.log(`only in before        : ${onlyBefore.length}`);
  console.log(`only in after         : ${onlyAfter.length}`);
  console.log(`NET (gained - lost)   : ${flipsToPass.length - flipsToFail.length}`);

  const show = (label: string, list: string[]) => {
    if (!list.length) return;
    console.log(`\n--- ${label} (${list.length}) ---`);
    for (const f of list.slice(0, 60)) console.log(`  ${f}`);
    if (list.length > 60) console.log(`  ... ${list.length - 60} more`);
  };
  show("fail -> pass", flipsToPass);
  show("pass -> fail", flipsToFail);
  show("other status change", otherChange);

  if (flipsToPass.length === 0 && flipsToFail.length === 0) {
    console.log(
      "\nZERO measured flips. That is a RESULT, not a failure of the run —\n" +
        "report it as such rather than reaching for a different filter.",
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();

  let filesArg: string | undefined;
  let pathsArg: string | undefined;
  let outArg: string | undefined;
  let timeoutMs = 60000;
  let target: Target = "host";
  let selfTest = false;
  let checkDeterminism = false;
  const diffArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--files") filesArg = argv[++i];
    else if (a === "--paths") pathsArg = argv[++i];
    else if (a === "--out") outArg = argv[++i];
    else if (a === "--timeout") timeoutMs = Number(argv[++i]);
    else if (a === "--target") {
      const value = argv[++i];
      if (value !== "host" && value !== "standalone") usage(`invalid target ${value}`);
      target = value;
    } else if (a === "--self-test") selfTest = true;
    else if (a === "--check-determinism") checkDeterminism = true;
    else if (a === "--diff") {
      diffArgs.push(argv[++i]!, argv[++i]!);
    } else usage(`unknown argument ${a}`);
  }

  if (diffArgs.length === 2) {
    doDiff(diffArgs[0]!, diffArgs[1]!);
    return;
  }

  // The control runs before ANY measurement, in every mode.
  await assertInstrumentWorks(timeoutMs, target);
  if (selfTest) {
    console.log("self-test OK: instrument reports both pass and fail.");
    return;
  }

  const list = filesArg
    ? readList(filesArg)
    : pathsArg
      ? pathsArg.split(",").map((s) => s.trim())
      : usage("need --files or --paths");
  console.error(`running ${list.length} file(s) through the assembled harness...`);

  const rows: Row[] = [];
  let nondeterministic = 0;
  for (let i = 0; i < list.length; i++) {
    const abs = resolveTestPath(list[i]!);
    const row = await runOne(abs, timeoutMs, target);
    if (checkDeterminism) {
      const again = await runOne(abs, timeoutMs, target);
      if (again.status !== row.status) {
        nondeterministic++;
        console.error(`  NONDETERMINISTIC ${row.file}: ${row.status} then ${again.status}`);
      }
    }
    rows.push(row);
    if ((i + 1) % 25 === 0) console.error(`  ${i + 1}/${list.length}`);
  }

  const counts = summarise(rows);
  const summed = Object.values(counts).reduce((a, b) => a + b, 0);
  if (summed !== rows.length) {
    console.error(`FATAL: status counts (${summed}) do not sum to rows (${rows.length}).`);
    process.exit(3);
  }
  console.log(JSON.stringify(counts));
  console.log(`total: ${rows.length} (counts verified to sum)`);
  if (checkDeterminism) {
    console.log(`nondeterministic: ${nondeterministic}`);
    if (nondeterministic > 0) {
      console.log("WARNING: unstable readings above — any flip count over this list is unreliable.");
    }
  }

  if (outArg) {
    mkdirSync(dirname(resolve(outArg)), { recursive: true });
    writeFileSync(resolve(outArg), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    console.error(`wrote ${rows.length} rows to ${outArg}`);
  }
}

await main();
